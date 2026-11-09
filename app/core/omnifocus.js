// Brings a whole OmniFocus database into SMCP's task list once, so OmniFocus can be left behind.
// It reads OmniFocus through AppleScript for JavaScript, which needs OmniFocus Pro; the store's
// importOmniFocus is keyed by OmniFocus id, so running it again updates instead of duplicating.
import { run } from "../../src/util.js";

const IMPORT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs inside osascript. Every property read is wrapped, because one odd item (a task in a deleted
 * project, a field an older OmniFocus lacks) must not stop the whole import.
 */
export const OMNIFOCUS_SCRIPT = String.raw`
function run() {
  const of = Application("OmniFocus");
  if (!of.running()) throw new Error("OMNIFOCUS_CLOSED");
  const doc = of.defaultDocument;
  const get = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };
  const iso = (d) => (d ? new Date(d).toISOString() : null);

  const projects = doc.flattenedProjects().map((p) => ({
    id: get(() => p.id()),
    name: get(() => p.name(), ""),
    folder: get(() => p.folder().name()) || get(() => p.container().name()),
    status: get(() => String(p.status()), ""),
    reviewInterval: get(() => p.reviewInterval()),
    nextReview: iso(get(() => p.nextReviewDate())),
    lastReviewed: iso(get(() => p.lastReviewDate())),
  }));

  const tags = doc.flattenedTags().map((t) => ({
    name: get(() => t.name(), ""),
    parent: get(() => (t.container().class() === "tag" ? t.container().name() : null)),
  }));

  const tasks = doc.flattenedTasks.whose({ completed: false })().map((t) => ({
    id: get(() => t.id()),
    name: get(() => t.name(), ""),
    note: get(() => t.note(), ""),
    project: get(() => t.containingProject().name()),
    tags: get(() => t.tags().map((tag) => tag.name()), []),
    due: iso(get(() => t.dueDate())),
    defer: iso(get(() => t.deferDate())),
    planned: iso(get(() => t.plannedDate())),
    estimatedMinutes: get(() => t.estimatedMinutes()),
    flagged: get(() => t.flagged(), false),
    repeat: get(() => t.repetitionRule().recurrence),
    dropped: get(() => t.dropped(), false) || get(() => t.effectivelyDropped(), false),
    createdAt: iso(get(() => t.creationDate())),
    updatedAt: iso(get(() => t.modificationDate())),
  }));

  return JSON.stringify({ projects, tags, tasks });
}
`;

const STATUS = { active: "active", "on hold": "onhold", done: "dropped", dropped: "dropped" };
const UNIT_DAYS = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365 };

function projectStatus(raw) {
  const text = String(raw ?? "").toLowerCase().replace(/\s*status$/, "").trim();
  return STATUS[text] ?? "active";
}

function reviewDays(interval) {
  if (!interval) return null;
  const days = (UNIT_DAYS[String(interval.unit ?? "").toLowerCase()] ?? 0) * (Number(interval.steps) || 1);
  return days >= 1 && days <= 366 ? days : null;
}

const minutes = (value) => (Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null);

/**
 * Turns what the script read into what the store imports. Projects in OmniFocus also show up as a
 * task with the project's own id; those are skipped so a project never becomes a task of itself.
 */
export function fromOmniFocus(raw) {
  const projectIds = new Set(raw.projects.map((project) => project.id).filter(Boolean));
  const projects = raw.projects
    .filter((project) => project.name)
    .map((project) => ({
      name: project.name,
      folder: project.folder,
      status: projectStatus(project.status),
      reviewDays: reviewDays(project.reviewInterval),
      nextReview: project.nextReview,
      lastReviewed: project.lastReviewed,
    }));
  const tags = raw.tags.filter((tag) => tag.name).map((tag) => ({ name: tag.name, parent: tag.parent || null }));
  const tasks = raw.tasks
    .filter((task) => task.id && task.name && !projectIds.has(task.id))
    .map((task) => ({
      ofId: task.id,
      name: task.name,
      note: task.note ?? "",
      project: task.project ?? null,
      tags: task.tags ?? [],
      due: task.due,
      defer: task.defer,
      planned: task.planned,
      estimatedMinutes: minutes(task.estimatedMinutes),
      flagged: Boolean(task.flagged),
      repeat: task.repeat || null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: null,
      droppedAt: task.dropped ? task.updatedAt ?? new Date().toISOString() : null,
    }));
  return { projects, tags, tasks };
}

export async function readOmniFocus({ exec = run } = {}) {
  const result = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", OMNIFOCUS_SCRIPT], { timeoutMs: IMPORT_TIMEOUT_MS });
  if (result.timedOut) throw new Error("OmniFocus took too long to answer.");
  if (result.code !== 0) {
    const detail = `${result.stderr ?? ""}${result.spawnError?.message ?? ""}`;
    if (detail.includes("OMNIFOCUS_CLOSED")) throw new Error("Open OmniFocus and try again.");
    if (/-1743|not allowed|Not authorized/i.test(detail)) throw new Error("Allow SMCP to control OmniFocus in System Settings > Privacy & Security > Automation.");
    throw new Error("Could not read OmniFocus.");
  }
  return fromOmniFocus(JSON.parse(result.stdout));
}

/** Reads OmniFocus and saves it into the list. Returns how many tasks were created and updated. */
export async function importFromOmniFocus(store, options) {
  const data = await readOmniFocus(options);
  return { ...store.importOmniFocus(data), unestimated: data.tasks.filter((task) => !task.droppedAt && task.estimatedMinutes === null).length };
}
