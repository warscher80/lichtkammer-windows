/** Vergleicht zwei Messläufe: gleiche Schärfe, Hashes, Automatik und gleiche Sortierung (behalten/unscharf/Duplikat). */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { applyCulling } from '../src/main/engine/culling'
import { DEFAULT_SETTINGS, NEUTRAL_EDITS, type PhotoRecord } from '../src/shared/types'

const [aPath, bPath] = process.argv.slice(2)
const load = async (p: string): Promise<Record<string, any>[]> => JSON.parse(await readFile(p, 'utf8')).results
const [a, b] = await Promise.all([load(aPath), load(bPath)])
const fields = ['sharpness', 'sharpnessScore', 'hash', 'pHash', 'contentHash', 'width', 'height', 'capturedAt', 'developedFrom', 'camera']
let diffs = 0
let autoDiffs = 0
for (let i = 0; i < a.length; i += 1) {
  const ra = a[i].result
  const rb = b[i].result
  for (const f of fields) {
    if (JSON.stringify(ra[f]) !== JSON.stringify(rb[f])) {
      diffs += 1
      console.log('Abweichung', basename(a[i].filePath), f, ra[f], rb[f])
    }
  }
  if (JSON.stringify(ra.autoEdits) !== JSON.stringify(rb.autoEdits)) autoDiffs += 1
}
const toPhotos = (list: Record<string, any>[]): PhotoRecord[] =>
  list.map((entry, index) => ({
    id: `p${index}`,
    sourcePath: entry.filePath,
    fileName: basename(entry.filePath),
    ext: '',
    fileSize: 1,
    ...entry.result,
    status: 'kept',
    edits: NEUTRAL_EDITS,
    importedAt: 0,
    usedEmbeddedPreview: false
  }))
const ca = applyCulling(toPhotos(a), DEFAULT_SETTINGS)
const cb = applyCulling(toPhotos(b), DEFAULT_SETTINGS)
let statusDiffs = 0
for (let i = 0; i < ca.length; i += 1) if (ca[i].status !== cb[i].status || ca[i].duplicateOf !== cb[i].duplicateOf) statusDiffs += 1
const count = (list: PhotoRecord[], s: string): number => list.filter((p) => p.status === s).length
console.log(`${a.length} Fotos verglichen: ${diffs} Messwert-Abweichungen, ${autoDiffs} Automatik-Abweichungen, ${statusDiffs} Sortier-Abweichungen`)
console.log(`alt: behalten ${count(ca, 'kept')}, unscharf ${count(ca, 'blurry')}, Duplikate ${count(ca, 'duplicate')}`)
console.log(`neu: behalten ${count(cb, 'kept')}, unscharf ${count(cb, 'blurry')}, Duplikate ${count(cb, 'duplicate')}`)
const timeA = a.reduce((s, r) => s + r.ms, 0) / 1000
const timeB = b.reduce((s, r) => s + r.ms, 0) / 1000
console.log(`Rechenzeit summiert: alt ${timeA.toFixed(0)} s, neu ${timeB.toFixed(0)} s`)
process.exit(diffs + autoDiffs + statusDiffs === 0 ? 0 : 1)
