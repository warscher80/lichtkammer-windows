import type { CropRect, EditParams } from '../../shared/types'

/** Größe nach Drehung in 90°-Schritten. */
export function rotatedSize(width: number, height: number, rotate: number): { width: number; height: number } {
  return rotate % 180 === 0 ? { width, height } : { width: height, height: width }
}

/**
 * Größter achsparalleler Ausschnitt mit gleichem Seitenverhältnis, der nach dem
 * Begradigen um `degrees` vollständig im Bild liegt (keine schwarzen Ecken).
 */
export function straightenScale(width: number, height: number, degrees: number): number {
  const theta = (Math.abs(degrees) * Math.PI) / 180
  if (theta < 1e-6) return 1
  const ratio = Math.max(width / height, height / width)
  return 1 / (Math.cos(theta) + Math.sin(theta) * ratio)
}

export interface ExtractRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Ausschnitt in Pixeln aus dem um (rotate + straighten) gedrehten, vergrößerten Bild.
 * canvasWidth/Height sind die Maße nach sharp.rotate(angle).
 */
export function geometryExtract(options: {
  baseWidth: number
  baseHeight: number
  canvasWidth: number
  canvasHeight: number
  straighten: number
  crop: CropRect | null
}): ExtractRect {
  const scale = straightenScale(options.baseWidth, options.baseHeight, options.straighten)
  const innerWidth = options.baseWidth * scale
  const innerHeight = options.baseHeight * scale
  const innerLeft = (options.canvasWidth - innerWidth) / 2
  const innerTop = (options.canvasHeight - innerHeight) / 2
  const crop = options.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  let left = Math.round(innerLeft + crop.x * innerWidth)
  let top = Math.round(innerTop + crop.y * innerHeight)
  let width = Math.round(crop.w * innerWidth)
  let height = Math.round(crop.h * innerHeight)
  left = Math.min(Math.max(0, left), options.canvasWidth - 1)
  top = Math.min(Math.max(0, top), options.canvasHeight - 1)
  width = Math.max(1, Math.min(width, options.canvasWidth - left))
  height = Math.max(1, Math.min(height, options.canvasHeight - top))
  return { left, top, width, height }
}

export function needsGeometry(edits: EditParams, ignoreCrop: boolean): boolean {
  return edits.rotate % 360 !== 0 || Math.abs(edits.straighten) > 0.05 || (!ignoreCrop && edits.crop !== null)
}

// MARK: - Farben (HSL)

const BAND_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300, 360]

export function bandValue(values: number[], hue: number): number {
  let h = hue % 360
  if (h < 0) h += 360
  for (let index = 0; index < 8; index += 1) {
    if (h >= BAND_CENTERS[index] && h < BAND_CENTERS[index + 1]) {
      let t = (h - BAND_CENTERS[index]) / (BAND_CENTERS[index + 1] - BAND_CENTERS[index])
      t = t * t * (3 - 2 * t)
      return values[index] * (1 - t) + values[(index + 1) % 8] * t
    }
  }
  return values[0]
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** HSL-Verschiebung für ein Pixel (Werte 0–1), wie in der iPhone-App. Schreibt in `out`. */
export function adjustHsl(
  r: number,
  g: number,
  b: number,
  hueValues: number[],
  satValues: number[],
  lumValues: number[],
  out: number[]
): void {
  const maxC = Math.max(r, g, b)
  const minC = Math.min(r, g, b)
  let l = (maxC + minC) / 2
  const d = maxC - minC
  if (d < 0.000001) {
    out[0] = r
    out[1] = g
    out[2] = b
    return
  }
  let s = l > 0.5 ? d / (2 - maxC - minC) : d / (maxC + minC)
  let h: number
  if (maxC === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (maxC === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  const gate = smoothstep(0.03, 0.18, s)
  if (gate <= 0) {
    out[0] = r
    out[1] = g
    out[2] = b
    return
  }
  const hueShift = (bandValue(hueValues, h) / 100) * 30
  const satShift = bandValue(satValues, h) / 100
  const lumShift = bandValue(lumValues, h) / 100
  h += hueShift * gate
  if (h < 0) h += 360
  if (h >= 360) h -= 360
  s *= 1 + satShift * gate
  if (lumShift > 0) l += lumShift * 0.4 * gate * (1 - l) * s
  else l += lumShift * 0.4 * gate * l * s
  s = Math.min(1, Math.max(0, s))
  l = Math.min(1, Math.max(0, l))
  hslToRgb(h, s, l, out)
}

function hslToRgb(h: number, s: number, l: number, out: number[]): void {
  if (s < 0.000001) {
    out[0] = l
    out[1] = l
    out[2] = l
    return
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = h / 360
  out[0] = channel(p, q, hk + 1 / 3)
  out[1] = channel(p, q, hk)
  out[2] = channel(p, q, hk - 1 / 3)
}

function channel(p: number, q: number, t0: number): number {
  let t = t0
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 0.5) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

// MARK: - Himmel

/**
 * Grobe Himmelsmaske wie in der iPhone-App: blaue oder hellgraue, glatte Flächen,
 * die vom oberen Rand aus zusammenhängen. Gibt Werte 0–255 in der kleinen Größe zurück.
 */
export function skyMask(rgb: Buffer | Uint8Array, width: number, height: number): Uint8Array | null {
  const count = width * height
  const luma = new Float32Array(count)
  const candidate = new Uint8Array(count)
  const blueLimit = Math.floor(height * 0.85)
  const greyLimit = Math.floor(height / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      const r = rgb[i * 3] / 255
      const g = rgb[i * 3 + 1] / 255
      const b = rgb[i * 3 + 2] / 255
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      luma[i] = l
      const maxC = Math.max(r, g, b)
      const minC = Math.min(r, g, b)
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0
      const blue = b > r * 1.08 && b >= g * 0.9 && l > 0.3 && sat > 0.1 && y < blueLimit
      const grey = l > 0.68 && sat < 0.14 && y < greyLimit
      candidate[i] = blue || grey ? 1 : 0
    }
  }
  if (width > 2 && height > 2) {
    const smooth = new Uint8Array(candidate)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x
        if (!candidate[i]) continue
        const lap = Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width])
        if (lap > 0.08) smooth[i] = 0
      }
    }
    candidate.set(smooth)
  }
  const visited = new Uint8Array(count)
  const queue = new Int32Array(count)
  let tail = 0
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < Math.min(2, height); y += 1) {
      const i = y * width + x
      if (candidate[i] && !visited[i]) {
        visited[i] = 1
        queue[tail++] = i
      }
    }
  }
  let head = 0
  while (head < tail) {
    const i = queue[head++]
    const x = i % width
    const y = (i - x) / width
    const neighbors = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]
    for (const n of neighbors) {
      if (n >= 0 && candidate[n] && !visited[n]) {
        visited[n] = 1
        queue[tail++] = n
      }
    }
  }
  if (tail < (count * 3) / 100) return null
  let values: Float32Array = new Float32Array(count)
  for (let index = 0; index < tail; index += 1) values[queue[index]] = 1
  values = boxBlur(values, width, height, 3)
  values = boxBlur(values, width, height, 3)
  const bytes = new Uint8Array(count)
  for (let index = 0; index < count; index += 1) bytes[index] = Math.round(Math.min(1, Math.max(0, values[index])) * 255)
  return bytes
}

function boxBlur(input: Float32Array, width: number, height: number, radius: number): Float32Array {
  const temp = new Float32Array(input.length)
  const output = new Float32Array(input.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let n = 0
      for (let k = -radius; k <= radius; k += 1) {
        const xx = x + k
        if (xx < 0 || xx >= width) continue
        sum += input[y * width + xx]
        n += 1
      }
      temp[y * width + x] = sum / n
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let n = 0
      for (let k = -radius; k <= radius; k += 1) {
        const yy = y + k
        if (yy < 0 || yy >= height) continue
        sum += temp[yy * width + x]
        n += 1
      }
      output[y * width + x] = sum / n
    }
  }
  return output
}
