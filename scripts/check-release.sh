#!/bin/bash
# Checks that the newest code on main has been released. If it has not, and no release run is still
# working on it, opens an issue (GitHub emails the owner); once a release catches up, closes it.
# If the repository has Issues turned off, it fails the run with the same report instead, so GitHub's
# failed-workflow email is the alert; the run turns green again once a release catches up.
# Needs GH_TOKEN and GITHUB_REPOSITORY, the way GitHub Actions provides them.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?}"
TITLE="Release pendiente: main tiene cambios sin publicar"
GRACE_MINUTES="${GRACE_MINUTES:-20}"

MAIN="$(gh api "repos/$REPO/commits/main" --jq .sha)"
MAIN_DATE="$(gh api "repos/$REPO/commits/$MAIN" --jq .commit.committer.date)"
TAG="$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || true)"
HAS_ISSUES="$(gh api "repos/$REPO" --jq .has_issues)"
ISSUE=""
if [ "$HAS_ISSUES" = true ]; then
  ISSUE="$(gh api "repos/$REPO/issues?state=open&per_page=100" \
    --jq "[.[] | select(.pull_request == null and .title == \"$TITLE\")][0].number // empty")"
fi
RUNS="repos/$REPO/actions/workflows/release.yml/runs"

unreleased=""
if [ -z "$TAG" ]; then
  unreleased="(no release yet)"
elif [ "$(gh api "repos/$REPO/commits/$TAG" --jq .sha)" != "$MAIN" ]; then
  # Same paths the Release workflow ignores: changes only to them never trigger a release.
  unreleased="$(gh api "repos/$REPO/compare/$TAG...$MAIN" --jq '.files[].filename' | grep -vE '\.md$|^LICENSE$|^\.gitignore$' || true)"
fi

if [ -z "$unreleased" ]; then
  echo "main ($MAIN) is released as $TAG."
  if [ -n "$ISSUE" ]; then
    gh api "repos/$REPO/issues/$ISSUE/comments" -f body="Ya está publicado: $TAG incluye main (\`${MAIN:0:7}\`)." > /dev/null
    gh api -X PATCH "repos/$REPO/issues/$ISSUE" -f state=closed -f state_reason=completed > /dev/null
    echo "Closed issue #$ISSUE."
  fi
  exit 0
fi

ACTIVE="$(gh api "$RUNS?per_page=20" --jq '[.workflow_runs[] | select(.status != "completed")] | length')"
if [ "$ACTIVE" -gt 0 ]; then
  echo "main has unreleased changes, but a release run is still going. Nothing to report yet."
  exit 0
fi

AGE_MINUTES=$(( ($(date -u +%s) - $(date -u -d "$MAIN_DATE" +%s)) / 60 ))
if [ "$AGE_MINUTES" -lt "$GRACE_MINUTES" ]; then
  echo "main changed $AGE_MINUTES min ago; giving the release time to start."
  exit 0
fi

LAST_RUN="$(gh api "$RUNS?branch=main&per_page=1" \
  --jq '.workflow_runs[0] | "\(.conclusion) en `\(.head_sha[0:7])`: \(.html_url)"' 2>/dev/null || echo "no hay corridas")"
COMMITS="$(gh api "repos/$REPO/compare/${TAG:-$MAIN}...$MAIN" --jq '.commits[] | "- `\(.sha[0:7])` \(.commit.message | split("\n")[0])"' 2>/dev/null || true)"

CLOSE_NOTE="Este issue se cierra solo cuando una release incluya \`main\`."
[ "$HAS_ISSUES" = true ] || CLOSE_NOTE="Esta revisión vuelve a pasar sola cuando una release incluya \`main\`."

BODY="$(cat <<MD
\`main\` (\`${MAIN:0:7}\`) tiene cambios que no están en ninguna release, y no hay ninguna corrida de **Release** en curso.

- Última release: ${TAG:-ninguna}
- Última corrida de Release: $LAST_RUN

Commits sin publicar:
${COMMITS:-(sin detalle)}

**Cómo arreglarlo:** abre la última corrida de Release y dale **Re-run all jobs**, o en Actions → Release → **Run workflow** con \`dry_run\` **desmarcado**.

$CLOSE_NOTE
MD
)"

if [ "$HAS_ISSUES" != true ]; then
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '## %s\n\n%s\n' "$TITLE" "$BODY" >> "$GITHUB_STEP_SUMMARY"
  fi
  printf '%s\n' "$BODY"
  echo "::error::main has unreleased changes and the last Release run did not publish them. Issues are off in this repository, so this run fails instead of opening an issue."
  exit 1
elif [ -n "$ISSUE" ]; then
  gh api -X PATCH "repos/$REPO/issues/$ISSUE" -f body="$BODY" > /dev/null
  echo "::warning::main has unreleased changes; updated issue #$ISSUE."
else
  gh api "repos/$REPO/issues" -f title="$TITLE" -f body="$BODY" --jq .html_url
  echo "::warning::main has unreleased changes; opened an issue."
fi
