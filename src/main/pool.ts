import { Worker } from 'node:worker_threads'
import workerPath from './worker?modulePath'
import { analyzeFile, renderImage, type AnalyzeResult, type RenderResult } from './engine/process'
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
}

type Payload = AnalyzePayload | RenderPayload

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

type Response = OkAnalyze | OkRender | Failed

interface Job {
  id: number
  payload: Payload
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

  constructor(size = 2) {
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

  render(options: {
    filePath: string
    edits: EditParams
    maxEdge: number
    format: 'jpeg' | 'png'
    quality: number
  }): Promise<RenderResult> {
    if (!this.enabled || this.slots.length === 0) return renderImage(options)
    return withTimeout(this.enqueue({ type: 'render', ...options }), 120_000)
      .then((response) => {
        if (!response.ok || response.type !== 'render') {
          throw new Error(!response.ok ? response.error : 'Unerwartete Antwort')
        }
        return normalizeRender(response.result)
      })
      .catch(() => renderImage(options))
  }

  private enqueue(payload: Payload): Promise<Response> {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.queue.push({ id, payload, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.queue.shift()
      if (!job) return
      slot.busy = true
      slot.jobId = job.id
      this.pending.set(job.id, job)
      slot.worker.postMessage({ ...job.payload, id: job.id })
    }
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
