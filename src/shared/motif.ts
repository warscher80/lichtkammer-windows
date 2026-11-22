/**
 * Motiv-Erkennung auf dem eigenen Rechner (keine Cloud, keine KI-Modelle): aus einem kleinen RGB-Bild wird grob
 * bestimmt, ob es ein Porträt, eine Landschaft oder eine Nachtaufnahme ist, und daraus ein passender Look vorgeschlagen.
 */
export type Motif = 'portrait' | 'landscape' | 'night' | 'other'

export const MOTIF_LABELS: Record<Motif, string> = {
  portrait: 'Porträt',
  landscape: 'Landschaft',
  night: 'Nachtaufnahme',
  other: 'Alltag'
}

/** Look-Kennung je Motiv (siehe shared/looks.ts). */
export const MOTIF_LOOK: Record<Motif, string> = {
  portrait: 'portraet',
  landscape: 'landschaft',
  night: 'nacht',
  other: 'lebendig'
}

export function detectMotif(rgb: Uint8Array | Buffer, width: number, height: number): Motif {
  const total = width * height
  if (total <= 0 || rgb.length < total * 3) return 'other'
  let samples = 0
  let luma = 0
  let dark = 0
  let skin = 0
  let centerSamples = 0
  let centerSkin = 0
  let skyish = 0
  let topSamples = 0
  let green = 0
  const x0 = width * 0.25
  const x1 = width * 0.75
  const y0 = height * 0.2
  const y1 = height * 0.8
  const topEdge = height * 0.4
  const step = Math.max(1, Math.round(Math.sqrt(total / 9000)))
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 3
      const r = rgb[at]
      const g = rgb[at + 1]
      const b = rgb[at + 2]
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      samples += 1
      luma += l
      if (l < 0.12) dark += 1
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const isSkin =
        r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 12 && r > g && r > b && g >= b * 0.85 && l > 0.2 && l < 0.92 && (g - b) / Math.max(1, r - b) < 0.85
      const center = x >= x0 && x < x1 && y >= y0 && y < y1
      if (center) centerSamples += 1
      if (isSkin) {
        skin += 1
        if (center) centerSkin += 1
      }
      if (y < topEdge) {
        topSamples += 1
        if (b > r + 12 && b >= g && l > 0.35) skyish += 1
      }
      if (g > r + 8 && g > b + 8 && l > 0.1) green += 1
    }
  }
  if (samples === 0) return 'other'
  const mean = luma / samples
  const darkShare = dark / samples
  if (mean < 0.24 && darkShare > 0.45) return 'night'
  const skinShare = skin / samples
  const centerShare = centerSamples ? centerSkin / centerSamples : 0
  if ((skinShare > 0.07 || centerShare > 0.12) && skinShare < 0.75) return 'portrait'
  const skyShare = topSamples ? skyish / topSamples : 0
  const greenShare = green / samples
  if (skyShare > 0.22 || greenShare > 0.22 || (width > height * 1.3 && skyShare > 0.1)) return 'landscape'
  return 'other'
}
