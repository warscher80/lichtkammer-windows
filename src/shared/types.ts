export type PhotoStatus = 'kept' | 'blurry' | 'duplicate'
export type Pin = 'kept' | 'blurry'
export type DevelopedFrom = 'sensor' | 'raster' | 'embedded-preview'

export interface EditParams {
  exposure: number
  temperature: number
  tint: number
  contrast: number
  highlights: number
  shadows: number
  saturation: number
  vibrance: number
  clarity: number
  sharpen: number
  noise: number
}

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

export const NEUTRAL_EDITS: EditParams = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  saturation: 0,
  vibrance: 0,
  clarity: 0,
  sharpen: 0,
  noise: 0
}

export function cloneEdits(edits: EditParams): EditParams {
  return { ...edits }
}

export function editKey(edits: EditParams): string {
  return [
    edits.exposure.toFixed(2),
    edits.temperature,
    edits.tint,
    edits.contrast,
    edits.highlights,
    edits.shadows,
    edits.saturation,
    edits.vibrance,
    edits.clarity ?? 0,
    edits.sharpen,
    edits.noise
  ].join(',')
}
