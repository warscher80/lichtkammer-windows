#!/usr/bin/env bash
# Baut einen macOS-Installer (DMG und ZIP). Muss auf einem Mac laufen,
# weil Electron und die Bildbibliothek plattformspezifische Dateien enthalten.
#
# Signatur und Notarisierung sind optional und kommen nur aus der Umgebung:
#   Developer ID im Schlüsselbund, oder CSC_LINK und CSC_KEY_PASSWORD
#   Notarisierung über APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
#   oder über APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
# APPLE_API_KEY_CONTENT (PEM oder Base64) wird in eine .p8 unter
# ~/.lichtkammer-secrets geschrieben und als APPLE_API_KEY weitergegeben.
# Aufruf aus der CI, wenn npm install schon gelaufen ist: --skip-install
set -euo pipefail
cd "$(dirname "$0")/.."

skip_install=0
if [[ "${1:-}" == "--skip-install" ]]; then
  skip_install=1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS-Installer können nur auf einem Mac erzeugt werden."
  echo "Auf diesem System: npm run dist:linux   oder   npm run dist:win auf Windows."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 oder neuer wird benötigt: https://nodejs.org"
  exit 1
fi

# Leere CI-Secrets nicht als Dateipfad an electron-builder durchreichen.
if [[ -z "${CSC_LINK:-}" ]]; then
  unset CSC_LINK
fi
if [[ -z "${CSC_KEY_PASSWORD:-}" ]]; then
  unset CSC_KEY_PASSWORD
fi

if [[ -n "${APPLE_API_KEY_CONTENT:-}" ]]; then
  secret_dir="${HOME}/.lichtkammer-secrets"
  mkdir -p "${secret_dir}"
  key_file="${secret_dir}/AuthKey.p8"
  node -e '
    const fs = require("fs");
    const raw = process.env.APPLE_API_KEY_CONTENT || "";
    const text = raw.includes("BEGIN PRIVATE KEY")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    if (!text.includes("BEGIN PRIVATE KEY")) {
      console.error("APPLE_API_KEY_CONTENT ist weder eine .p8 noch gültiges Base64 einer .p8.");
      process.exit(1);
    }
    const out = text.endsWith("\n") ? text : text + "\n";
    fs.writeFileSync(process.argv[1], out, { mode: 0o600 });
  ' "${key_file}"
  chmod 600 "${key_file}"
  export APPLE_API_KEY="${key_file}"
fi

if [[ -z "${APPLE_API_KEY:-}" ]]; then
  unset APPLE_API_KEY
fi

if [[ "${skip_install}" -eq 0 ]]; then
  npm install
fi

npm run dist:mac

echo
echo "Fertig. DMG und ZIP liegen in release/ (x64 und arm64)."
echo "Mit einem Zertifikat „Developer ID Application“ im Schlüsselbund, oder mit CSC_LINK, ist die App signiert."
echo "Notarisiert wird sie mit APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD und APPLE_TEAM_ID"
echo "oder mit APPLE_API_KEY, APPLE_API_KEY_ID und APPLE_API_ISSUER."
echo "Ohne Zertifikat: Rechtsklick auf Lichtkammer → Öffnen."
