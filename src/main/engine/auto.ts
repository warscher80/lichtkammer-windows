import { NEUTRAL_EDITS, type EditParams } from '../../shared/types'

export interface ImageStats {
  meanL: number
  std: number
  p5: number
  p95: number
  meanR: number
  meanG: number
  meanB: number
  meanSat: number
  neutralR: number
  neutralG: number
  neutralB: number
  neutralCount: number
  midCount: number
}

export function varianceToScore(variance: number): number {
  // Logarithmische Skala, an den Beispielbildern geeicht:
  // starke Weichzeichnung liegt unter 25, detaillierte Motive meist über 60.
  const score = 20 * Math.log2(variance + 1) - 70
  return clamp(Math.round(score), 0, 100)
}

export function suggestEdits(stats: ImageStats, score: number): EditParams {
  const edits: EditParams = { ...NEUTRAL_EDITS }
  const mean = clamp(stats.meanL, 0.05, 0.9)
  let exposure = 1.7 * Math.log2(0.48 / mean)
  const highlightRoom = clamp((0.94 - stats.p95) * 2.6, 0, 1.15)
  if (exposure > 0) exposure = Math.min(exposure, highlightRoom)
  if (exposure < 0 && stats.p5 < 0.06) exposure *= 0.65
  edits.exposure = Math.round(clamp(exposure, -0.55, 1.15) * 20) / 20

  const neutralReliable = stats.neutralCount > 80 && stats.neutralCount > stats.midCount * 0.1
  const neutralTemperature = temperatureFrom(stats.neutralR, stats.neutralG, stats.neutralB)
  const globalTemperature = temperatureFrom(stats.meanR, stats.meanG, stats.meanB)
  let temperature = neutralReliable ? neutralTemperature : globalTemperature
  const sameDirection = Math.sign(neutralTemperature) === Math.sign(globalTemperature)
  const castLikely =
    stats.meanSat < 0.42 &&
    ((neutralReliable &&
      sameDirection &&
      Math.abs(neutralTemperature) > 0.14 &&
      Math.abs(globalTemperature) > 0.16) ||
      (!neutralReliable && stats.meanSat < 0.32 && Math.abs(globalTemperature) > 0.22))
  if (castLikely) temperature = (neutralReliable ? neutralTemperature : globalTemperature) * 0.95
  else temperature *= 0.62
  if (!castLikely && stats.meanSat > 0.24) {
    temperature *= clamp(1 - (stats.meanSat - 0.24) * 2, 0.15, 1)
  }
  const temperatureCap = castLikely ? 32 : 14
  edits.temperature = clamp(Math.round(temperature * 100), -temperatureCap, temperatureCap)

  const green = castLikely || !neutralReliable ? stats.meanG : stats.neutralG
  const red = castLikely || !neutralReliable ? stats.meanR : stats.neutralR
  const blue = castLikely || !neutralReliable ? stats.meanB : stats.neutralB
  const greenness = green / Math.max((red + blue) / 2, 0.02)
  const tintDamp = castLikely ? 0.7 : neutralReliable ? 0.55 : 0.35
  edits.tint = clamp(Math.round(((greenness - 1) / 0.22) * tintDamp * 100), -24, 24)

  if (stats.std < 0.16) edits.contrast = clamp(Math.round((0.21 - stats.std) * 300), 8, 34)
  else if (stats.std > 0.3) edits.contrast = clamp(Math.round((0.26 - stats.std) * 140), -12, 0)
  else edits.contrast = 3

  if (stats.p5 < 0.07) edits.shadows = clamp(Math.round((0.1 - stats.p5) * 420), 0, 48)
  else edits.shadows = 4

  if (stats.p95 > 0.92) edits.highlights = clamp(-Math.round((stats.p95 - 0.88) * 280), -40, 0)
  else edits.highlights = -3

  if (Math.abs(edits.temperature) >= 12) {
    edits.saturation = 0
    edits.vibrance = 8
  } else if (stats.meanSat < 0.16) {
    edits.saturation = 8
    edits.vibrance = 14
  } else if (stats.meanSat > 0.48) {
    edits.saturation = -2
    edits.vibrance = 4
  } else {
    edits.saturation = 4
    edits.vibrance = 10
  }
  // Klarheit bleibt im Mittelton und wird bei schon knackigen Bildern klein gehalten.
  edits.clarity = score > 82 ? 6 : score > 55 ? 10 : 14
  edits.sharpen = score > 85 ? 8 : score > 55 ? 14 : 20
  edits.noise = score < 36 ? 14 : score < 60 ? 8 : 4
  return edits
}

function temperatureFrom(red: number, green: number, blue: number): number {
  const average = (red + green + blue) / 3
  const ratioR = average / Math.max(red, 0.02)
  const ratioB = average / Math.max(blue, 0.02)
  return ((ratioR - 1) / 0.5 + (1 - ratioB) / 0.5) / 2
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
