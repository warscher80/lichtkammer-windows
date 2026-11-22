import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { suggestEdits, varianceToScore, type ImageStats } from './auto'
import { hashToHex, perceptualHashFromGray } from './hash'
import { decodeSensorRaw, isSensorRaw } from './rawDecode'
import { extractLargestJpeg } from './rawExtract'
import type { DevelopedFrom, EditParams } from '../../shared/types'

sharp.cache({ files: 16, memory: 64 })

export interface AnalyzeResult {
  width: number
  height: number
  sharpness: number
  sharpnessScore: number
  hash: string
  pHash: string
  contentHash: string
  capturedAt: number | null
  autoEdits: EditParams
  thumb: Buffer
  developedFrom: DevelopedFrom
  usedEmbeddedPreview: boolean
  camera?: string
}

export interface RenderResult {
  buffer: Buffer
  width: number
  height: number
  histogram: number[]
  mime: 'image/jpeg' | 'image/png'
}

const LINEAR = new Float32Array(256)
for (let value = 0; value < 256; value += 1) {
  const channel = value / 255
  LINEAR[value] =
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

export async function analyzeFile(filePath: string): Promise<AnalyzeResult> {
  const file = await readFile(filePath)
  const base = await openImage(filePath, 1440)
  const gray = await sharp(base.data, {
    raw: { width: base.width, height: base.height, channels: 3 }
  })
    .resize({ width: 480, height: 480, fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const sharpness = laplacianVariance(gray.data, gray.info.width, gray.info.height)
  const hash = await differenceHashFromRgb(base.data, base.width, base.height)
  const pHash = await perceptualHashFromRgb(base.data, base.width, base.height)
  const stats = measureStats(base.data)
  const score = varianceToScore(sharpness)
  const autoEdits = suggestEdits(stats, score)
  const rendered = await renderDecoded(base, autoEdits, 'jpeg', 76)
  return {
    width: base.fullWidth,
    height: base.fullHeight,
    sharpness,
    sharpnessScore: score,
    hash,
    pHash,
    contentHash: createHash('sha256').update(file).digest('hex'),
    capturedAt: readCaptureTime(file),
    autoEdits,
    thumb: rendered.buffer,
    developedFrom: base.developedFrom,
    usedEmbeddedPreview: base.developedFrom === 'embedded-preview',
    camera: base.camera
  }
}

export async function renderImage(options: {
  filePath: string
  edits: EditParams
  maxEdge: number
  format: 'jpeg' | 'png'
  quality: number
}): Promise<RenderResult> {
  const decoded = await openImage(options.filePath, options.maxEdge)
  return renderDecoded(decoded, options.edits, options.format, options.quality)
}

export async function channelMeans(
  filePath: string
): Promise<{ r: number; g: number; b: number; y: number }> {
  const decoded = await openImage(filePath, 480)
  let red = 0
  let green = 0
  let blue = 0
  const count = decoded.data.length / 3
  for (let index = 0; index < decoded.data.length; index += 3) {
    red += decoded.data[index]
    green += decoded.data[index + 1]
    blue += decoded.data[index + 2]
  }
  const r = red / count / 255
  const g = green / count / 255
  const b = blue / count / 255
  return { r, g, b, y: 0.2126 * r + 0.7152 * g + 0.0722 * b }
}

interface Decoded {
  data: Buffer
  width: number
  height: number
  fullWidth: number
  fullHeight: number
  developedFrom: DevelopedFrom
  camera?: string
}

async function openImage(filePath: string, maxEdge: number): Promise<Decoded> {
  if (isSensorRaw(filePath)) {
    try {
      const sensor = await decodeSensorRaw(filePath, maxEdge)
      const sized = await fitEdge(sensor.rgb, sensor.width, sensor.height, maxEdge)
      return {
        data: sized.data,
        width: sized.width,
        height: sized.height,
        fullWidth: sensor.fullWidth,
        fullHeight: sensor.fullHeight,
        developedFrom: 'sensor',
        camera: sensor.camera
      }
    } catch {
      // Keine Sensordaten (oder unbekanntes Format): eingebettete Vorschau.
    }
  }
  const raster = await loadRaster(filePath)
  const decoded = await decode(raster.input, maxEdge)
  return {
    ...decoded,
    developedFrom: raster.usedEmbeddedPreview ? 'embedded-preview' : 'raster'
  }
}

async function fitEdge(
  rgb: Buffer,
  width: number,
  height: number,
  maxEdge: number
): Promise<{ data: Buffer; width: number; height: number }> {
  const longEdge = Math.max(width, height)
  if (maxEdge <= 0 || longEdge <= maxEdge) return { data: rgb, width, height }
  const { data, info } = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

async function loadRaster(filePath: string): Promise<{ input: string | Buffer; usedEmbeddedPreview: boolean }> {
  try {
    await sharp(filePath, { failOn: 'none' }).rotate().resize(8, 8, { fit: 'inside' }).raw().toBuffer()
    return { input: filePath, usedEmbeddedPreview: false }
  } catch {
    const file = await readFile(filePath)
    const embedded = extractLargestJpeg(file)
    if (!embedded) {
      throw new Error('Keine lesbare Bilddaten und keine eingebettete Vorschau')
    }
    await sharp(embedded, { failOn: 'none' }).resize(8, 8, { fit: 'inside' }).raw().toBuffer()
    return { input: embedded, usedEmbeddedPreview: true }
  }
}

async function decode(
  input: string | Buffer,
  maxEdge: number
): Promise<Omit<Decoded, 'developedFrom' | 'camera'>> {
  const metadata = await sharp(input, { failOn: 'none' }).metadata()
  let fullWidth = metadata.width ?? 0
  let fullHeight = metadata.height ?? 0
  const orientation = metadata.orientation ?? 1
  if (orientation >= 5 && orientation <= 8) {
    const swap = fullWidth
    fullWidth = fullHeight
    fullHeight = swap
  }
  let pipeline = sharp(input, { failOn: 'none' }).rotate()
  const longEdge = Math.max(fullWidth, fullHeight)
  const edge = maxEdge > 0 ? maxEdge : longEdge > 10000 ? 10000 : 0
  if (edge > 0 && longEdge > edge) {
    pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside' })
  }
  const { data, info } = await pipeline
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) {
    throw new Error('Farbkanäle konnten nicht gelesen werden')
  }
  return {
    data,
    width: info.width,
    height: info.height,
    fullWidth: fullWidth || info.width,
    fullHeight: fullHeight || info.height
  }
}

async function differenceHashFromRgb(pixels: Buffer, width: number, height: number): Promise<string> {
  const { data, info } = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let hash = 0n
  let bit = 0n
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width - 1; x += 1) {
      const left = data[y * info.width + x]
      const right = data[y * info.width + x + 1]
      if (left > right) hash |= 1n << bit
      bit += 1n
    }
  }
  return hashToHex(hash)
}

async function perceptualHashFromRgb(pixels: Buffer, width: number, height: number): Promise<string> {
  const { data, info } = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return perceptualHashFromGray(data, info.width, info.height)
}

function readCaptureTime(file: Buffer): number | null {
  const slice = file.subarray(0, Math.min(file.length, 512 * 1024)).toString('latin1')
  const match = slice.match(/(20\d{2}|19\d{2}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return Number.isFinite(stamp) ? stamp : null
}

function laplacianVariance(pixels: Buffer, width: number, height: number): number {
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const lap =
        4 * pixels[index] - pixels[index - 1] - pixels[index + 1] - pixels[index - width] - pixels[index + width]
      sum += lap
      sumSquares += lap * lap
      count += 1
    }
  }
  if (count === 0) return 0
  const mean = sum / count
  return Math.max(0, sumSquares / count - mean * mean)
}

function measureStats(pixels: Buffer): ImageStats {
  const bins = new Uint32Array(256)
  let red = 0
  let green = 0
  let blue = 0
  let saturation = 0
  let neutralR = 0
  let neutralG = 0
  let neutralB = 0
  let neutralCount = 0
  let midCount = 0
  let meanL = 0
  let meanSquares = 0
  const count = pixels.length / 3

  for (let index = 0; index < pixels.length; index += 3) {
    const r = pixels[index] / 255
    const g = pixels[index + 1] / 255
    const b = pixels[index + 2] / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    meanL += y
    meanSquares += y * y
    bins[Math.min(255, Math.max(0, Math.round(y * 255)))] += 1
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    saturation += sat
    if (y > 0.08 && y < 0.92) {
      red += r
      green += g
      blue += b
      midCount += 1
      if (sat < 0.18) {
        neutralR += r
        neutralG += g
        neutralB += b
        neutralCount += 1
      }
    }
  }

  const mean = count > 0 ? meanL / count : 0
  const variance = count > 0 ? meanSquares / count - mean * mean : 0
  return {
    meanL: mean,
    std: Math.sqrt(Math.max(0, variance)),
    p5: percentile(bins, count, 0.05),
    p95: percentile(bins, count, 0.95),
    meanR: midCount ? red / midCount : 0.5,
    meanG: midCount ? green / midCount : 0.5,
    meanB: midCount ? blue / midCount : 0.5,
    meanSat: count ? saturation / count : 0,
    neutralR: neutralCount ? neutralR / neutralCount : 0.5,
    neutralG: neutralCount ? neutralG / neutralCount : 0.5,
    neutralB: neutralCount ? neutralB / neutralCount : 0.5,
    neutralCount,
    midCount
  }
}

function percentile(bins: Uint32Array, total: number, ratio: number): number {
  const target = Math.max(1, Math.round(total * ratio))
  let seen = 0
  for (let index = 0; index < bins.length; index += 1) {
    seen += bins[index]
    if (seen >= target) return index / 255
  }
  return 1
}

async function renderDecoded(
  decoded: Decoded,
  edits: EditParams,
  format: 'jpeg' | 'png',
  quality: number
): Promise<RenderResult> {
  const colored = applyColor(decoded.data, edits)
  const detailed = await applyDetail(colored.pixels, decoded.width, decoded.height, edits)
  const pipeline = sharp(detailed, {
    raw: { width: decoded.width, height: decoded.height, channels: 3 }
  })
  const buffer =
    format === 'png'
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: clampInt(quality, 40, 100), mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer()
  return {
    buffer,
    width: decoded.width,
    height: decoded.height,
    histogram: colored.histogram,
    mime: format === 'png' ? 'image/png' : 'image/jpeg'
  }
}

function applyColor(pixels: Buffer, edits: EditParams): { pixels: Buffer; histogram: number[] } {
  const lutR = buildChannelLut(edits, 'r')
  const lutG = buildChannelLut(edits, 'g')
  const lutB = buildChannelLut(edits, 'b')
  const output = Buffer.allocUnsafe(pixels.length)
  const histogram = new Array<number>(48).fill(0)
  const satMul = edits.saturation / 100
  const vib = edits.vibrance / 100

  for (let index = 0; index < pixels.length; index += 3) {
    let r = lutR[pixels[index]] / 255
    let g = lutG[pixels[index + 1]] / 255
    let b = lutB[pixels[index + 2]] / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const dr = r - y
    const dg = g - y
    const db = b - y
    const pixSat = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / 0.42)
    const skin = skinWeight(r, g, b)
    const factor = Math.max(0, 1 + satMul * (1 - skin * 0.65) + vib * (1 - pixSat) * 0.85 * (1 - skin))
    r = clamp01(y + dr * factor)
    g = clamp01(y + dg * factor)
    b = clamp01(y + db * factor)
    output[index] = Math.round(r * 255)
    output[index + 1] = Math.round(g * 255)
    output[index + 2] = Math.round(b * 255)
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    histogram[Math.min(47, Math.max(0, Math.round(lum * 47)))] += 1
  }

  const peak = histogram.reduce((max, value) => Math.max(max, value), 1)
  return {
    pixels: output,
    histogram: histogram.map((value) => value / peak)
  }
}

function buildChannelLut(edits: EditParams, channel: 'r' | 'g' | 'b'): Uint8ClampedArray {
  const temperature = edits.temperature / 100
  const tint = edits.tint / 100
  const exposure = Math.pow(2, edits.exposure)
  let gain = exposure
  if (channel === 'r') gain *= (1 + temperature * 0.5) * (1 + Math.max(0, tint) * 0.08)
  if (channel === 'g') gain *= 1 - tint * 0.2
  if (channel === 'b') gain *= (1 - temperature * 0.5) * (1 + Math.max(0, tint) * 0.08)
  if (tint < 0 && channel !== 'g') gain *= 1 + tint * 0.04
  const shadow = edits.shadows / 100
  const highlight = edits.highlights / 100
  const contrast = 1 + edits.contrast / 100
  const lut = new Uint8ClampedArray(256)
  for (let value = 0; value < 256; value += 1) {
    let linear = LINEAR[value] * gain
    linear = clamp01(linear)
    let encoded = linearToSrgb(linear)
    encoded = encoded + shadow * Math.pow(1 - encoded, 2) * 0.75
    encoded = encoded + highlight * encoded * encoded * 0.7
    if (highlight < 0 && encoded > 0.6) {
      const span = 1 - 0.6
      const t = (encoded - 0.6) / span
      const recovered = 0.6 + (1 - Math.pow(1 - clamp01(t), 1 + -highlight * 0.9)) * span
      encoded = encoded * 0.4 + recovered * 0.6
    }
    encoded = (clamp01(encoded) - 0.5) * contrast + 0.5
    lut[value] = Math.round(clamp01(encoded) * 255)
  }
  return lut
}

async function applyDetail(pixels: Buffer, width: number, height: number, edits: EditParams): Promise<Buffer> {
  const clarity = (edits.clarity ?? 0) / 100
  const sharpen = edits.sharpen / 100
  const noise = edits.noise / 100
  if (Math.abs(clarity) < 0.005 && sharpen < 0.005 && noise < 0.005) return pixels
  const sigma = Math.max(0.7, Math.min(2.2, Math.min(width, height) / 800))
  const blurred = await sharp(pixels, { raw: { width, height, channels: 3 } }).blur(sigma).raw().toBuffer()
  const output = Buffer.allocUnsafe(pixels.length)
  for (let index = 0; index < pixels.length; index += 3) {
    const r = pixels[index] / 255
    const g = pixels[index + 1] / 255
    const b = pixels[index + 2] / 255
    const br = blurred[index] / 255
    const bg = blurred[index + 1] / 255
    const bb = blurred[index + 2] / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const yb = 0.2126 * br + 0.7152 * bg + 0.0722 * bb
    const detail = y - yb
    const edge = Math.min(1, Math.abs(detail) / 0.07)
    const midtone = 1 - Math.min(1, Math.abs(y - 0.45) * 1.5)
    const delta =
      detail * (clarity * 0.8 * (0.4 + 0.6 * midtone) + sharpen * 0.95 * edge) - detail * noise * 0.85 * (1 - edge)
    const scale = y > 0.002 ? clamp01(y + delta) / y : 1
    output[index] = Math.round(clamp01(r * scale) * 255)
    output[index + 1] = Math.round(clamp01(g * scale) * 255)
    output[index + 2] = Math.round(clamp01(b * scale) * 255)
  }
  return output
}

function skinWeight(red: number, green: number, blue: number): number {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  if (delta < 0.045 || max === 0) return 0
  let hue = 0
  if (max === red) hue = ((green - blue) / delta) % 6
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  if (hue < 0) hue += 6
  const hueUnit = hue / 6
  const saturation = delta / max
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  const skinHue = hueUnit < 0.11 || hueUnit > 0.97
  if (!skinHue || saturation < 0.14 || saturation > 0.72 || luminance < 0.2 || luminance > 0.9) return 0
  return 0.72
}

function linearToSrgb(value: number): number {
  if (value <= 0.0031308) return 12.92 * value
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
