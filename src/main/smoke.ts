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
    const kept = catalog.photos.filter((photo) => photo.status === 'kept')
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
    // Oberfläche: Bibliothek zeigt Fotos
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const domCount = (await window.webContents.executeJavaScript(
      'document.querySelectorAll("[data-photo-card]").length'
    )) as number
    steps.push(`Oberfläche: ${domCount} Fotokarten`)
    if (domCount < 1) throw new Error('Bibliothek zeigt keine Fotos')
    const image = await window.webContents.capturePage()
    await writeFile(join(outDir, 'bibliothek.png'), image.toPNG())
    await window.webContents.executeJavaScript('window.__lkOpenDevelop && window.__lkOpenDevelop()')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const develop = await window.webContents.capturePage()
    await writeFile(join(outDir, 'entwickeln.png'), develop.toPNG())
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
