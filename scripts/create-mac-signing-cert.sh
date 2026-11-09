#!/bin/bash
# Creates the certificate SMCP's Mac releases are signed with. Run it once, on your Mac.
# macOS ties Accessibility and Screen Recording to the certificate that signs an app. Signed ad hoc, every
# release counts as a different app and loses them; with the same certificate on every release they stay on.
# Keep the files it writes safe: anyone with them can sign apps that macOS treats as SMCP.
set -euo pipefail

NAME="${SMCP_MAC_SIGN_IDENTITY:-SMCP Code Signing}"
OUT="${1:-$HOME/.smcp-release}"
P12="$OUT/mac-signing.p12"
PASSWORD_FILE="$OUT/mac-signing-password.txt"

if [ -e "$P12" ]; then
  echo "$P12 already exists. A new certificate would make every Mac ask for its permissions again."
  echo "Delete it first only if you really want to replace it."
  exit 1
fi

mkdir -p "$OUT"
chmod 700 "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

# 20 years, so it never has to change while SMCP is in use.
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$WORK/cert.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2> /dev/null

PASSWORD="$(openssl rand -base64 24)"
# OpenSSL 3 needs -legacy for a .p12 that macOS can import; LibreSSL (the one macOS ships) has no such flag.
LEGACY=()
openssl pkcs12 -help 2>&1 | grep -q -- -legacy && LEGACY=(-legacy)
( umask 077
  openssl pkcs12 -export ${LEGACY[@]+"${LEGACY[@]}"} -name "$NAME" -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -out "$P12" -passout "pass:$PASSWORD"
  printf '%s' "$PASSWORD" > "$PASSWORD_FILE" )

if [ "$(uname)" = Darwin ]; then
  # So scripts/release.mjs can also sign on this Mac. macOS asks for your password to trust the certificate.
  security import "$P12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASSWORD" -T /usr/bin/codesign
  security add-trusted-cert -r trustRoot -p codeSign -k "$HOME/Library/Keychains/login.keychain-db" "$WORK/cert.pem"
fi

cat <<MSG

Created "$NAME":
  $P12
  $PASSWORD_FILE

Give it to the Release workflow (needs the gh CLI, signed in):

  base64 < "$P12" | tr -d '\n' | gh secret set SMCP_MAC_CERT_P12 --repo santiagomlr/smcp
  gh secret set SMCP_MAC_CERT_PASSWORD --repo santiagomlr/smcp < "$PASSWORD_FILE"

Then keep both files somewhere safe, such as your password manager.
MSG
