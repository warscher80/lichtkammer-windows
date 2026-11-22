import { LOOKS } from '../../../../shared/looks'
import { editKey, type EditParams } from '../../../../shared/types'
import { GpuPipeline, type SourceTexture } from './pipeline'
import { buildGpuParams, detailSigma, outputSize, type GpuParams } from './params'

export interface RawPhoto {
  data: Uint8Array
  width: number
  height: number
  fullWidth: number
  fullHeight: number
}

export interface EngineState {
  id: string | null
  edits: EditParams
  ignoreCrop: boolean
  /** Bühne in CSS-Pixeln. */
  stageWidth: number
  stageHeight: number
  /** Bildrahmen in CSS-Pixeln (links, oben, Breite, Höhe). */
  box: [number, number, number, number]
  zoom: number
  pan: [number, number]
  /** Vorher/Nachher-Trennlinie in CSS-Pixeln (-1 = aus). */
  splitX: number
  original: boolean
}

export interface EngineInfo {
  width: number
  height: number
  fullWidth: number
  fullHeight: number
  /** true, solange nur die kleine Platzhalter-Vorschau da ist. */
  provisional: boolean
}

interface Entry {
  source: SourceTexture
  used: number
}

declare global {
  interface Window {
    __lkPerf?: boolean
    __lkFrameDone?: (sharp?: boolean) => void
  }
}

const MAX_TEXTURES = 5
const TINY_EDGE = 640

/** Holt ein Foto roh aus dem Hauptprozess (RGB, 8 Bit). */
async function fetchRaw(id: string, edge: number, purpose: string): Promise<RawPhoto | null> {
  const response = await fetch(`lkraw://photo/${encodeURIComponent(id)}?edge=${edge}&p=${purpose}`)
  if (!response.ok) return null
  const width = Number(response.headers.get('x-lk-width'))
  const height = Number(response.headers.get('x-lk-height'))
  const fullWidth = Number(response.headers.get('x-lk-full-width')) || width
  const fullHeight = Number(response.headers.get('x-lk-full-height')) || height
  const data = new Uint8Array(await response.arrayBuffer())
  if (!width || !height || data.length < width * height * 3) return null
  return { data, width, height, fullWidth, fullHeight }
}

/**
 * Die Grafikkarten-Vorschau: besitzt die Zeichenfläche, hält Foto-Texturen im Speicher (Nachbarn vorgeladen)
 * und zeichnet bei jeder Änderung sofort neu.
 */
export class GpuEngine {
  readonly pipeline: GpuPipeline
  private canvas: HTMLCanvasElement
  private textures = new Map<string, Entry>()
  private raws = new Map<string, RawPhoto>()
  private inflight = new Map<string, Promise<RawPhoto | null>>()
  private state: EngineState | null = null
  private current: { id: string; source: SourceTexture; provisional: boolean } | null = null
  private params: { key: string; params: GpuParams } | null = null
  private sky: { key: string; texture: WebGLTexture | null } | null = null
  private scale = 1
  private dragging = false
  private rafHandle = 0
  private lastDraw = 0
  private idleTimer = 0
  private histogramTimer = 0
  private lastHistogram = 0
  private clock = 0
  private fitEdge = 2048
  private neighbours: string[] = []
  onInfo: (info: EngineInfo) => void = () => undefined
  onHistogram: (bins: number[]) => void = () => undefined
  lastInfo: EngineInfo | null = null
  drawMs = 0

  static create(canvas: HTMLCanvasElement): GpuEngine | null {
    const pipeline = GpuPipeline.create(canvas)
    return pipeline ? new GpuEngine(pipeline, canvas) : null
  }

  private constructor(pipeline: GpuPipeline, canvas: HTMLCanvasElement) {
    this.pipeline = pipeline
    this.canvas = canvas
  }

  get renderer(): string {
    return this.pipeline.renderer
  }

  /** Zeichnet gerade etwas Teures (Regler wird gezogen): bei Bedarf in geringerer Auflösung rechnen. */
  setDragging(value: boolean): void {
    if (this.dragging === value) return
    this.dragging = value
    if (!value) this.scheduleIdle()
  }

  setNeighbours(ids: string[]): void {
    this.neighbours = ids
    this.prefetch()
  }

  private editionKey(): string {
    const state = this.state
    if (!state) return ''
    return `${editKey(state.edits)}|${state.ignoreCrop ? 1 : 0}`
  }

  /** Neuen Zustand setzen (Foto, Regler, Ansicht) und sofort zeichnen. */
  update(state: EngineState): void {
    const previous = this.state
    this.state = state
    this.fitEdge = fitEdgeFor(state.stageWidth, state.stageHeight)
    if (!previous || previous.id !== state.id) this.select(state.id)
    else if (state.zoom > 1.25 && this.needsBig()) void this.loadBig(state.id)
    this.requestDraw()
  }

  private select(id: string | null): void {
    this.params = null
    this.sky = null
    if (!id) {
      this.current = null
      return
    }
    const cached = this.takeTexture(id, Math.round(this.fitEdge * 0.75)) ?? this.fromRaw(id, this.fitEdge)
    if (cached) {
      this.current = { id, source: cached, provisional: false }
      this.announce()
      this.prefetch()
    } else {
      // Platzhalter sofort, danach die volle Bildschirmgröße.
      this.current = this.current && this.current.id === id ? this.current : null
      void this.loadTiny(id)
      void this.loadFit(id)
    }
  }

  private announce(): void {
    const state = this.state
    const current = this.current
    if (!state || !current) return
    const size = outputSize(state.edits, current.source.width, current.source.height, state.ignoreCrop)
    const info: EngineInfo = {
      width: size.width,
      height: size.height,
      fullWidth: current.source.fullWidth,
      fullHeight: current.source.fullHeight,
      provisional: current.provisional
    }
    const last = this.lastInfo
    if (!last || last.width !== info.width || last.height !== info.height || last.provisional !== info.provisional) {
      this.lastInfo = info
      this.onInfo(info)
    }
  }

  private key(id: string, edge: number): string {
    return `${id}@${edge}`
  }

  /** Vorhandene Textur mit mindestens dieser Kantenlänge (Schlüssel `id@Kante`). */
  private takeTexture(id: string, minEdge: number): SourceTexture | null {
    let best: Entry | null = null
    for (const [key, entry] of this.textures) {
      if (!key.startsWith(`${id}@`)) continue
      if (Number(key.slice(id.length + 1)) < minEdge) continue
      if (!best || entry.source.width > best.source.width) best = entry
    }
    if (!best) return null
    this.clock += 1
    best.used = this.clock
    return best.source
  }

  private fromRaw(id: string, edge: number): SourceTexture | null {
    const key = this.key(id, edge)
    const raw = this.raws.get(key)
    if (!raw) return null
    this.raws.delete(key)
    return this.store(id, edge, raw)
  }

  private store(id: string, edge: number, raw: RawPhoto): SourceTexture {
    const source = this.pipeline.upload(raw)
    this.clock += 1
    this.textures.set(this.key(id, edge), { source, used: this.clock })
    while (this.textures.size > MAX_TEXTURES) {
      let oldest: string | null = null
      let age = Infinity
      for (const [key, entry] of this.textures) {
        if (this.current && entry.source === this.current.source) continue
        if (entry.used < age) {
          age = entry.used
          oldest = key
        }
      }
      if (!oldest) break
      const entry = this.textures.get(oldest)
      if (entry) this.pipeline.release(entry.source)
      this.textures.delete(oldest)
    }
    return source
  }

  private request(id: string, edge: number, purpose: string): Promise<RawPhoto | null> {
    const key = `${this.key(id, edge)}|${purpose}`
    const known = this.inflight.get(key)
    if (known) return known
    const promise = fetchRaw(id, edge, purpose)
      .catch(() => null)
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  private async loadTiny(id: string): Promise<void> {
    const raw = await this.request(id, TINY_EDGE, 'tiny')
    if (!raw || !this.state || this.state.id !== id) return
    if (this.current && this.current.id === id && !this.current.provisional) return
    const source = this.store(id, TINY_EDGE, raw)
    this.current = { id, source, provisional: true }
    this.params = null
    this.announce()
    this.requestDraw()
  }

  private async loadFit(id: string): Promise<void> {
    const edge = this.fitEdge
    const raw = await this.request(id, edge, 'main')
    if (!this.state || this.state.id !== id) {
      if (raw) this.raws.set(this.key(id, edge), raw)
      return
    }
    if (!raw) {
      // Überholt (schnell weitergeschaltet) oder Fehler: nur neu holen, wenn dieses Foto noch gebraucht wird.
      if (!this.current || this.current.id !== id || this.current.provisional) {
        window.setTimeout(() => {
          if (this.state?.id === id && (!this.current || this.current.provisional)) void this.loadFit(id)
        }, 120)
      }
      return
    }
    const source = this.store(id, edge, raw)
    this.current = { id, source, provisional: false }
    this.params = null
    this.announce()
    this.requestDraw()
    this.prefetch()
  }

  private needsBig(): boolean {
    const current = this.current
    if (!current || current.provisional) return false
    const have = Math.max(current.source.width, current.source.height)
    const full = Math.max(current.source.fullWidth, current.source.fullHeight)
    return have < Math.min(4096, full) - 8
  }

  private async loadBig(id: string | null): Promise<void> {
    if (!id) return
    const edge = 4096
    let source = this.takeTexture(id, edge)
    if (!source) {
      const raw = await this.request(id, edge, 'big')
      if (!raw || !this.state || this.state.id !== id) return
      source = this.store(id, edge, raw)
    }
    if (this.current && this.current.id === id && this.current.source !== source) {
      this.current = { id, source, provisional: false }
      this.params = null
      this.requestDraw()
    }
  }

  private prefetch(): void {
    if (!this.current || this.current.provisional) return
    for (const id of this.neighbours) {
      if (this.takeTexture(id, Math.round(this.fitEdge * 0.75)) || this.raws.has(this.key(id, this.fitEdge))) continue
      const edge = this.fitEdge
      void this.request(id, edge, 'prefetch').then((raw) => {
        if (!raw) return
        this.raws.set(this.key(id, edge), raw)
        while (this.raws.size > 4) {
          const first = this.raws.keys().next().value
          if (first === undefined) break
          this.raws.delete(first)
        }
      })
    }
  }

  /** Eine Neuzeichnung anfordern. Ohne laufende Frames sofort, sonst im nächsten Bild gebündelt. */
  requestDraw(): void {
    const now = performance.now()
    if (this.rafHandle === 0 && now - this.lastDraw > 12 && !this.dragging) {
      this.drawNow()
      return
    }
    if (this.rafHandle !== 0) return
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0
      this.drawNow()
    })
  }

  private scheduleIdle(): void {
    window.clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => {
      if (this.scale !== 1) {
        this.scale = 1
        this.requestDraw()
      }
    }, 180)
  }

  private currentParams(): GpuParams | null {
    const state = this.state
    const current = this.current
    if (!state || !current) return null
    const key = `${this.editionKey()}|${current.source.width}x${current.source.height}`
    if (!this.params || this.params.key !== key) {
      this.params = { key, params: buildGpuParams(state.edits, current.source.width, current.source.height, state.ignoreCrop) }
    }
    return this.params.params
  }

  /** Himmelsmaske für das aktuelle Foto und die aktuelle Geometrie (nur wenn „Himmel verbessern“ gebraucht wird). */
  private skyFor(params: GpuParams): WebGLTexture | null {
    const current = this.current
    if (!current || !params.sky) return null
    const key = `${current.id}|${current.source.width}|${params.geoKey}`
    if (!this.sky || this.sky.key !== key) {
      this.pipeline.deleteTexture(this.sky?.texture ?? null)
      this.sky = { key, texture: this.pipeline.buildSky(current.source, params) }
    }
    return this.sky.texture
  }

  private drawNow(): void {
    const state = this.state
    const current = this.current
    if (!state || !current || this.pipeline.lost) return
    const params = this.currentParams()
    if (!params) return
    const started = performance.now()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let factor = dpr * this.scale
    // Sehr große Bühnen (4K) nicht größer als nötig rechnen.
    const longest = Math.max(state.stageWidth, state.stageHeight) * factor
    if (longest > 2800) factor *= 2800 / longest
    const width = Math.max(2, Math.round(state.stageWidth * factor))
    const height = Math.max(2, Math.round(state.stageHeight * factor))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    const ratio = width / Math.max(1, state.stageWidth)
    const box: [number, number, number, number] = [state.box[0] * ratio, state.box[1] * ratio, state.box[2] * ratio, state.box[3] * ratio]
    const displayed = box[2] * state.zoom
    const exportSize = outputSize(state.edits, current.source.fullWidth, current.source.fullHeight, state.ignoreCrop)
    const sigmaFull = detailSigma(exportSize.width, exportSize.height)
    const sigma = Math.max(0.6, Math.min(2.6, (sigmaFull * displayed) / Math.max(1, exportSize.width)))
    this.pipeline.draw({
      src: current.source,
      params,
      width,
      height,
      view: { box, zoom: state.zoom, pan: [state.pan[0] * ratio, state.pan[1] * ratio] },
      splitX: state.splitX >= 0 ? state.splitX * ratio : undefined,
      original: state.original,
      skyTexture: this.skyFor(params),
      sigma
    })
    if (window.__lkPerf || this.dragging) this.pipeline.finish()
    const cost = performance.now() - started
    this.drawMs = cost
    this.lastDraw = performance.now()
    if (this.dragging) {
      // Zu langsam (Software-Grafik): während des Ziehens gröber rechnen, danach wieder scharf.
      if (cost > 34 && this.scale > 0.45) this.scale = Math.max(0.45, this.scale * 0.78)
      this.scheduleIdle()
    }
    if (window.__lkFrameDone) {
      const sharp = !current.provisional
      requestAnimationFrame(() => window.__lkFrameDone?.(sharp))
    }
    this.scheduleHistogram()
  }

  private scheduleHistogram(): void {
    if (this.histogramTimer) return
    const wait = Math.max(0, (this.dragging ? 200 : 40) - (performance.now() - this.lastHistogram))
    this.histogramTimer = window.setTimeout(() => {
      this.histogramTimer = 0
      this.lastHistogram = performance.now()
      const current = this.current
      const params = this.currentParams()
      if (!current || !params) return
      this.onHistogram(this.pipeline.histogram(current.source, params, this.skyFor(params)))
    }, wait)
  }

  /** Die zwölf Look-Kacheln (jeweils mit den aktuellen Reglern darunter) als ein Bild, oberste Zeile zuerst. */
  renderLookTiles(edits: EditParams, tileWidth: number, tileHeight: number, columns: number): { pixels: Uint8Array; width: number; height: number } | null {
    const current = this.current
    const state = this.state
    if (!current || !state || this.pipeline.lost) return null
    const tiles = LOOKS.map((look) => {
      const base = { ...edits, preset: look.id, presetStrength: 100, sharpen: 0, noise: 0 }
      const params = buildGpuParams(base, current.source.width, current.source.height, false)
      return { params: { ...params, detail: false }, sky: this.skyFor(params) }
    })
    return this.pipeline.renderTiles(current.source, tiles, tileWidth, tileHeight, columns)
  }

  /** Für den Grafikkarten-Vergleich: ein Foto roh hochladen, in genau dieser Größe rechnen und auslesen (RGB). */
  renderForTest(raw: RawPhoto, edits: EditParams, ignoreCrop: boolean, width: number, height: number): Uint8Array {
    const source = this.pipeline.upload(raw)
    try {
      const params = buildGpuParams(edits, source.width, source.height, ignoreCrop)
      const sky = params.sky ? this.pipeline.buildSky(source, params) : null
      this.pipeline.draw({ src: source, params, width, height, skyTexture: sky, sigma: detailSigma(width, height), toTarget: 'test' })
      const rgba = this.pipeline.read('test', width, height)
      this.pipeline.deleteTexture(sky)
      const rgb = new Uint8Array(width * height * 3)
      for (let index = 0, out = 0; index < rgba.length; index += 4, out += 3) {
        rgb[out] = rgba[index]
        rgb[out + 1] = rgba[index + 1]
        rgb[out + 2] = rgba[index + 2]
      }
      return rgb
    } finally {
      this.pipeline.release(source)
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle)
    window.clearTimeout(this.idleTimer)
    window.clearTimeout(this.histogramTimer)
    for (const entry of this.textures.values()) this.pipeline.release(entry.source)
    this.textures.clear()
    this.raws.clear()
  }
}

/** Kantenlänge der Bildschirm-Vorschau, gerastert, damit der Zwischenspeicher trifft. */
function fitEdgeFor(stageWidth: number, stageHeight: number): number {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const wanted = Math.max(stageWidth, stageHeight) * dpr * 1.1
  return Math.min(3072, Math.max(1536, Math.ceil(wanted / 256) * 256))
}
