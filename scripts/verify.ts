import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyCulling } from '../src/main/engine/culling'
import { benchmarkDuplicateIndex } from '../src/main/engine/duplicates'
import { copyCulledFiles } from '../src/main/engine/files'
import { hammingHex } from '../src/main/engine/hash'
import { analyzeFile, channelMeans, renderImage } from '../src/main/engine/process'
import { extractLargestJpeg } from '../src/main/engine/rawExtract'
import { DEFAULT_SETTINGS, NEUTRAL_EDITS, type PhotoRecord } from '../src/shared/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sampleDir = join(root, 'beispiele')

interface Expectation {
  name: string
  expect: 'kept' | 'blurry' | 'duplicate'
  sameGroupAs?: string
  notSameGroupAs?: string
  minExposure?: number
  minAbsTemperature?: number
  minContrast?: number
  embedded?: boolean
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(sampleDir, 'manifest.json'), 'utf8')) as {
    files: Expectation[]
  }
  const hashes = new Map<string, string>()
  for (const item of manifest.files) {
    hashes.set(item.name, await sha(join(sampleDir, item.name)))
  }

  const photos: PhotoRecord[] = []
  for (const item of manifest.files) {
    const analyzed = await analyzeFile(join(sampleDir, item.name))
    const file = await readFile(join(sampleDir, item.name))
    photos.push({
      id: item.name,
      sourcePath: join(sampleDir, item.name),
      fileName: item.name,
      ext: item.name.slice(item.name.lastIndexOf('.')),
      fileSize: file.length,
      width: analyzed.width,
      height: analyzed.height,
      sharpness: analyzed.sharpness,
      sharpnessScore: analyzed.sharpnessScore,
      hash: analyzed.hash,
      pHash: analyzed.pHash,
      contentHash: analyzed.contentHash,
      capturedAt: analyzed.capturedAt,
      status: 'kept',
      edits: analyzed.autoEdits,
      autoEdits: analyzed.autoEdits,
      importedAt: 0,
      developedFrom: analyzed.developedFrom,
      usedEmbeddedPreview: analyzed.usedEmbeddedPreview,
      camera: analyzed.camera
    })
    console.log(
      `${item.name.padEnd(28)} ${String(analyzed.sharpnessScore).padStart(3)}  ${analyzed.hash.slice(0, 8)}  exp ${analyzed.autoEdits.exposure.toFixed(2)}  ° ${analyzed.autoEdits.temperature}  K ${analyzed.autoEdits.contrast}`
    )
  }

  let culled = applyCulling(photos, DEFAULT_SETTINGS)
  const byName = new Map(culled.map((photo) => [photo.fileName, photo]))
  for (const item of manifest.files) {
    const photo = byName.get(item.name)
    if (!photo) throw new Error(`Fehlt nach dem Sichten: ${item.name}`)
    if (photo.status !== item.expect) {
      throw new Error(`${item.name}: erwartet ${item.expect}, ist ${photo.status} (Schärfe ${photo.sharpnessScore})`)
    }
    if (item.sameGroupAs) {
      const anchor = byName.get(item.sameGroupAs)
      if (!anchor || photo.groupId !== anchor.groupId) throw new Error(`${item.name} liegt nicht in der Gruppe von ${item.sameGroupAs}`)
    }
    if (item.notSameGroupAs) {
      const other = byName.get(item.notSameGroupAs)
      if (other && photo.groupId && photo.groupId === other.groupId) {
        throw new Error(`${item.name} wurde fälschlich mit ${item.notSameGroupAs} gruppiert`)
      }
    }
    if (item.minExposure !== undefined && photo.autoEdits.exposure < item.minExposure) {
      throw new Error(`${item.name}: Belichtung ${photo.autoEdits.exposure} < ${item.minExposure}`)
    }
    if (item.minAbsTemperature !== undefined && Math.abs(photo.autoEdits.temperature) < item.minAbsTemperature) {
      throw new Error(`${item.name}: Temperatur ${photo.autoEdits.temperature}`)
    }
    if (item.minContrast !== undefined && photo.autoEdits.contrast < item.minContrast) {
      throw new Error(`${item.name}: Kontrast ${photo.autoEdits.contrast}`)
    }
    if (item.embedded && !photo.usedEmbeddedPreview) {
      throw new Error(`${item.name}: eingebettete Vorschau wurde nicht verwendet`)
    }
  }

  const fjord = byName.get('01-fjord-scharf.jpg')
  const copy = byName.get('02-fjord-kopie.jpg')
  const near = byName.get('03-fjord-nahe.jpg')
  if (!fjord || !copy || !near) throw new Error('Fjord-Gruppe unvollständig')
  if (fjord.status !== 'kept') throw new Error('Das schärfere Fjord-Foto sollte behalten werden')
  if (copy.duplicateOf !== fjord.id || near.duplicateOf !== fjord.id) {
    throw new Error('Duplikate zeigen nicht auf das behaltene Foto')
  }
  console.log(
    `Fjord-Abstand dHash=${hammingHex(fjord.hash, near.hash)} pHash=${hammingHex(fjord.pHash ?? '', near.pHash ?? '')}`
  )
  const lookalike = byName.get('14-motiv-anders.jpg')
  if (!lookalike || lookalike.status !== 'kept' || (lookalike.groupId && lookalike.groupId === fjord.groupId)) {
    throw new Error('Ein anderes Motiv wurde mit dem Fjord gruppiert')
  }
  for (const count of [1000, 5000]) {
    const timing = benchmarkDuplicateIndex(count)
    console.log(
      `Duplikatsuche ${count} Hashes: naiv ${timing.naiveMs.toFixed(1)} ms, Index ${timing.indexMs.toFixed(1)} ms, Paare ${timing.pairs}`
    )
  }

  const dark = byName.get('07-yosemite-dunkel.jpg')
  if (!dark) throw new Error('Dunkles Foto fehlt')
  const beforeDark = await channelMeans(dark.sourcePath)
  const renderedDark = await renderImage({
    filePath: dark.sourcePath,
    edits: dark.autoEdits,
    maxEdge: 800,
    format: 'jpeg',
    quality: 90
  })
  const darkOut = join(tmpdir(), 'lichtkammer-dark-check.jpg')
  await writeFile(darkOut, renderedDark.buffer)
  const afterDark = await channelMeans(darkOut)
  if (afterDark.y < beforeDark.y + 0.08) {
    throw new Error(`Belichtung hebt die Helligkeit nicht an (${beforeDark.y.toFixed(3)} → ${afterDark.y.toFixed(3)})`)
  }

  const cast = byName.get('08-bruegge-farbstich.jpg')
  if (!cast) throw new Error('Farbstich fehlt')
  const beforeCast = await channelMeans(cast.sourcePath)
  const renderedCast = await renderImage({
    filePath: cast.sourcePath,
    edits: cast.autoEdits,
    maxEdge: 800,
    format: 'jpeg',
    quality: 90
  })
  const castOut = join(tmpdir(), 'lichtkammer-cast-check.jpg')
  await writeFile(castOut, renderedCast.buffer)
  const afterCast = await channelMeans(castOut)
  const imbalance = (means: { r: number; b: number }): number => Math.abs(means.r - means.b)
  if (imbalance(afterCast) >= imbalance(beforeCast) * 0.93) {
    throw new Error(
      `Weißabgleich korrigiert den Stich nicht (${imbalance(beforeCast).toFixed(3)} → ${imbalance(afterCast).toFixed(3)})`
    )
  }

  const neutral = await renderImage({
    filePath: dark.sourcePath,
    edits: NEUTRAL_EDITS,
    maxEdge: 400,
    format: 'jpeg',
    quality: 80
  })
  if (neutral.buffer.equals(renderedDark.buffer)) throw new Error('Auto-Entwicklung ist identisch mit dem Original')

  const blurry = culled.find((photo) => photo.status === 'blurry')
  if (!blurry) throw new Error('Kein unscharfes Foto')
  blurry.pin = 'kept'
  culled = applyCulling(culled, DEFAULT_SETTINGS)
  const restored = culled.find((photo) => photo.id === blurry.id)
  if (restored?.status !== 'kept') throw new Error('Wiederherstellen setzt das Foto nicht zurück')

  const folder = await mkdtemp(join(tmpdir(), 'lichtkammer-'))
  const copied = await copyCulledFiles(culled, folder)
  if (copied.copied < 1) throw new Error('Aussortierte Kopien fehlen')
  for (const [name, digest] of hashes) {
    const again = await sha(join(sampleDir, name))
    if (again !== digest) throw new Error(`Original verändert: ${name}`)
  }

  const raw = await readFile(join(sampleDir, '12-loewin.ARW'))
  const embedded = extractLargestJpeg(raw)
  if (!embedded || embedded.length < 10_000) throw new Error('JPEG-Vorschau im ARW nicht gefunden')
  const synthetic = byName.get('12-loewin.ARW')
  if (synthetic?.developedFrom !== 'embedded-preview') {
    throw new Error('Datei ohne Sensordaten sollte auf die eingebettete Vorschau zurückfallen')
  }

  const sensorPath = join(sampleDir, '13-nikon-d70s.NEF')
  const sensorDigest = await sha(sensorPath)
  const sensor = await analyzeFile(sensorPath)
  if (sensor.developedFrom !== 'sensor') throw new Error(`NEF-Quelle: ${sensor.developedFrom}`)
  if (!sensor.camera?.toLowerCase().includes('nikon')) throw new Error(`Kamera nicht erkannt: ${sensor.camera}`)
  if (sensor.width < 2800 || sensor.height < 1800) {
    throw new Error(`Sensormaß zu klein: ${sensor.width}×${sensor.height}`)
  }
  if ((await sha(sensorPath)) !== sensorDigest) throw new Error('Die NEF-Datei wurde verändert')
  if (sensor.autoEdits.clarity < 4) throw new Error('Automatische Klarheit fehlt')
  console.log(`Sensor-RAW: ${sensor.camera} ${sensor.width}×${sensor.height}`)

  await rm(darkOut, { force: true })
  await rm(castOut, { force: true })
  await rm(folder, { recursive: true, force: true })
  console.log(`Prüfung bestanden. ${copied.copied} Kopien erzeugt, Originale unverändert, Wiederherstellen ok.`)
}

async function sha(file: string): Promise<string> {
  const data = await readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
