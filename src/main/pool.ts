import { availableParallelism, cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import workerPath from './worker?modulePath'
import { analyzeFile, renderImage, renderLooks, type AnalyzeResult, type RenderResult } from './engine/process'
import type { EditParams } from '../shared/types'

interface AnalyzePayload {
  type: 'analyze'
  filePath: string
}

interface RenderPayload {
  type: 'render'
  filePath: string
  edits: EditParams
  maxEdge: number
  format: 'jpeg' | 'png'
  quality: number
  ignoreCrop?: boolean
}

interface LooksPayload {
  type: 'looks'
  filePath: string
  edits: EditParams
  edge: number
}

type Payload = AnalyzePayload | RenderPayload | LooksPayload

export class SupersededError extends Error {
  constructor() {
    super('Überholt')
  }
}

interface EnqueueOptions {
  /** Bevorzugter Worker, damit dessen Bild-Cache trifft. */
  affinity?: string
  /** Ältere, noch wartende Aufträge mit gleichem Schlüssel verwerfen. */
  supersede?: string
}

interface OkAnalyze {
  id: number
  ok: true
  type: 'analyze'
  result: AnalyzeResult
}

interface OkRender {
  id: number
  ok: true
  type: 'render'
  result: RenderResult
}

interface Failed {
  id: number
  ok: false
  error: string
}

interface OkLooks {
  id: number
  ok: true
  type: 'looks'
  result: Buffer[]
}

type Response = OkAnalyze | OkRender | OkLooks | Failed

interface Job {
  id: number
  payload: Payload
  slot?: number
  supersede?: string
  resolve: (value: Response) => void
  reject: (error: Error) => void
}

interface Slot {
  worker: Worker
  busy: boolean
  jobId: number
}

/**
 * Zwei Worker halten die Oberfläche frei. Fällt ein Worker aus,
 * läuft dieselbe Pipeline im Hauptprozess weiter.
 */
export class ImagePool {
  private slots: Slot[] = []
  private queue: Job[] = []
  private pending = new Map<number, Job>()
  private nextId = 1
  private enabled = true

  constructor(size = defaultPoolSize()) {
    try {
      for (let index = 0; index < size; index += 1) {
        const worker = new Worker(workerPath)
        const slot: Slot = { worker, busy: false, jobId: 0 }
        worker.on('message', (message: Response) => this.onMessage(slot, message))
        worker.on('error', (error) => {
          console.error('Bild-Worker', error)
          this.enabled = false
          slot.busy = false
        })
        this.slots.push(slot)
      }
    } catch (error) {
      console.error('Worker konnten nicht gestartet werden', error)
      this.enabled = false
    }
  }

  get size(): number {
    return this.enabled ? this.slots.length : 1
  }

  analyze(filePath: string): Promise<AnalyzeResult> {
    if (!this.enabled || this.slots.length === 0) return analyzeFile(filePath)
    return withTimeout(this.enqueue({ type: 'analyze', filePath }), 90_000)
      .then((response) => {
        if (!response.ok || response.type !== 'analyze') {
          throw new Error(!response.ok ? response.error : 'Unerwartete Antwort')
        }
        return normalizeAnalyze(response.result)
      })
      .catch(() => analyzeFile(filePath))
  }

  render(
    options: {
      filePath: string
      edits: EditParams
      maxEdge: number
      format: 'jpeg' | 'png'
      quality: number
      ignoreCrop?: boolean
    },
    queue: EnqueueOptions = {}
  ): Promise<RenderResult> {
    if (!this.enabled || this.slots.length === 0) return renderImage(options)
    return withTimeout(this.enqueue({ type: 'render', ...options }, queue), 180_000)
      .then((response) => {
        if (!response.ok || response.type !== 'render') {
          throw new Error(!response.ok ? response.error : 'Unerwartete Antwort')
        }
        return normalizeRender(response.result)
      })
      .catch((error: unknown) => {
        if (error instanceof SupersededError) throw error
        return renderImage(options)
      })
  }

  looks(options: { filePath: string; edits: EditParams; edge: number }, queue: EnqueueOptions = {}): Promise<Buffer[]> {
    if (!this.enabled || this.slots.length === 0) return renderLooks(options)
    return withTimeout(this.enqueue({ type: 'looks', ...options }, queue), 120_000).then((response) => {
      if (!response.ok || response.type !== 'looks') {
        throw new Error(!response.ok ? response.error : 'Unerwartete Antwort')
      }
      return response.result.map((item) => toBuffer(item))
    })
  }

  private enqueue(payload: Payload, options: EnqueueOptions = {}): Promise<Response> {
    const id = this.nextId
    this.nextId += 1
    if (options.supersede) {
      const stale = this.queue.filter((job) => job.supersede === options.supersede)
      this.queue = this.queue.filter((job) => job.supersede !== options.supersede)
      for (const job of stale) job.reject(new SupersededError())
    }
    const slot = options.affinity ? hashString(options.affinity) % this.slots.length : undefined
    return new Promise((resolve, reject) => {
      const job: Job = { id, payload, resolve, reject, slot, supersede: options.supersede }
      // Bedienung (Vorschau, Vorschaubilder) geht vor der Hintergrund-Analyse.
      if (options.supersede) this.queue.unshift(job)
      else this.queue.push(job)
      this.pump()
    })
  }

  private pump(): void {
    this.slots.forEach((slot, slotIndex) => {
      if (slot.busy) return
      const position = this.queue.findIndex((job) => job.slot === undefined || job.slot === slotIndex)
      if (position < 0) return
      const [job] = this.queue.splice(position, 1)
      slot.busy = true
      slot.jobId = job.id
      this.pending.set(job.id, job)
      slot.worker.postMessage({ ...job.payload, id: job.id })
    })
  }

  private onMessage(slot: Slot, message: Response): void {
    if (slot.jobId !== message.id) return
    slot.busy = false
    slot.jobId = 0
    const job = this.pending.get(message.id)
    this.pending.delete(message.id)
    job?.resolve(message)
    this.pump()
  }
}

function normalizeAnalyze(result: AnalyzeResult): AnalyzeResult {
  return { ...result, thumb: toBuffer(result.thumb) }
}

function normalizeRender(result: RenderResult): RenderResult {
  return { ...result, buffer: toBuffer(result.buffer) }
}

/** Ein Worker je Kern, einer bleibt für die Oberfläche frei (mindestens 2, höchstens 8). */
export function defaultPoolSize(): number {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
  return Math.min(8, Math.max(2, cores - 1))
}

function hashString(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return hash
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('Worker-Fehler'))
      }
    )
  })
}
