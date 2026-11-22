import { parentPort } from 'node:worker_threads'
import { analyzeFile, renderImage } from './engine/process'
import type { EditParams } from '../shared/types'

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
}

type WorkerMessage = AnalyzeMessage | RenderMessage

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
    const result = await renderImage({
      filePath: message.filePath,
      edits: message.edits,
      maxEdge: message.maxEdge,
      format: message.format,
      quality: message.quality
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
