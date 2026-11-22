import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { decodeRaw, renderRaw, type Decoded } from './engine/process'
import { samplesDirectory } from './session'
import { LOOKS } from '../shared/looks'
import { cloneEdits, NEUTRAL_EDITS, sanitizeEdits, type EditParams } from '../shared/types'

/**
 * Vergleich Grafikkarte gegen CPU-Engine (`--gpu-test=<Ausgabe>`): gleiche Eingabepixel, gleiche Regler,
 * Ergebnis der Shader gegen applyColor/applyGeometry/applyDetail. Maß: Farbabstand ΔE (CIE76) je Pixel.
 */
interface Case {
  name: string
  photo: string
  edits: EditParams
  ignoreCrop: boolean
}

function configs(): { name: string; edits: EditParams; ignoreCrop?: boolean }[] {
  const base = cloneEdits(NEUTRAL_EDITS)
  const make = (patch: Partial<EditParams>): EditParams => sanitizeEdits({ ...base, ...patch })
  const list: { name: string; edits: EditParams; ignoreCrop?: boolean }[] = [{ name: 'neutral', edits: make({}) }]
  for (const look of LOOKS) list.push({ name: `look-${look.id}`, edits: make({ preset: look.id, presetStrength: 100 }) })
  list.push({ name: 'look-lebendig-40', edits: make({ preset: 'lebendig', presetStrength: 40 }) })
  list.push({
    name: 'regler',
    edits: make({
      exposure: 0.7, contrast: 30, highlights: -40, shadows: 35, whites: 20, blacks: -20,
      temperature: 25, tint: -15, vibrance: 40, saturation: 20
    })
  })
  list.push({
    name: 'regler-negativ',
    edits: make({
      exposure: -0.9, contrast: -25, highlights: 50, shadows: -30, whites: -35, blacks: 30,
      temperature: -30, tint: 20, vibrance: -40, saturation: -35
    })
  })
  list.push({
    name: 'farben-einzeln',
    edits: make({
      hslHue: [10, -20, 30, 0, 40, -30, 0, 15],
      hslSat: [30, -20, 40, 25, -35, 20, 0, 10],
      hslLum: [10, -15, 20, 0, -25, 30, 0, 5]
    })
  })
  list.push({ name: 'himmel', edits: make({ skyEnhance: true }) })
  list.push({ name: 'details', edits: make({ clarity: 40, sharpen: 50, noise: 30 }) })
  list.push({ name: 'details-negativ', edits: make({ clarity: -50, sharpen: 0, noise: 60 }) })
  list.push({ name: 'drehen-90', edits: make({ rotate: 90 }) })
  list.push({ name: 'begradigen-7', edits: make({ straighten: 7 }) })
  list.push({ name: 'zuschnitt', edits: make({ crop: { x: 0.12, y: 0.2, w: 0.6, h: 0.55 } }) })
  list.push({
    name: 'alles-zusammen',
    edits: make({
      rotate: 90, straighten: -4, crop: { x: 0.1, y: 0.1, w: 0.75, h: 0.7 }, preset: 'landschaft', presetStrength: 80,
      exposure: 0.2, contrast: 10, clarity: 20, sharpen: 30, hslSat: [0, 0, 0, 20, 0, 30, 0, 0]
    })
  })
  list.push({ name: 'zuschnitt-ignoriert', edits: make({ crop: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, straighten: 3 }), ignoreCrop: true })
  return list
}

// sRGB → CIE Lab (D65)
function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const R = lin(r)
  const G = lin(g)
  const B = lin(b)
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

export async function runGpuTest(window: BrowserWindow, outDir: string): Promise<boolean> {
  const report: Record<string, unknown> = { ok: false }
  const rows: Record<string, unknown>[] = []
  const errors: string[] = []
  window.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level: string | number }).level
    if (level === 'error' || level === 3) errors.push((details as unknown as { message: string }).message.slice(0, 300))
  })
  try {
    await mkdir(outDir, { recursive: true })
    const dir = samplesDirectory()
    if (!dir) throw new Error('beispiele nicht gefunden')
    const names = (await readdir(dir)).sort()
    const photos = [names.find((n) => n.startsWith('01'))!, names.find((n) => n.startsWith('04'))!, names.find((n) => n.startsWith('08'))!, names.find((n) => n.startsWith('10'))!, names.find((n) => /\.arw$/i.test(n))!]
    const cases: Case[] = []
    for (const photo of photos) for (const config of configs()) cases.push({ name: config.name, photo, edits: config.edits, ignoreCrop: config.ignoreCrop === true })
    const decodedCache = new Map<string, Decoded>()
    let index = 0
    let info: Record<string, unknown> = {}
    let expecting: { row: Record<string, unknown>; cpu: { data: Buffer; width: number; height: number } } | null = null
    const finished = new Promise<void>((resolve) => {
      ipcMain.handle('gputest:next', async () => {
        if (index >= cases.length) {
          resolve()
          return null
        }
        const item = cases[index]
        index += 1
        let decoded = decodedCache.get(item.photo)
        if (!decoded) {
          decoded = await decodeRaw(join(dir, item.photo), 1024)
          decodedCache.set(item.photo, decoded)
        }
        const cpu = await renderRaw(decoded, item.edits, item.ignoreCrop)
        const row: Record<string, unknown> = { photo: item.photo, case: item.name, straighten: item.edits.straighten, width: cpu.width, height: cpu.height }
        expecting = { row, cpu }
        rows.push(row)
        return {
          name: item.name,
          edits: item.edits,
          ignoreCrop: item.ignoreCrop,
          raw: { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height, fullWidth: decoded.fullWidth, fullHeight: decoded.fullHeight },
          outWidth: cpu.width,
          outHeight: cpu.height
        }
      })
      ipcMain.handle('gputest:info', (_event, value: Record<string, unknown>) => {
        info = value
      })
      ipcMain.handle('gputest:submit', (_event, pixels: Uint8Array, ms: number) => {
        if (!expecting) return
        const { row, cpu } = expecting
        const expectingRotation = Math.abs((row.straighten as number) || 0) > 0.01
        expecting = null
        const gpu = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
        if (gpu.length !== cpu.data.length) {
          row.error = `Größe ${gpu.length} statt ${cpu.data.length}`
          return
        }
        let sum = 0
        let max = 0
        let over = 0
        let abs = 0
        const deltas: number[] = []
        const count = cpu.data.length / 3
        for (let at = 0; at < cpu.data.length; at += 3) {
          const a = toLab(cpu.data[at], cpu.data[at + 1], cpu.data[at + 2])
          const b = toLab(gpu[at], gpu[at + 1], gpu[at + 2])
          const delta = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
          sum += delta
          if (delta > max) max = delta
          if (delta > 2.3) over += 1
          abs += (Math.abs(cpu.data[at] - gpu[at]) + Math.abs(cpu.data[at + 1] - gpu[at + 1]) + Math.abs(cpu.data[at + 2] - gpu[at + 2])) / 3
          if (at % 30 === 0) deltas.push(delta)
        }
        deltas.sort((x, y) => x - y)
        row.meanDeltaE = Math.round((sum / count) * 1000) / 1000
        row.p99DeltaE = Math.round(deltas[Math.floor(deltas.length * 0.99)] * 100) / 100
        row.maxDeltaE = Math.round(max * 10) / 10
        row.shareOver2_3 = Math.round((over / count) * 10000) / 10000
        row.meanAbsDiff = Math.round((abs / count) * 100) / 100
        row.gpuMs = Math.round(ms * 10) / 10
        row.rotated = expectingRotation
        if ((row.meanDeltaE as number) > 0.8) {
          const name = `${String(row.photo).slice(0, 2)}-${row.case}`
          void sharp(cpu.data, { raw: { width: cpu.width, height: cpu.height, channels: 3 } }).png().toFile(join(outDir, `${name}-cpu.png`))
          void sharp(gpu, { raw: { width: cpu.width, height: cpu.height, channels: 3 } }).png().toFile(join(outDir, `${name}-gpu.png`))
        }
      })
    })
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) resolve()
      else window.webContents.once('did-finish-load', () => resolve())
    })
    await Promise.race([finished, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Zeitüberschreitung')), 600_000))])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const valid = rows.filter((row) => typeof row.meanDeltaE === 'number')
    const means = valid.map((row) => row.meanDeltaE as number)
    report.renderer = info.renderer ?? null
    report.cases = rows.length
    report.compared = valid.length
    report.meanDeltaE = Math.round((means.reduce((a, b) => a + b, 0) / Math.max(1, means.length)) * 1000) / 1000
    report.worstMeanDeltaE = Math.max(0, ...means)
    report.worstCase = valid.sort((a, b) => (b.meanDeltaE as number) - (a.meanDeltaE as number))[0] ?? null
    report.errors = errors.slice(0, 5)
    report.ok = valid.length === rows.length && rows.length > 0 && valid.every((row) => (row.meanDeltaE as number) < 2.3)
    await writeFile(join(outDir, 'gpu-test-cases.json'), JSON.stringify(rows, null, 1))
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }
  await writeFile(join(outDir, 'gpu-test.json'), JSON.stringify(report, null, 2))
  return report.ok === true
}
