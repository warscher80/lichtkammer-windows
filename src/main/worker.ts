import { parentPort } from 'node:worker_threads'
import sharp from 'sharp'
import { analyzeFile, renderImage, renderLooks } from './engine/process'
import type { EditParams } from '../shared/types'

// Mehrere Worker laufen parallel: je Worker wenige libvips-Threads, damit sich die Kerne nicht im Weg stehen.
sharp.concurrency(2)

interface AnalyzeMessage {
  id: number
  type: 'analyze'
  filePath: string
}

interface RenderMessage {
  id: number
  type: 'render'
  filePath: string
  edits: EditParams
  maxEdge: number
  format: 'jpeg' | 'png'
  quality: number
  ignoreCrop?: boolean
}

interface LooksMessage {
  id: number
  type: 'looks'
  filePath: string
  edits: EditParams
  edge: number
}

type WorkerMessage = AnalyzeMessage | RenderMessage | LooksMessage

parentPort?.on('message', (message: WorkerMessage) => {
  void handle(message)
})

async function handle(message: WorkerMessage): Promise<void> {
  try {
    if (message.type === 'analyze') {
      const result = await analyzeFile(message.filePath)
      parentPort?.postMessage({ id: message.id, ok: true, type: 'analyze', result })
      return
    }
    if (message.type === 'looks') {
      const result = await renderLooks({ filePath: message.filePath, edits: message.edits, edge: message.edge })
      parentPort?.postMessage({ id: message.id, ok: true, type: 'looks', result })
      return
    }
    const result = await renderImage({
      filePath: message.filePath,
      edits: message.edits,
      maxEdge: message.maxEdge,
      format: message.format,
      quality: message.quality,
      ignoreCrop: message.ignoreCrop
    })
    parentPort?.postMessage({ id: message.id, ok: true, type: 'render', result })
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Unbekannter Fehler'
    })
  }
}
