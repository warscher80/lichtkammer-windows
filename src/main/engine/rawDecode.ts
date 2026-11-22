import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { FlashRaw as FlashRawHandle } from 'flashraw'

/** Formate, die aus den Sensordaten entwickelt werden, nicht aus der JPEG-Vorschau. */
export const SENSOR_RAW_EXTENSIONS = new Set([
  '.cr2',
  '.cr3',
  '.nef',
  '.nrw',
  '.arw',
  '.srf',
  '.sr2',
  '.dng',
  '.raf',
  '.orf',
  '.ori',
  '.rw2',
  '.pef',
  '.srw'
])

export function isSensorRaw(filePath: string): boolean {
  return SENSOR_RAW_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export interface SensorImage {
  rgb: Buffer
  width: number
  height: number
  fullWidth: number
  fullHeight: number
  camera: string
}

interface FlashModule {
  FlashRaw: {
    open(input: string | Buffer, options?: { init?: { threads?: boolean } }): Promise<FlashRawHandle>
  }
}

let flashModule: Promise<FlashModule> | null = null

function loadFlashRaw(): Promise<FlashModule> {
  if (!flashModule) {
    process.env.FLASHRAW_WASM_THREADS = '0'
    flashModule = import('flashraw') as Promise<FlashModule>
  }
  return flashModule
}

/**
 * Entwickelt eine RAW-Datei aus den Sensordaten (Demosaik, Kamera-Weißabgleich, sRGB).
 * Kleine Kanten nutzen 2×2-Binning, der Export die volle Auflösung.
 */
export async function decodeSensorRaw(filePath: string, maxEdge: number, file?: Buffer): Promise<SensorImage> {
  const { FlashRaw } = await loadFlashRaw()
  const raw = await FlashRaw.open(file ?? (await readFile(filePath)), { init: { threads: false } })
  try {
    const fullWidth = raw.metadata.width
    const fullHeight = raw.metadata.height
    const longEdge = Math.max(fullWidth, fullHeight)
    const target = maxEdge > 0 ? maxEdge : Math.min(longEdge, 10000)
    const halfIsEnough = target <= longEdge / 2
    const frame = await raw.decode({
      output: 'rgba8',
      demosaic: halfIsEnough ? 'half-size' : 'bilinear',
      whiteBalance: 'as-shot',
      highlights: 'blend',
      backend: 'cpu',
      noiseReduction: 'low'
    })
    if (frame.source !== 'sensor') {
      throw new Error('Dekodierung lieferte nur die eingebettete Vorschau')
    }
    const rgb = dropAlpha(frame.data, frame.width, frame.height)
    return {
      rgb,
      width: frame.width,
      height: frame.height,
      fullWidth,
      fullHeight,
      camera: raw.metadata.camera?.name ?? raw.metadata.camera?.model ?? ''
    }
  } finally {
    raw.close()
  }
}

function dropAlpha(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Buffer {
  const rgb = Buffer.allocUnsafe(width * height * 3)
  let target = 0
  for (let index = 0; index < data.length; index += 4) {
    rgb[target] = data[index]
    rgb[target + 1] = data[index + 1]
    rgb[target + 2] = data[index + 2]
    target += 3
  }
  return rgb
}
