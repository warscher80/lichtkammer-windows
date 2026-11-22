# Baut den Windows-Installer (NSIS). Muss unter Windows laufen.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not ($env:OS -like "*Windows*")) {
  Write-Error "Windows-Installer können nur unter Windows erzeugt werden."
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 20 oder neuer wird benötigt: https://nodejs.org"
  exit 1
}

npm install
npm run dist:win
Write-Host ""
Write-Host "Fertig. Der Installer liegt in release/."
Write-Host "SmartScreen kann beim ersten Start warnen, solange die App nicht signiert ist."
