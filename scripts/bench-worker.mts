import { parentPort, workerData } from 'node:worker_threads'

const engine = workerData.engine as string
const module = await import(engine)
if (typeof workerData.sharpThreads === 'number') {
  const sharp = (await import('sharp')).default
  sharp.concurrency(workerData.sharpThreads)
}
parentPort?.on('message', async (filePath: string) => {
  const t = Date.now()
  try {
    const r = await module.analyzeFile(filePath)
    parentPort?.postMessage({
      filePath,
      ms: Date.now() - t,
      ok: true,
      result: { ...r, thumb: undefined, thumbBytes: r.thumb?.length ?? 0 }
    })
  } catch (error) {
    parentPort?.postMessage({ filePath, ms: Date.now() - t, ok: false, error: String(error) })
  }
})
