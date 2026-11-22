import type { EditParams } from './types'

const LINEAR = new Float32Array(256)
for (let value = 0; value < 256; value += 1) {
  const channel = value / 255
  LINEAR[value] = channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
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

export function buildChannelLut(edits: EditParams, channel: 'r' | 'g' | 'b'): Uint8ClampedArray {
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
  const whites = (edits.whites ?? 0) / 100
  const blacks = (edits.blacks ?? 0) / 100
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
    // Weiß: verschiebt den hellen Endpunkt, Schwarz den dunklen.
    encoded = clamp01(encoded)
    encoded = encoded + whites * 0.22 * encoded * encoded
    encoded = encoded + blacks * 0.2 * Math.pow(1 - clamp01(encoded), 3)
    lut[value] = Math.round(clamp01(encoded) * 255)
  }
  return lut
}
