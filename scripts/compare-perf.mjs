// Vergleicht zwei Bedienungs-Messungen (alt gegen neu): node scripts/compare-perf.mjs <alt-Ordner> <neu-Ordner>
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [oldDir, newDir] = process.argv.slice(2)
const read = (dir, name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : {})
const a = { ...read(oldDir, 'perf-import.json'), ...read(oldDir, 'perf-run.json') }
const b = { ...read(newDir, 'perf-import.json'), ...read(newDir, 'perf-run.json') }

const rows = [
  ['Programmstart bis Fenster (ms)', (r) => r.startup?.windowShownMs],
  ['Programmstart bis erste Vorschaubilder (ms)', (r) => r.startup?.firstTilesMs],
  ['Foto öffnen (ms)', (r) => r.openPhotoMs],
  ['Nächstes Foto, Pfeiltaste (Median ms)', (r) => r.switchNeighbour?.median],
  ['Foto weiter weg anklicken (Median ms)', (r) => r.switchJump?.median],
  ['Look anklicken bis Bild (Median ms)', (r) => r.lookClick?.median],
  ['Look anklicken bis Bild (95 % ms)', (r) => r.lookClick?.p95],
  ['Regler ziehen (Bilder pro Sekunde)', (r) => r.sliderDrag?.fps],
  ['Regler ziehen, Wartezeit bis Bild (Median ms)', (r) => r.sliderDrag?.inputToFrameMs?.median],
  ['Bibliothek scrollen (Bilder pro Sekunde)', (r) => r.libraryScroll?.scrollFps],
  ['Bibliothek scrollen, ruckelnde Bilder (>33 ms)', (r) => r.libraryScroll?.framesOver33ms],
  ['Import 600 Fotos (s)', (r) => r.importSeconds],
  ['Alle sichern, 12 große Fotos (s)', (r) => r.export?.seconds]
]
const fmt = (v) => (v === undefined || v === null ? '–' : String(v))
const lines = ['| Messung | Alt | Neu |', '|---|---:|---:|']
for (const [label, pick] of rows) lines.push(`| ${label} | ${fmt(pick(a))} | ${fmt(pick(b))} |`)
console.log(lines.join('\n'))
