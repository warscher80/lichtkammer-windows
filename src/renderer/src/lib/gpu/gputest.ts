import { GpuEngine, type RawPhoto } from './engine'
import type { EditParams } from '../../../../shared/types'

interface TestApi {
  gpuTestNext: () => Promise<{
    name: string
    edits: EditParams
    ignoreCrop: boolean
    raw: RawPhoto
    outWidth: number
    outHeight: number
  } | null>
  gpuTestInfo: (info: Record<string, unknown>) => Promise<void>
  gpuTestSubmit: (pixels: Uint8Array, ms: number) => Promise<void>
}

/** Läuft statt der Oberfläche, wenn die App mit --gpu-test gestartet wurde (Hash #gputest). */
export async function runGpuTest(): Promise<void> {
  const api = window.api as unknown as TestApi
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const engine = GpuEngine.create(canvas)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await api.gpuTestInfo({ renderer: engine ? engine.renderer : 'kein WebGL2' })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  for (;;) {
    const item = await api.gpuTestNext()
    if (!item) break
    if (!engine) {
      await api.gpuTestSubmit(new Uint8Array(0), 0)
      continue
    }
    const started = performance.now()
    const pixels = engine.renderForTest(item.raw, item.edits, item.ignoreCrop, item.outWidth, item.outHeight)
    await api.gpuTestSubmit(pixels, performance.now() - started)
  }
  document.body.textContent = 'fertig'
}
