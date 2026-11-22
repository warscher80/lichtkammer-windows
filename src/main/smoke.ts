import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { LOOKS } from '../shared/looks'
import { sanitizeEdits } from '../shared/types'
import type { Session } from './session'

/**
 * Rauchtest für CI: Beispiele importieren, Looks/HSL/Zuschnitt anwenden, alles exportieren,
 * Oberfläche prüfen, Bericht schreiben und beenden.
 */
export async function runSmokeTest(session: Session, window: BrowserWindow, outDir: string): Promise<boolean> {
  const report: Record<string, unknown> = { ok: false, steps: [] as string[], errors: [] as string[] }
  const steps = report.steps as string[]
  const errors = report.errors as string[]
  const started = Date.now()
  window.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level: string | number }).level
    if (level === 'error' || level === 3) errors.push(`console: ${(details as unknown as { message: string }).message}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${details.reason}`))
  try {
    await mkdir(outDir, { recursive: true })
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) resolve()
      else window.webContents.once('did-finish-load', () => resolve())
    })
    steps.push('Fenster geladen')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await writeFile(join(outDir, 'start.png'), (await window.webContents.capturePage()).toPNG())
    await session.importSamples()
    const catalog = session.getCatalog()
    steps.push(`Import: ${catalog.photos.length} Fotos`)
    if (catalog.photos.length < 10) throw new Error('Zu wenige Fotos importiert')
    steps.push(
      `Import: ${session.lastImport.analyzed} analysiert in ${session.lastImport.seconds.toFixed(1)} s (${session.pool.size} Worker)`
    )
    // Zweiter Import nach dem Entfernen: alles kommt aus dem Zwischenspeicher.
    const firstSeconds = session.lastImport.seconds
    await session.removeFromLibrary(catalog.photos.map((photo) => photo.id))
    await session.importSamples()
    steps.push(
      `Zwischenspeicher: ${session.lastImport.cached} von ${session.lastImport.added} aus dem Cache in ${session.lastImport.seconds.toFixed(1)} s (erstes Mal ${firstSeconds.toFixed(1)} s)`
    )
    if (session.lastImport.cached < session.lastImport.added || session.lastImport.analyzed !== 0) {
      throw new Error('Zwischenspeicher greift nicht')
    }
    const kept = session.getCatalog().photos.filter((photo) => photo.status === 'kept')
    steps.push(`Behalten: ${kept.length}, aussortiert: ${catalog.photos.length - kept.length}`)
    const first = kept[0]
    // Look + HSL + Zuschnitt + Drehung
    const edits = sanitizeEdits({
      ...first.edits,
      preset: 'landschaft',
      presetStrength: 80,
      hslSat: [0, 0, 0, 20, 0, 30, 0, 0],
      rotate: 90,
      straighten: 3,
      crop: { x: 0.1, y: 0.1, w: 0.7, h: 0.6 },
      whites: 10,
      blacks: -10
    })
    await session.setEdits(first.id, edits)
    const preview = await session.preview(first.id, edits, 1400)
    if (!preview || preview.width < 100) throw new Error('Vorschau fehlgeschlagen')
    steps.push(`Vorschau ${preview.width}×${preview.height}`)
    const looks = await session.lookPreviews(first.id, edits)
    if (!looks || looks.length !== LOOKS.length) throw new Error('Look-Vorschauen fehlgeschlagen')
    steps.push(`Look-Vorschauen: ${looks.length}`)
    const second = kept[1]
    if (second) await session.setEdits(second.id, sanitizeEdits({ ...second.edits, preset: 'schwarzweiss', presetStrength: 100 }))
    const exportDir = join(outDir, 'export')
    const result = await session.exportPhotos({ directory: exportDir, format: 'jpeg', quality: 90, scope: 'kept' })
    steps.push(`Export: ${result.exported} Dateien`)
    if (result.exported !== kept.length) throw new Error(`Export unvollständig: ${result.exported}/${kept.length}`)
    const files = await readdir(exportDir)
    for (const file of files.slice(0, 3)) {
      const info = await stat(join(exportDir, file))
      steps.push(`${file}: ${Math.round(info.size / 1024)} KB`)
    }
    // Motiv-Erkennung und „Automatisch perfekt“
    await session.backfillMotifs()
    const withMotif = session.getCatalog().photos.filter((photo) => photo.status === 'kept' && photo.motif)
    if (withMotif.length !== kept.length) throw new Error(`Motiv fehlt: ${withMotif.length}/${kept.length}`)
    const motifCounts: Record<string, number> = {}
    for (const photo of withMotif) motifCounts[photo.motif as string] = (motifCounts[photo.motif as string] ?? 0) + 1
    steps.push(`Motive: ${JSON.stringify(motifCounts)}`)
    const perfect = await session.autoPerfect()
    const perfectKept = perfect.photos.filter((photo) => photo.status === 'kept')
    if (perfectKept.some((photo) => !photo.edits.preset)) throw new Error('Automatisch perfekt: Look fehlt')
    steps.push(`Automatisch perfekt: ${perfectKept.length} Fotos, Looks ${[...new Set(perfectKept.map((photo) => photo.edits.preset))].join(', ')}`)
    // Oberfläche: Bibliothek zeigt Fotos
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const domCount = (await window.webContents.executeJavaScript(
      'document.querySelectorAll("[data-photo-card]").length'
    )) as number
    const loaded = (await window.webContents.executeJavaScript(
      '[...document.querySelectorAll("[data-photo-card] img")].filter((i) => i.complete && i.naturalWidth > 0).length'
    )) as number
    steps.push(`Oberfläche: ${domCount} Fotokarten, ${loaded} Vorschaubilder geladen`)
    if (loaded < domCount) throw new Error('Nicht alle Vorschaubilder geladen')
    if (domCount < 1) throw new Error('Bibliothek zeigt keine Fotos')
    const image = await window.webContents.capturePage()
    await writeFile(join(outDir, 'bibliothek.png'), image.toPNG())
    await window.webContents.executeJavaScript('window.__lkOpenDevelop && window.__lkOpenDevelop()')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const develop = await window.webContents.capturePage()
    await writeFile(join(outDir, 'entwickeln.png'), develop.toPNG())
    const gpuInUse = (await window.webContents.executeJavaScript('Boolean(document.querySelector("canvas[data-gpu-canvas]"))')) as boolean
    steps.push(`Vorschau: ${gpuInUse ? 'Grafikkarte (WebGL2)' : 'Rückfall auf CPU'}`)
    {
      const size = develop.getSize()
      const bitmap = develop.toBitmap()
      let sum = 0
      let n = 0
      for (let y = Math.round(size.height * 0.35); y < Math.round(size.height * 0.55); y += 4) {
        for (let x = Math.round(size.width * 0.25); x < Math.round(size.width * 0.5); x += 4) {
          const at = (y * size.width + x) * 4
          sum += bitmap[at] + bitmap[at + 1] + bitmap[at + 2]
          n += 3
        }
      }
      const mean = sum / Math.max(1, n)
      steps.push(`Bildmitte: mittlere Helligkeit ${Math.round(mean)}`)
      if (mean < 12) throw new Error('Entwickeln zeigt kein Bild (schwarz)')
    }
    const lookButtons = (await window.webContents.executeJavaScript(
      'document.querySelectorAll("[data-look]").length'
    )) as number
    steps.push(`Entwickeln: ${lookButtons} Looks sichtbar`)
    if (lookButtons !== LOOKS.length) throw new Error('Look-Leiste fehlt')
    await window.webContents.executeJavaScript(
      '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Zuschneiden"))?.click()'
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await writeFile(join(outDir, 'zuschneiden.png'), (await window.webContents.capturePage()).toPNG())
    const handles = (await window.webContents.executeJavaScript(
      'document.querySelectorAll("[data-handle=se]").length'
    )) as number
    steps.push(`Zuschneiden: ${handles} Griff unten rechts`)
    if (handles !== 1) throw new Error('Zuschneide-Rahmen fehlt')
    await window.webContents.executeJavaScript(
      '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Fertig"))?.click()'
    )
    const fatal = errors.filter((line) => !line.includes('Autofill') && !line.includes('Electron Security'))
    if (fatal.length) throw new Error(`Fehler in der Oberfläche: ${fatal.slice(0, 3).join(' | ')}`)
    report.ok = existsSync(exportDir)
  } catch (error) {
    report.ok = false
    errors.push(error instanceof Error ? error.message : String(error))
  }
  report.seconds = Math.round((Date.now() - started) / 1000)
  await writeFile(join(outDir, 'smoke.json'), JSON.stringify(report, null, 2))
  return report.ok === true
}

/**
 * Messung für CI: importiert einen Ordner wie ein Nutzer (über die App-Logik), misst die Zeit bis zum
 * ersten Foto und bis alles fertig ist, danach den zweiten Import aus dem Zwischenspeicher.
 */
export async function runImportBench(session: Session, window: BrowserWindow, photosDir: string, outDir: string): Promise<boolean> {
  const report: Record<string, unknown> = { ok: false }
  try {
    await mkdir(outDir, { recursive: true })
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) resolve()
      else window.webContents.once('did-finish-load', () => resolve())
    })
    const started = Date.now()
    let firstMs = -1
    const timer = setInterval(() => {
      if (firstMs < 0 && session.getCatalog().photos.length > 0) firstMs = Date.now() - started
    }, 20)
    await session.importPaths([photosDir])
    clearInterval(timer)
    const total = (Date.now() - started) / 1000
    const photos = session.getCatalog().photos
    report.photos = photos.length
    report.workers = session.pool.size
    report.firstPhotoSeconds = firstMs < 0 ? null : firstMs / 1000
    report.totalSeconds = total
    report.perPhotoMs = Math.round((total / Math.max(1, photos.length)) * 1000)
    report.analyzed = session.lastImport.analyzed
    report.kept = photos.filter((photo) => photo.status === 'kept').length
    report.blurry = photos.filter((photo) => photo.status === 'blurry').length
    report.duplicates = photos.filter((photo) => photo.status === 'duplicate').length
    report.fingerprint = photos
      .map((photo) => `${photo.fileName}:${photo.sharpness.toFixed(3)}:${photo.hash}:${photo.status}`)
      .sort()
      .join('|')
      .length
    // Zweiter Import: alles aus dem Zwischenspeicher.
    await session.removeFromLibrary(photos.map((photo) => photo.id))
    const again = Date.now()
    await session.importPaths([photosDir])
    report.cachedSeconds = (Date.now() - again) / 1000
    report.cachedHits = session.lastImport.cached
    // Oberfläche: Karten sind da.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    report.domCards = await window.webContents.executeJavaScript('document.querySelectorAll("[data-photo-card]").length')
    report.ok = photos.length > 0 && session.lastImport.analyzed === 0
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }
  await writeFile(join(outDir, 'import-bench.json'), JSON.stringify(report, null, 2))
  return report.ok === true
}
