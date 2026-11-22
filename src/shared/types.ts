export type PhotoStatus = 'kept' | 'blurry' | 'duplicate'
export type Pin = 'kept' | 'blurry'
export type DevelopedFrom = 'sensor' | 'raster' | 'embedded-preview'

/** Zuschnitt, normiert auf das gedrehte und begradigte Bild (0–1). */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface EditParams {
  exposure: number
  temperature: number
  tint: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  saturation: number
  vibrance: number
  clarity: number
  sharpen: number
  noise: number
  /** Pro Farbbereich (Rot, Orange, Gelb, Grün, Aquamarin, Blau, Lila, Magenta), je -100…100. */
  hslHue: number[]
  hslSat: number[]
  hslLum: number[]
  skyEnhance: boolean
  /** Gewählter Look (Preset), liegt zusätzlich auf den Reglern. */
  preset: string | null
  /** Stärke des Looks, 0–100. */
  presetStrength: number
  /** Drehung in 90°-Schritten. */
  rotate: number
  /** Begradigen in Grad, -45…45. */
  straighten: number
  crop: CropRect | null
}

export type ScalarKey =
  | 'exposure'
  | 'temperature'
  | 'tint'
  | 'contrast'
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  | 'saturation'
  | 'vibrance'
  | 'clarity'
  | 'sharpen'
  | 'noise'

export const SCALAR_KEYS: ScalarKey[] = [
  'exposure',
  'temperature',
  'tint',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'saturation',
  'vibrance',
  'clarity',
  'sharpen',
  'noise'
]

export const BAND_COUNT = 8
export const BAND_NAMES = ['Rot', 'Orange', 'Gelb', 'Grün', 'Aquamarin', 'Blau', 'Lila', 'Magenta']
export const BAND_COLORS = ['#e5484d', '#f08c3a', '#f2d23c', '#4cc35a', '#3cc8c0', '#3b82f6', '#8b5cf6', '#e14bd0']

export interface Settings {
  /** Schärfewert, unter dem ein Foto als unscharf gilt (0–100). */
  blurThreshold: number
  /** Maximaler Hamming-Abstand des dHash (0–64). */
  duplicateDistance: number
}

export interface PhotoRecord {
  id: string
  sourcePath: string
  fileName: string
  ext: string
  fileSize: number
  width: number
  height: number
  /** Laplacian-Varianz auf der Analysegröße. */
  sharpness: number
  /** Anzeige-Schärfe 0–100. */
  sharpnessScore: number
  /** 64-bit dHash, 16 Hex-Zeichen. */
  hash: string
  /** 64-bit pHash (DCT), 16 Hex-Zeichen. */
  pHash?: string
  /** SHA-256 der Datei, für exakte Kopien. */
  contentHash?: string
  /** Aufnahmezeit aus EXIF, Millisekunden, falls vorhanden. */
  capturedAt?: number | null
  status: PhotoStatus
  duplicateOf?: string
  groupId?: string
  pin?: Pin | null
  edits: EditParams
  autoEdits: EditParams
  importedAt: number
  /** Sensordekodierung, normales Bild, oder nur die eingebettete RAW-Vorschau. */
  developedFrom: DevelopedFrom
  usedEmbeddedPreview: boolean
  camera?: string
  /** Bearbeitung, mit der zuletzt gesichert wurde. */
  savedKey?: string | null
}

export interface Catalog {
  version: 1
  settings: Settings
  photos: PhotoRecord[]
}

export interface JobProgress {
  active: boolean
  phase: 'import' | 'export' | 'copy' | 'idle'
  current: number
  total: number
  label: string
}

export interface Notice {
  kind: 'info' | 'error'
  message: string
}

export interface PreviewPayload {
  dataUrl: string
  width: number
  height: number
  histogram: number[]
}

export interface ExportOptions {
  directory: string
  format: 'jpeg' | 'png'
  quality: number
  scope: 'kept' | 'selected'
  selectedId?: string | null
}

export interface ExportResult {
  exported: number
  directory: string
  files: string[]
}

export interface CopyResult {
  copied: number
  blurryDir: string
  duplicateDir: string
}

export const DEFAULT_SETTINGS: Settings = {
  blurThreshold: 32,
  duplicateDistance: 8
}

export function zeroBands(): number[] {
  return new Array<number>(BAND_COUNT).fill(0)
}

export const NEUTRAL_EDITS: EditParams = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 0,
  vibrance: 0,
  clarity: 0,
  sharpen: 0,
  noise: 0,
  hslHue: zeroBands(),
  hslSat: zeroBands(),
  hslLum: zeroBands(),
  skyEnhance: false,
  preset: null,
  presetStrength: 100,
  rotate: 0,
  straighten: 0,
  crop: null
}

export function cloneEdits(edits: EditParams): EditParams {
  return {
    ...edits,
    hslHue: [...edits.hslHue],
    hslSat: [...edits.hslSat],
    hslLum: [...edits.hslLum],
    crop: edits.crop ? { ...edits.crop } : null
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

function bands(value: unknown): number[] {
  const list = Array.isArray(value) ? value : []
  const result = zeroBands()
  for (let index = 0; index < BAND_COUNT; index += 1) {
    result[index] = Math.round(clampNumber(list[index], -100, 100, 0))
  }
  return result
}

/**
 * Macht aus beliebigen (auch alten oder fehlerhaften) Daten gültige Bearbeitungswerte.
 * Ältere Kataloge kennen die neuen Regler nicht: fehlende Werte sind neutral.
 */
export function sanitizeEdits(input: unknown): EditParams {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const next = cloneEdits(NEUTRAL_EDITS)
  next.exposure = Math.round(clampNumber(source.exposure, -3, 3, 0) * 20) / 20
  for (const key of SCALAR_KEYS) {
    if (key === 'exposure') continue
    const min = key === 'sharpen' || key === 'noise' ? 0 : -100
    next[key] = Math.round(clampNumber(source[key], min, 100, 0))
  }
  next.hslHue = bands(source.hslHue)
  next.hslSat = bands(source.hslSat)
  next.hslLum = bands(source.hslLum)
  next.skyEnhance = source.skyEnhance === true
  next.preset = typeof source.preset === 'string' && source.preset.length < 40 ? source.preset : null
  next.presetStrength = Math.round(clampNumber(source.presetStrength, 0, 100, 100))
  const quarter = Math.round(clampNumber(source.rotate, -100000, 100000, 0) / 90)
  next.rotate = (((quarter % 4) + 4) % 4) * 90
  next.straighten = Math.round(clampNumber(source.straighten, -45, 45, 0) * 10) / 10
  const crop = source.crop as Record<string, unknown> | null | undefined
  if (crop && typeof crop === 'object') {
    const x = clampNumber(crop.x, 0, 0.98, 0)
    const y = clampNumber(crop.y, 0, 0.98, 0)
    const w = clampNumber(crop.w, 0.02, 1 - x, 1 - x)
    const h = clampNumber(crop.h, 0.02, 1 - y, 1 - y)
    const round = (value: number): number => Math.round(value * 10000) / 10000
    const full = x < 0.0005 && y < 0.0005 && w > 0.9995 && h > 0.9995
    next.crop = full ? null : { x: round(x), y: round(y), w: round(w), h: round(h) }
  }
  return next
}

/** Kurzer, stabiler Schlüssel für eine Bearbeitung (Vorschau-Cache). */
export function editKey(edits: EditParams): string {
  const text = JSON.stringify([
    SCALAR_KEYS.map((key) => (key === 'exposure' ? edits.exposure.toFixed(2) : edits[key])),
    edits.hslHue,
    edits.hslSat,
    edits.hslLum,
    edits.skyEnhance ? 1 : 0,
    edits.preset ?? '',
    edits.preset ? edits.presetStrength : 100,
    edits.rotate,
    edits.straighten,
    edits.crop
  ])
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36) + text.length.toString(36)
}

export function hasColorWork(edits: EditParams): boolean {
  return (
    edits.hslHue.some((value) => Math.abs(value) > 0.5) ||
    edits.hslSat.some((value) => Math.abs(value) > 0.5) ||
    edits.hslLum.some((value) => Math.abs(value) > 0.5)
  )
}
