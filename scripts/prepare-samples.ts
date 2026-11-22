import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { hammingHex } from '../src/main/engine/hash'
import { analyzeFile, channelMeans, renderImage } from '../src/main/engine/process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'beispiele')
const cacheDir = join(root, 'scripts', '.cache')

interface Expectation {
  name: string
  expect: 'kept' | 'blurry' | 'duplicate'
  sameGroupAs?: string
  minExposure?: number
  minAbsTemperature?: number
  minContrast?: number
  embedded?: boolean
}

const SOURCES = [
  ['1015', 'fjord'],
  ['1011', 'kanu'],
  ['1039', 'wasserfall'],
  ['137', 'roehre'],
  ['1043', 'yosemite'],
  ['164', 'bruegge'],
  ['1018', 'hochland'],
  ['870', 'leuchtturm'],
  ['1080', 'erdbeeren'],
  ['1074', 'loewin']
] as const

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  const cache = new Map<string, string>()
  for (const [id, name] of SOURCES) {
    const portrait = id === '1074'
    const file = join(cacheDir, `${id}.jpg`)
    await download(id, file, portrait)
    cache.set(name, file)
  }

  const fjord = cache.get('fjord') as string
  await sharp(fjord).jpeg({ quality: 92, mozjpeg: true }).toFile(join(outDir, '01-fjord-scharf.jpg'))
  await copyFile(join(outDir, '01-fjord-scharf.jpg'), join(outDir, '02-fjord-kopie.jpg'))
  await makeNearDuplicate(join(outDir, '01-fjord-scharf.jpg'), join(outDir, '03-fjord-nahe.jpg'))
  await sharp(cache.get('kanu') as string).jpeg({ quality: 90, mozjpeg: true }).toFile(join(outDir, '04-kanu.jpg'))
  await makeBlurry(cache.get('wasserfall') as string, join(outDir, '05-wasserfall-unscharf.jpg'))
  await makeBlurry(cache.get('roehre') as string, join(outDir, '06-roehre-unscharf.jpg'), 2)
  await makeDark(cache.get('yosemite') as string, join(outDir, '07-yosemite-dunkel.jpg'))
  await makeCast(cache.get('bruegge') as string, join(outDir, '08-bruegge-farbstich.jpg'))
  await makeFlat(cache.get('hochland') as string, join(outDir, '09-hochland-flach.jpg'))
  await sharp(cache.get('leuchtturm') as string)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(join(outDir, '10-leuchtturm.jpg'))
  await sharp(cache.get('erdbeeren') as string).png().toFile(join(outDir, '11-erdbeeren.png'))
  await makeRaw(cache.get('loewin') as string, join(outDir, '12-loewin.ARW'))

  const expectations: Expectation[] = [
    { name: '01-fjord-scharf.jpg', expect: 'kept' },
    { name: '02-fjord-kopie.jpg', expect: 'duplicate', sameGroupAs: '01-fjord-scharf.jpg' },
    { name: '03-fjord-nahe.jpg', expect: 'duplicate', sameGroupAs: '01-fjord-scharf.jpg' },
    { name: '04-kanu.jpg', expect: 'kept' },
    { name: '05-wasserfall-unscharf.jpg', expect: 'blurry' },
    { name: '06-roehre-unscharf.jpg', expect: 'blurry' },
    { name: '07-yosemite-dunkel.jpg', expect: 'kept', minExposure: 0.35 },
    { name: '08-bruegge-farbstich.jpg', expect: 'kept', minAbsTemperature: 8 },
    { name: '09-hochland-flach.jpg', expect: 'kept', minContrast: 8 },
    { name: '10-leuchtturm.jpg', expect: 'kept' },
    { name: '11-erdbeeren.png', expect: 'kept' },
    { name: '12-loewin.ARW', expect: 'kept', embedded: true }
  ]

  const analyzed = new Map<string, Awaited<ReturnType<typeof analyzeFile>>>()
  for (const item of expectations) {
    const result = await analyzeFile(join(outDir, item.name))
    analyzed.set(item.name, result)
    console.log(
      `${item.name.padEnd(28)} score=${String(result.sharpnessScore).padStart(3)} var=${Math.round(result.sharpness).toString().padStart(6)} exp=${result.autoEdits.exposure.toFixed(2)} temp=${result.autoEdits.temperature} contrast=${result.autoEdits.contrast} raw=${result.usedEmbeddedPreview}`
    )
  }

  const anchor = analyzed.get('01-fjord-scharf.jpg') as Awaited<ReturnType<typeof analyzeFile>>
  for (const name of ['02-fjord-kopie.jpg', '03-fjord-nahe.jpg']) {
    const distance = hammingHex(anchor.hash, (analyzed.get(name) as Awaited<ReturnType<typeof analyzeFile>>).hash)
    console.log(`Abstand ${name}: ${distance}`)
    if (distance > 8) throw new Error(`${name} ist kein Beinahe-Duplikat (Abstand ${distance})`)
  }

  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ blurThreshold: 32, duplicateDistance: 8, files: expectations }, null, 2))
  await writeFile(
    join(outDir, 'QUELLEN.md'),
    [
      '# Beispielbilder',
      '',
      'Die Fotos stammen von [Picsum Photos](https://picsum.photos) (Unsplash-Lizenz) und wurden für die Demonstration bearbeitet: Kopie, leichte Verschiebung, Weichzeichnung, Unterbelichtung, Farbstich, flacher Kontrast. Die Datei `12-loewin.ARW` ist kein Kamera-RAW, sondern eine Hülle mit eingebettetem JPEG, damit der Vorschaupfad ohne LibRaw prüfbar ist.',
      '',
      'Picsum-IDs: 1015, 1011, 1039, 137, 1043, 164, 1018, 870, 1080, 1074.',
      ''
    ].join('\n')
  )
  await writeIcon()
  console.log('Beispielset bereit.')
}

async function download(id: string, destination: string, portrait: boolean): Promise<void> {
  try {
    await readFile(destination)
    return
  } catch {
    /* neu laden */
  }
  const size = portrait ? '1100/1500' : '1600/1067'
  const response = await fetch(`https://picsum.photos/id/${id}/${size}`, {
    headers: { 'user-agent': 'Lichtkammer/1.0 (Beispielbilder)' }
  })
  if (!response.ok) throw new Error(`Download ${id} fehlgeschlagen: ${response.status}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function makeNearDuplicate(source: string, destination: string): Promise<void> {
  const original = await analyzeFile(source)
  const meta = await sharp(source).metadata()
  const width = meta.width ?? 1600
  const height = meta.height ?? 1067
  for (const shift of [1, 2, 3, 4, 6, 8]) {
    const buffer = await sharp(source)
      .extend({ top: shift, left: shift, bottom: 0, right: 0, extendWith: 'mirror' })
      .extract({ left: 0, top: 0, width, height })
      .jpeg({ quality: 74, mozjpeg: true })
      .toBuffer()
    const temp = join(cacheDir, 'probe.jpg')
    await writeFile(temp, buffer)
    const probed = await analyzeFile(temp)
    const distance = hammingHex(original.hash, probed.hash)
    if (distance >= 1 && distance <= 8 && probed.sharpness <= original.sharpness + 5) {
      await writeFile(destination, buffer)
      return
    }
  }
  await sharp(source).jpeg({ quality: 58, mozjpeg: true }).toFile(destination)
}

async function makeBlurry(source: string, destination: string, floor = 6): Promise<void> {
  const untouched = join(cacheDir, 'blur-source.jpg')
  await sharp(source).jpeg({ quality: 88, mozjpeg: true }).toFile(untouched)
  const original = await analyzeFile(untouched)
  if (original.sharpnessScore <= 18) {
    await writeFile(destination, await readFile(untouched))
    return
  }
  for (const sigma of [floor, floor + 4, floor + 8, 18, 28]) {
    const buffer = await sharp(source).blur(sigma).jpeg({ quality: 86, mozjpeg: true }).toBuffer()
    const temp = join(cacheDir, 'probe.jpg')
    await writeFile(temp, buffer)
    const probed = await analyzeFile(temp)
    if (probed.sharpnessScore <= 18) {
      await writeFile(destination, buffer)
      return
    }
  }
  throw new Error(`Konnte ${destination} nicht unscharf genug machen`)
}

async function makeDark(source: string, destination: string): Promise<void> {
  for (const brightness of [0.42, 0.34, 0.28, 0.22]) {
    const buffer = await sharp(source).modulate({ brightness }).jpeg({ quality: 90, mozjpeg: true }).toBuffer()
    const temp = join(cacheDir, 'probe.jpg')
    await writeFile(temp, buffer)
    const probed = await analyzeFile(temp)
    if (probed.autoEdits.exposure >= 0.4 && probed.sharpnessScore >= 40) {
      await writeFile(destination, buffer)
      return
    }
  }
  throw new Error('Dunkles Beispiel bleibt ohne ausreichende Belichtungskorrektur')
}

async function makeCast(source: string, destination: string): Promise<void> {
  for (const blue of [1.45, 1.65, 1.85, 2.1]) {
    const buffer = await sharp(source)
      .recomb([
        [0.7, 0, 0],
        [0, 0.9, 0],
        [0, 0, blue]
      ])
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer()
    const temp = join(cacheDir, 'probe.jpg')
    await writeFile(temp, buffer)
    const probed = await analyzeFile(temp)
    if (Math.abs(probed.autoEdits.temperature) < 10 || probed.sharpnessScore < 36) continue
    const before = await channelMeans(temp)
    const corrected = await renderImage({
      filePath: temp,
      edits: probed.autoEdits,
      maxEdge: 700,
      format: 'jpeg',
      quality: 86
    })
    await writeFile(join(cacheDir, 'probe-out.jpg'), corrected.buffer)
    const after = await channelMeans(join(cacheDir, 'probe-out.jpg'))
    if (Math.abs(after.r - after.b) < Math.abs(before.r - before.b) * 0.9) {
      await writeFile(destination, buffer)
      return
    }
  }
  throw new Error('Farbstich wird nicht erkannt')
}

async function makeFlat(source: string, destination: string): Promise<void> {
  for (const amount of [0.62, 0.5, 0.4, 0.32]) {
    const buffer = await sharp(source)
      .linear(amount, Math.round((1 - amount) * 118))
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer()
    const temp = join(cacheDir, 'probe.jpg')
    await writeFile(temp, buffer)
    const probed = await analyzeFile(temp)
    if (probed.autoEdits.contrast >= 10 && probed.sharpnessScore >= 36) {
      await writeFile(destination, buffer)
      return
    }
  }
  throw new Error('Flaues Beispiel wird nicht als kontrastarm erkannt oder wird zu unscharf')
}

async function makeRaw(source: string, destination: string): Promise<void> {
  const jpeg = await sharp(source).jpeg({ quality: 90, mozjpeg: true }).toBuffer()
  const pad = Buffer.alloc(1536)
  for (let index = 0; index < pad.length; index += 1) pad[index] = (index * 17) % 251
  const wrapped = Buffer.concat([Buffer.from('LICHTKAMMER-ARW-DEMO\0'), pad, jpeg, pad])
  await writeFile(destination, wrapped)
}

async function writeIcon(): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" rx="196" fill="#171410"/>
    <circle cx="512" cy="512" r="300" fill="none" stroke="#e0a44b" stroke-width="36"/>
    <circle cx="512" cy="512" r="92" fill="#e0a44b"/>
    <g stroke="#e0a44b" stroke-width="28" stroke-linecap="round">
      <path d="M512 150v130M512 744v130M150 512h130M744 512h130"/>
      <path d="M268 268l92 92M664 664l92 92M756 268l-92 92M360 664l-92 92"/>
    </g>
  </svg>`
  await mkdir(join(root, 'build'), { recursive: true })
  await mkdir(join(root, 'resources'), { recursive: true })
  await sharp(Buffer.from(svg)).png().toFile(join(root, 'build', 'icon.png'))
  await sharp(Buffer.from(svg)).resize(256, 256).png().toFile(join(root, 'resources', 'icon.png'))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
