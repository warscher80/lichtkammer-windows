/**
 * Unit-Tests der Bildpipeline ohne Fenster: npm run test
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { adjustHsl, bandValue, geometryExtract, skyMask, straightenScale } from '../src/shared/develop'
import { analyzeFile, renderImage, renderLooks } from '../src/main/engine/process'
import { effectiveEdits, findLook, LOOKS, monochromeAmount } from '../src/shared/looks'
import { cloneEdits, editKey, NEUTRAL_EDITS, sanitizeEdits, type EditParams } from '../src/shared/types'

let passed = 0
let failed = 0
const tests: [string, () => Promise<void> | void][] = []
function test(name: string, body: () => Promise<void> | void): void {
  tests.push([name, body])
}

function edits(partial: Partial<EditParams>): EditParams {
  return sanitizeEdits({ ...cloneEdits(NEUTRAL_EDITS), ...partial })
}

async function meanRgb(buffer: Buffer): Promise<{ r: number; g: number; b: number; w: number; h: number }> {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < data.length; i += 3) {
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
  }
  const n = data.length / 3
  return { r: r / n, g: g / n, b: b / n, w: info.width, h: info.height }
}

const sample = join(process.cwd(), 'beispiele', '04-kanu.jpg')
let synthetic = ''

test('12 Looks wie in der iPhone-App', () => {
  assert.equal(LOOKS.length, 12)
  assert.deepEqual(
    LOOKS.map((look) => look.name),
    ['Automatik', 'Natürlich', 'Lebendig', 'Schwarzweiß', 'Film', 'Porträt', 'Landschaft', 'Nacht', 'Kühl', 'Warm', 'Dramatisch', 'Vintage']
  )
  assert.equal(findLook('film')?.delta.blacks, 30)
  assert.equal(findLook('vintage')?.delta.hslHue[3], -15)
  assert.equal(findLook('automatik'), null)
})

test('Look-Stärke mischt linear', () => {
  const base = edits({ contrast: 10, temperature: -5 })
  const half = effectiveEdits({ ...base, preset: 'dramatisch', presetStrength: 50 })
  assert.equal(half.contrast, 10 + 12.5)
  assert.equal(half.highlights, -15)
  const none = effectiveEdits({ ...base, preset: 'dramatisch', presetStrength: 0 })
  assert.equal(none.contrast, 10)
  assert.equal(effectiveEdits({ ...base, preset: null }).contrast, 10)
  assert.equal(monochromeAmount({ ...base, preset: 'schwarzweiss', presetStrength: 70 }), 0.7)
  assert.equal(monochromeAmount({ ...base, preset: 'film', presetStrength: 70 }), 0)
  const land = effectiveEdits({ ...base, preset: 'landschaft', presetStrength: 100 })
  assert.equal(land.skyEnhance, true)
  assert.equal(land.hslSat[5], 15)
})

test('Alte Kataloge und kaputte Werte werden gültig', () => {
  const old = sanitizeEdits({ exposure: 0.333, contrast: 400, temperature: 'x', sharpen: -5 })
  assert.equal(old.exposure, 0.35)
  assert.equal(old.contrast, 100)
  assert.equal(old.temperature, 0)
  assert.equal(old.sharpen, 0)
  assert.equal(old.whites, 0)
  assert.deepEqual(old.hslSat, [0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(old.presetStrength, 100)
  assert.equal(old.crop, null)
  assert.equal(sanitizeEdits({ rotate: -90 }).rotate, 270)
  assert.equal(sanitizeEdits({ rotate: 450 }).rotate, 90)
  assert.equal(sanitizeEdits({ crop: { x: 0, y: 0, w: 1, h: 1 } }).crop, null)
  const crop = sanitizeEdits({ crop: { x: 0.8, y: 0.1, w: 0.9, h: 0.5 } }).crop
  assert.ok(crop && crop.x + crop.w <= 1.0001)
  assert.equal(sanitizeEdits({ straighten: 99 }).straighten, 45)
})

test('editKey ist stabil und erkennt Änderungen', () => {
  const a = edits({ contrast: 5 })
  assert.equal(editKey(a), editKey(cloneEdits(a)))
  assert.notEqual(editKey(a), editKey({ ...a, contrast: 6 }))
  assert.notEqual(editKey(a), editKey({ ...a, preset: 'warm' }))
  assert.notEqual(editKey(a), editKey({ ...a, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }))
  const hsl = cloneEdits(a)
  hsl.hslLum[2] = 10
  assert.notEqual(editKey(a), editKey(hsl))
})

test('Begradigen: kein schwarzer Rand, Ausschnitt im Bild', () => {
  assert.equal(straightenScale(3000, 2000, 0), 1)
  const scale = straightenScale(3000, 2000, 10)
  assert.ok(scale > 0.7 && scale < 0.9, `scale ${scale}`)
  const rect = geometryExtract({ baseWidth: 3000, baseHeight: 2000, canvasWidth: 3302, canvasHeight: 2491, straighten: 10, crop: null })
  assert.ok(rect.left > 0 && rect.top > 0)
  assert.ok(rect.left + rect.width <= 3302 && rect.top + rect.height <= 2491)
  const cropped = geometryExtract({ baseWidth: 100, baseHeight: 50, canvasWidth: 100, canvasHeight: 50, straighten: 0, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } })
  assert.deepEqual(cropped, { left: 50, top: 0, width: 50, height: 50 })
})

test('HSL: Bandmitten und Neutralität', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80]
  assert.equal(bandValue(values, 0), 10)
  assert.equal(bandValue(values, 120), 40)
  assert.equal(bandValue(values, 240), 60)
  assert.ok(Math.abs(bandValue(values, 359.9) - 10) < 0.1)
  const out = [0, 0, 0]
  const zero = [0, 0, 0, 0, 0, 0, 0, 0]
  adjustHsl(0.8, 0.2, 0.2, zero, zero, zero, out)
  assert.ok(Math.abs(out[0] - 0.8) < 1e-6 && Math.abs(out[1] - 0.2) < 1e-6)
  adjustHsl(0.8, 0.2, 0.2, zero, [-100, 0, 0, 0, 0, 0, 0, 0], zero, out)
  assert.ok(Math.abs(out[0] - out[1]) < 0.02, 'Rot entsättigt')
  adjustHsl(0.2, 0.3, 0.9, zero, zero, zero, out)
  assert.ok(Math.abs(out[2] - 0.9) < 1e-6)
})

test('Himmelsmaske erkennt blauen Himmel oben', () => {
  const w = 64
  const h = 48
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3
      if (y < h / 2) {
        rgb[i] = 90
        rgb[i + 1] = 150
        rgb[i + 2] = 230
      } else {
        rgb[i] = ((x * 37 + y * 11) % 90) + 40
        rgb[i + 1] = ((x * 13 + y * 29) % 70) + 60
        rgb[i + 2] = 30
      }
    }
  }
  const mask = skyMask(rgb, w, h)
  assert.ok(mask)
  assert.ok(mask![5 * w + 10] > 200, 'oben Himmel')
  assert.ok(mask![(h - 3) * w + 10] < 30, 'unten kein Himmel')
})

test('Rendern: Drehen, Zuschnitt, Belichtung, Schwarzweiß', async () => {
  const plain = await renderImage({ filePath: sample, edits: edits({}), maxEdge: 800, format: 'jpeg', quality: 90 })
  const rotated = await renderImage({ filePath: sample, edits: edits({ rotate: 90 }), maxEdge: 800, format: 'jpeg', quality: 90 })
  assert.equal(rotated.width, plain.height)
  assert.equal(rotated.height, plain.width)
  const cropped = await renderImage({
    filePath: sample,
    edits: edits({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }),
    maxEdge: 800,
    format: 'jpeg',
    quality: 90
  })
  assert.ok(Math.abs(cropped.width - plain.width / 2) <= 1 && Math.abs(cropped.height - plain.height / 2) <= 1)
  const ignored = await renderImage({
    filePath: sample,
    edits: edits({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }),
    maxEdge: 800,
    format: 'jpeg',
    quality: 90,
    ignoreCrop: true
  })
  assert.equal(ignored.width, plain.width)
  const straight = await renderImage({ filePath: sample, edits: edits({ straighten: 8 }), maxEdge: 800, format: 'jpeg', quality: 90 })
  assert.ok(straight.width < plain.width && straight.width > plain.width * 0.7)
  const corner = await sharp(straight.buffer).extract({ left: 0, top: 0, width: 4, height: 4 }).raw().toBuffer()
  assert.ok(Math.max(...corner) > 8, 'keine schwarzen Ecken')
  const base = await meanRgb(plain.buffer)
  const bright = await meanRgb(
    (await renderImage({ filePath: sample, edits: edits({ exposure: 1 }), maxEdge: 800, format: 'jpeg', quality: 90 })).buffer
  )
  assert.ok(bright.r + bright.g + bright.b > (base.r + base.g + base.b) * 1.15)
  const mono = await renderImage({
    filePath: sample,
    edits: edits({ preset: 'schwarzweiss', presetStrength: 100 }),
    maxEdge: 400,
    format: 'png',
    quality: 90
  })
  const { data } = await sharp(mono.buffer).raw().toBuffer({ resolveWithObject: true })
  let spread = 0
  for (let i = 0; i < data.length; i += 3) spread = Math.max(spread, Math.abs(data[i] - data[i + 1]), Math.abs(data[i + 1] - data[i + 2]))
  assert.ok(spread <= 3, `Schwarzweiß, Abweichung ${spread}`)
  const warm = await meanRgb(
    (await renderImage({ filePath: sample, edits: edits({ preset: 'warm' }), maxEdge: 400, format: 'jpeg', quality: 90 })).buffer
  )
  const cool = await meanRgb(
    (await renderImage({ filePath: sample, edits: edits({ preset: 'kuehl' }), maxEdge: 400, format: 'jpeg', quality: 90 })).buffer
  )
  assert.ok(warm.r - warm.b > cool.r - cool.b + 10, 'Warm wärmer als Kühl')
})

test('Weiß und Schwarz verschieben die Endpunkte', async () => {
  const lowWhites = await meanRgb(
    (await renderImage({ filePath: sample, edits: edits({ whites: -100 }), maxEdge: 400, format: 'jpeg', quality: 90 })).buffer
  )
  const highWhites = await meanRgb(
    (await renderImage({ filePath: sample, edits: edits({ whites: 100 }), maxEdge: 400, format: 'jpeg', quality: 90 })).buffer
  )
  assert.ok(highWhites.g > lowWhites.g + 5)
  const lift = await renderImage({ filePath: synthetic, edits: edits({ blacks: 100 }), maxEdge: 400, format: 'png', quality: 90 })
  const { data } = await sharp(lift.buffer).raw().toBuffer({ resolveWithObject: true })
  assert.ok(data[0] > 20, `Schwarz angehoben: ${data[0]}`)
})

test('Look-Vorschauen: eine pro Look', async () => {
  const list = await renderLooks({ filePath: sample, edits: edits({}), edge: 200 })
  assert.equal(list.length, 12)
  for (const item of list) assert.ok(item.length > 1000)
})

test('Große JPEGs (48 MP): Vorschau schnell, Export voll', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lk-'))
  const big = join(dir, 'gross.jpg')
  await sharp(sample).resize(8000, 6000, { fit: 'fill' }).jpeg({ quality: 90 }).toFile(big)
  const t0 = Date.now()
  const preview = await renderImage({ filePath: big, edits: edits({ preset: 'lebendig' }), maxEdge: 1700, format: 'jpeg', quality: 84 })
  const first = Date.now() - t0
  const t1 = Date.now()
  await renderImage({ filePath: big, edits: edits({ preset: 'lebendig', contrast: 20 }), maxEdge: 1700, format: 'jpeg', quality: 84 })
  const cached = Date.now() - t1
  assert.equal(Math.max(preview.width, preview.height), 1700)
  console.log(`    Vorschau 48 MP: erstes Mal ${first} ms, danach ${cached} ms`)
  assert.ok(cached < first, 'Cache greift')
  const t2 = Date.now()
  const full = await renderImage({
    filePath: big,
    edits: edits({ preset: 'film', hslSat: [0, 0, 0, 20, 0, 0, 0, 0], crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }),
    maxEdge: 0,
    format: 'jpeg',
    quality: 92
  })
  console.log(`    Export 48 MP mit Look, HSL, Zuschnitt: ${Date.now() - t2} ms, ${full.width}×${full.height}`)
  assert.equal(full.width, 6400)
  assert.equal(full.height, 4800)
})

test('Analyse: JPEG und RAW liefern Schärfe, Hashes, Vorschau', async () => {
  const jpeg = await analyzeFile(sample)
  assert.equal(jpeg.developedFrom, 'raster')
  assert.ok(jpeg.sharpnessScore >= 0 && jpeg.sharpnessScore <= 100)
  assert.equal(jpeg.hash.length, 16)
  assert.equal(jpeg.pHash.length, 16)
  assert.equal(jpeg.contentHash.length, 64)
  const meta = await sharp(jpeg.thumb).metadata()
  assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= 480)
  const nef = await analyzeFile(join(process.cwd(), 'beispiele', '13-nikon-d70s.NEF'))
  assert.equal(nef.developedFrom, 'sensor')
  assert.equal(nef.width, 3008)
  const sharpImage = await analyzeFile(join(process.cwd(), 'beispiele', '01-fjord-scharf.jpg'))
  const blurImage = await analyzeFile(join(process.cwd(), 'beispiele', '06-roehre-unscharf.jpg'))
  assert.ok(sharpImage.sharpnessScore > 60 && blurImage.sharpnessScore < 25, `${sharpImage.sharpnessScore} / ${blurImage.sharpnessScore}`)
  const copy = await analyzeFile(join(process.cwd(), 'beispiele', '02-fjord-kopie.jpg'))
  assert.equal(copy.contentHash, sharpImage.contentHash)
})

test('Analyse: kaputte Datei meldet Fehler statt zu hängen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lk-'))
  const bad = join(dir, 'kaputt.jpg')
  await writeFile(bad, Buffer.from('das ist kein Bild'))
  await assert.rejects(analyzeFile(bad))
})

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lk-'))
  synthetic = join(dir, 'schwarz.png')
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toFile(synthetic)
  await writeFile(join(dir, '.keep'), '')
  for (const [name, body] of tests) {
    try {
      await body()
      passed += 1
      console.log(`✓ ${name}`)
    } catch (error) {
      failed += 1
      console.log(`✗ ${name}`)
      console.log(error)
    }
  }
  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`)
  process.exit(failed ? 1 : 0)
}

void main()
