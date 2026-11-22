/**
 * Messung der Import-Analyse: npm run bench -- <Ordner> [--engine=<process.ts>] [--workers=N] [--sharp=N] [--out=datei.json] [--limit=N]
 * Workers=0: alles nacheinander im Hauptthread (so lief der Import bis Version 1.1.2).
 */
import { readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--'))
const opt = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
if (!dir) throw new Error('Ordner fehlt')
const engine = resolve(opt('engine', 'src/main/engine/process.ts'))
const workers = Number(opt('workers', '0'))
const sharpThreads = Number(opt('sharp', '0'))
const limit = Number(opt('limit', '0'))
const out = opt('out', '')

const all = (await readdir(dir)).filter((n) => /\.(jpe?g|png|arw|nef|dng|cr2)$/i.test(n)).sort()
const files = (limit ? all.slice(0, limit) : all).map((n) => join(dir, n))
const results: Record<string, unknown>[] = []
const started = Date.now()
let done = 0

if (workers === 0) {
  const mod = await import(pathToFileURL(engine).href)
  for (const filePath of files) {
    const t = Date.now()
    try {
      const r = await mod.analyzeFile(filePath)
      results.push({ filePath, ms: Date.now() - t, ok: true, result: { ...r, thumb: undefined, thumbBytes: r.thumb.length } })
    } catch (error) {
      results.push({ filePath, ms: Date.now() - t, ok: false, error: String(error) })
    }
    done += 1
    if (done % 50 === 0) console.log(`  ${done}/${files.length} nach ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
} else {
  const queue = [...files]
  await new Promise<void>((resolveAll) => {
    const pool: Worker[] = []
    for (let i = 0; i < workers; i += 1) {
      const worker = new Worker(new URL('./bench-worker.mts', import.meta.url), {
        execArgv: ['--import', 'tsx'],
        workerData: { engine: pathToFileURL(engine).href, sharpThreads: sharpThreads || undefined }
      })
      const next = (): void => {
        const file = queue.shift()
        if (file) worker.postMessage(file)
        else if (done >= files.length) {
          for (const w of pool) void w.terminate()
          resolveAll()
        }
      }
      worker.on('message', (m: Record<string, unknown>) => {
        results.push(m)
        done += 1
        if (done % 50 === 0) console.log(`  ${done}/${files.length} nach ${((Date.now() - started) / 1000).toFixed(1)} s`)
        next()
      })
      worker.on('error', (e) => console.error('Worker-Fehler', e))
      pool.push(worker)
    }
    // Start erst, wenn alle Worker laufen, damit das Laden nicht mitgemessen wird.
    setTimeout(() => pool.forEach((w) => { const f = queue.shift(); if (f) w.postMessage(f) }), 1500)
  })
}
const total = (Date.now() - started) / 1000
const failed = results.filter((r) => !r.ok).length
console.log(`${files.length} Fotos, ${workers} Worker: ${total.toFixed(1)} s gesamt (${((total / files.length) * 1000).toFixed(0)} ms je Foto), ${failed} Fehler`)
if (out) {
  results.sort((a, b) => String(a.filePath).localeCompare(String(b.filePath)))
  await writeFile(out, JSON.stringify({ engine, workers, total, results }, null, 1))
}
process.exit(0)
