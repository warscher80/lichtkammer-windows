import { GpuEngine } from './engine'

let engine: GpuEngine | null | undefined
let canvas: HTMLCanvasElement | null = null

/** Die eine Grafikkarten-Vorschau der App (bleibt beim Wechsel zwischen Ansichten erhalten). */
export function getEngine(): { engine: GpuEngine; canvas: HTMLCanvasElement } | null {
  if (engine === undefined) {
    canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    canvas.dataset.gpuCanvas = '1'
    try {
      engine = GpuEngine.create(canvas)
    } catch {
      engine = null
    }
  }
  if (!engine || !canvas) return null
  if (engine.pipeline.lost) {
    // Grafikkontext verloren: beim nächsten Mal Rückfall auf den alten Weg.
    return null
  }
  return { engine, canvas }
}
