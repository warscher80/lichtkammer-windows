import { buildChannelLut } from '../../../../shared/color'
import { geometryExtract, needsGeometry, rotatedSize } from '../../../../shared/develop'
import { effectiveEdits, monochromeAmount } from '../../../../shared/looks'
import { hasColorWork, type EditParams } from '../../../../shared/types'

/** Alles, was die Grafikkarte für ein Bild braucht (aus den Reglern berechnet). */
export interface GpuParams {
  /** 256 × RGBA: Kennlinien rot/grün/blau (Byte). */
  lut: Uint8Array
  satMul: number
  vib: number
  keep: number
  hsl: boolean
  hue: number[]
  sat: number[]
  lum: number[]
  sky: boolean
  /** Spiegelung der Rotation Ausgabe → Quelle (Spaltenreihenfolge für mat2). */
  rot: [number, number, number, number]
  /** Ecke des Ausschnitts auf der gedrehten Leinwand, bezogen auf deren Mitte (Pixel), und seine Größe. */
  origin: [number, number]
  extent: [number, number]
  /** Größe des Ergebnisbilds in Quellpixeln. */
  outWidth: number
  outHeight: number
  clarity: number
  sharpen: number
  noise: number
  detail: boolean
  /** Schlüssel der Geometrie (Himmelsmaske neu berechnen, wenn er sich ändert). */
  geoKey: string
}

export function buildGpuParams(edits: EditParams, srcWidth: number, srcHeight: number, ignoreCrop = false): GpuParams {
  const effective = effectiveEdits(edits)
  const mono = monochromeAmount(edits)
  const lutR = buildChannelLut(effective, 'r')
  const lutG = buildChannelLut(effective, 'g')
  const lutB = buildChannelLut(effective, 'b')
  const lut = new Uint8Array(256 * 4)
  for (let index = 0; index < 256; index += 1) {
    lut[index * 4] = lutR[index]
    lut[index * 4 + 1] = lutG[index]
    lut[index * 4 + 2] = lutB[index]
    lut[index * 4 + 3] = 255
  }
  const geo = geometryParams(effective, srcWidth, srcHeight, ignoreCrop)
  const clarity = (effective.clarity ?? 0) / 100
  const sharpen = effective.sharpen / 100
  const noise = effective.noise / 100
  return {
    lut,
    satMul: effective.saturation / 100,
    vib: effective.vibrance / 100,
    keep: 1 - Math.min(1, Math.max(0, mono)),
    hsl: hasColorWork(effective),
    hue: effective.hslHue,
    sat: effective.hslSat,
    lum: effective.hslLum,
    sky: effective.skyEnhance,
    ...geo,
    clarity,
    sharpen,
    noise,
    detail: !(Math.abs(clarity) < 0.005 && sharpen < 0.005 && noise < 0.005)
  }
}

/** Ergebnisgröße (in Quellpixeln) einer Bearbeitung, ohne zu rechnen. */
export function outputSize(edits: EditParams, srcWidth: number, srcHeight: number, ignoreCrop = false): { width: number; height: number } {
  const geo = geometryParams(effectiveEdits(edits), srcWidth, srcHeight, ignoreCrop)
  return { width: geo.outWidth, height: geo.outHeight }
}

function geometryParams(
  edits: EditParams,
  srcWidth: number,
  srcHeight: number,
  ignoreCrop: boolean
): Pick<GpuParams, 'rot' | 'origin' | 'extent' | 'outWidth' | 'outHeight' | 'geoKey'> {
  if (!needsGeometry(edits, ignoreCrop)) {
    return {
      rot: [1, 0, 0, 1],
      origin: [-srcWidth / 2, -srcHeight / 2],
      extent: [srcWidth, srcHeight],
      outWidth: srcWidth,
      outHeight: srcHeight,
      geoKey: 'id'
    }
  }
  // Wie die CPU: Bild um (rotate + straighten) drehen (Leinwand = gerundete Hüllgröße wie bei sharp),
  // danach den ganzzahligen Ausschnitt aus geometryExtract nehmen.
  const base = rotatedSize(srcWidth, srcHeight, edits.rotate)
  const angleDeg = edits.rotate + edits.straighten
  const theta = (angleDeg * Math.PI) / 180
  let canvasWidth = srcWidth
  let canvasHeight = srcHeight
  if (Math.abs(angleDeg % 360) > 0.001) {
    canvasWidth = Math.round(Math.abs(srcWidth * Math.cos(theta)) + Math.abs(srcHeight * Math.sin(theta)))
    canvasHeight = Math.round(Math.abs(srcWidth * Math.sin(theta)) + Math.abs(srcHeight * Math.cos(theta)))
  }
  const rect = geometryExtract({
    baseWidth: base.width,
    baseHeight: base.height,
    canvasWidth,
    canvasHeight,
    straighten: edits.straighten,
    crop: ignoreCrop ? null : edits.crop
  })
  // Quelle = R(-angle) · Leinwandposition (y nach unten, Drehung im Uhrzeigersinn positiv wie bei sharp).
  const c = Math.cos(-theta)
  const s = Math.sin(-theta)
  // mat2 in GLSL ist spaltenweise: [m00, m10, m01, m11]
  const rot: [number, number, number, number] = [c, s, -s, c]
  return {
    rot,
    origin: [rect.left - canvasWidth / 2, rect.top - canvasHeight / 2],
    extent: [rect.width, rect.height],
    outWidth: rect.width,
    outHeight: rect.height,
    geoKey: JSON.stringify([edits.rotate, edits.straighten, ignoreCrop ? null : edits.crop])
  }
}

/** Weichzeichner-Radius der Details, wie auf der CPU aus der Bildgröße. */
export function detailSigma(width: number, height: number): number {
  return Math.max(0.7, Math.min(2.2, Math.min(width, height) / 800))
}

// Damit geometryExtract (CPU) und die Grafikkarte gleich gerundet werden, wird sie hier mit exportiert.
export { geometryExtract }
