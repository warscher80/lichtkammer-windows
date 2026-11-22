import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { app, dialog, type BrowserWindow, shell } from 'electron'
import { applyCulling } from './engine/culling'
import { collectImages, copyCulledFiles } from './engine/files'
import { SupersededError, type ImagePool } from './pool'
import {
  cloneEdits,
  sanitizeEdits,
  DEFAULT_SETTINGS,
  editKey,
  NEUTRAL_EDITS,
  type Catalog,
  type CopyResult,
  type EditParams,
  type ExportOptions,
  type ExportResult,
  type JobProgress,
  type Notice,
  type PhotoRecord,
  type PreviewPayload,
  type Settings
} from '../shared/types'

/** Erhöhen, wenn sich die Analyse ändert: alte Zwischenspeicher-Einträge werden dann ignoriert. */
const ANALYSIS_VERSION = 2

const IDLE: JobProgress = { active: false, phase: 'idle', current: 0, total: 0, label: '' }

export class Session {
  private catalog: Catalog = { version: 1, settings: { ...DEFAULT_SETTINGS }, photos: [] }
  private saveTimer: NodeJS.Timeout | null = null
  private busy = false
  private importing = false
  /** Zahlen des letzten Imports (Rauchtest und Fehlersuche). */
  lastImport = { added: 0, cached: 0, analyzed: 0, seconds: 0 }
  private importPending: string[] = []
  private cancelRequested = false
  private readonly catalogPath: string
  private readonly thumbDir: string
  private readonly analysisDir: string

  constructor(
    readonly pool: ImagePool,
    private readonly emit: (channel: string, payload: unknown) => void,
    private readonly getWindow: () => BrowserWindow | null
  ) {
    const root = app.getPath('userData')
    this.catalogPath = join(root, 'catalog.json')
    this.thumbDir = join(root, 'cache', 'thumbs')
    this.analysisDir = join(root, 'cache', 'analysis')
  }

  async init(): Promise<void> {
    await mkdir(this.thumbDir, { recursive: true })
    await mkdir(this.analysisDir, { recursive: true })
    try {
      const raw = await readFile(this.catalogPath, 'utf8')
      const parsed = JSON.parse(raw) as Catalog
      if (parsed.version === 1 && Array.isArray(parsed.photos) && parsed.settings) {
        // Ältere Kataloge: fehlende Regler (Weiß, Schwarz, HSL, Looks, Zuschnitt) ergänzen.
        for (const photo of parsed.photos) {
          photo.edits = sanitizeEdits(photo.edits)
          photo.autoEdits = sanitizeEdits(photo.autoEdits)
        }
        this.catalog = parsed
      }
    } catch {
      this.catalog = { version: 1, settings: { ...DEFAULT_SETTINGS }, photos: [] }
    }
  }

  getCatalog(): Catalog {
    return this.catalog
  }

  async importDialog(kind: 'files' | 'folder'): Promise<void> {
    const window = this.getWindow()
    if (!window) return
    const result = await dialog.showOpenDialog(window, {
      title: kind === 'folder' ? 'Ordner importieren' : 'Fotos importieren',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters:
        kind === 'files'
          ? [
              {
                name: 'Bilder',
                extensions: [
                  'jpg',
                  'jpeg',
                  'png',
                  'webp',
                  'tif',
                  'tiff',
                  'gif',
                  'cr2',
                  'cr3',
                  'nef',
                  'arw',
                  'dng',
                  'raf',
                  'orf',
                  'rw2',
                  'raw'
                ]
              }
            ]
          : undefined
    })
    if (result.canceled || result.filePaths.length === 0) return
    await this.importPaths(result.filePaths)
  }

  async importSamples(): Promise<void> {
    const directory = samplesDirectory()
    if (!directory) {
      this.notice('error', 'Der Ordner „beispiele“ wurde nicht gefunden.')
      return
    }
    await this.importPaths([directory])
  }

  /**
   * Import: Fotos erscheinen, sobald sie analysiert sind (mehrere gleichzeitig auf allen Kernen).
   * Bereits bekannte Dateien (gleicher Pfad, gleiche Größe, gleiche Änderungszeit) kommen aus dem
   * Zwischenspeicher und brauchen keine neue Analyse. Die App bleibt währenddessen bedienbar.
   */
  async importPaths(paths: string[]): Promise<void> {
    const accepted = paths.filter((target) => isImportablePath(target))
    if (accepted.length === 0) return
    if (this.busy) {
      this.notice('info', 'Es läuft bereits ein Export. Bitte danach importieren.')
      return
    }
    this.importPending.push(...accepted)
    if (this.importing) {
      this.notice('info', 'Weitere Fotos wurden zur laufenden Analyse hinzugefügt.')
      return
    }
    this.importing = true
    this.cancelRequested = false
    const stats = { added: 0, skipped: 0, cached: 0, failed: [] as string[], analyzed: 0 }
    const started = Date.now()
    let finishedCount = 0
    let totalCount = 0
    let lastFlush = 0
    let lastSave = Date.now()
    let dirty = false

    const flush = async (force: boolean): Promise<void> => {
      const now = Date.now()
      const interval = 280 + this.catalog.photos.length * 0.7
      if (!force && now - lastFlush < interval) return
      lastFlush = now
      if (dirty) {
        this.catalog.photos = applyCulling(this.catalog.photos, this.catalog.settings)
        dirty = false
        this.emit('catalog:update', this.catalog)
      }
      const remaining = totalCount - finishedCount
      const elapsed = (now - started) / 1000
      const eta = stats.analyzed >= 6 && remaining > 0 ? Math.round((elapsed / stats.analyzed) * remaining) : null
      this.progress({
        active: true,
        phase: 'import',
        current: finishedCount,
        total: totalCount,
        label: '',
        etaSeconds: remaining === 0 ? 0 : eta,
        cached: stats.cached
      })
      if (force || now - lastSave > 6000) {
        lastSave = now
        await this.persist()
      }
    }

    try {
      while (this.importPending.length > 0 && !this.cancelRequested) {
        const batch = this.importPending.splice(0)
        const files = await collectImages(batch)
        const known = new Set(this.catalog.photos.map((photo) => photo.sourcePath))
        const queued = new Set<string>()
        const fresh = files.filter((file) => {
          if (known.has(file) || queued.has(file)) return false
          queued.add(file)
          return true
        })
        stats.skipped += files.length - fresh.length
        totalCount += fresh.length
        let next = 0
        const worker = async (): Promise<void> => {
          while (!this.cancelRequested) {
            const index = next
            next += 1
            if (index >= fresh.length) return
            const filePath = fresh[index]
            try {
              const info = await stat(filePath)
              const hit = await this.readAnalysisCache(filePath, info.size, info.mtimeMs)
              const analyzed = hit ?? (await this.pool.analyze(filePath))
              if (hit) stats.cached += 1
              else {
                stats.analyzed += 1
                void this.writeAnalysisCache(filePath, info.size, info.mtimeMs, analyzed)
              }
              const photo = this.createPhoto(filePath, info.size, analyzed)
              await writeFile(join(this.thumbDir, `${photo.id}.jpg`), analyzed.thumb)
              await writeFile(join(this.thumbDir, `${photo.id}.txt`), editKey(photo.edits))
              this.catalog.photos.push(photo)
              stats.added += 1
              dirty = true
            } catch (error) {
              stats.failed.push(`${basename(filePath)}: ${shortError(error)}`)
            }
            finishedCount += 1
            await flush(false)
          }
        }
        const lanes = Math.max(2, this.pool.size + 1)
        await Promise.all(Array.from({ length: lanes }, () => worker()))
      }
    } finally {
      dirty = true
      this.importing = false
      await flush(true)
      this.progress(IDLE)
    }

    const parts = [`${stats.added} neue Fotos`]
    if (stats.cached > 0) parts.push(`${stats.cached} aus dem Zwischenspeicher`)
    if (stats.skipped > 0) parts.push(`${stats.skipped} bereits vorhanden`)
    if (this.cancelRequested) parts.push('abgebrochen')
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
    this.lastImport = { added: stats.added, cached: stats.cached, analyzed: stats.analyzed, seconds: (Date.now() - started) / 1000 }
    this.notice(stats.failed.length ? 'error' : 'info', `${parts.join(', ')} in ${seconds} s. Originale bleiben unberührt.`)
    if (stats.failed.length) {
      this.notice('error', `Nicht lesbar: ${stats.failed.slice(0, 3).join(' · ')}`)
    }
  }

  private analysisKey(filePath: string, size: number, mtimeMs: number): string {
    return createHash('sha1').update(`${ANALYSIS_VERSION}|${filePath}|${size}|${Math.round(mtimeMs)}`).digest('hex')
  }

  private async readAnalysisCache(filePath: string, size: number, mtimeMs: number): Promise<Awaited<ReturnType<ImagePool['analyze']>> | null> {
    const key = this.analysisKey(filePath, size, mtimeMs)
    try {
      const [json, thumb] = await Promise.all([
        readFile(join(this.analysisDir, `${key}.json`), 'utf8'),
        readFile(join(this.analysisDir, `${key}.jpg`))
      ])
      const data = JSON.parse(json) as Awaited<ReturnType<ImagePool['analyze']>>
      if (typeof data.sharpness !== 'number' || typeof data.hash !== 'string') return null
      return { ...data, thumb }
    } catch {
      return null
    }
  }

  private async writeAnalysisCache(
    filePath: string,
    size: number,
    mtimeMs: number,
    analyzed: Awaited<ReturnType<ImagePool['analyze']>>
  ): Promise<void> {
    try {
      const key = this.analysisKey(filePath, size, mtimeMs)
      const { thumb, ...rest } = analyzed
      await writeFile(join(this.analysisDir, `${key}.jpg`), thumb)
      await writeFile(join(this.analysisDir, `${key}.json`), JSON.stringify(rest))
    } catch {
      /* Zwischenspeicher ist optional. */
    }
  }

  async setSettings(settings: Settings): Promise<Catalog> {
    this.catalog.settings = {
      blurThreshold: clamp(Math.round(settings.blurThreshold), 0, 90),
      duplicateDistance: clamp(Math.round(settings.duplicateDistance), 0, 24)
    }
    this.catalog.photos = applyCulling(this.catalog.photos, this.catalog.settings)
    await this.persist()
    this.emit('catalog:update', this.catalog)
    return this.catalog
  }

  async setEdits(id: string, edits: EditParams): Promise<void> {
    const photo = this.catalog.photos.find((item) => item.id === id)
    if (!photo) return
    photo.edits = sanitizeEdits(edits)
    this.queueSave()
  }

  async applyAuto(id: string): Promise<Catalog> {
    const photo = this.catalog.photos.find((item) => item.id === id)
    if (!photo) return this.catalog
    // Automatik für Licht und Farbe; Look, Drehung und Zuschnitt bleiben.
    const auto = sanitizeEdits(photo.autoEdits)
    photo.edits = {
      ...auto,
      preset: photo.edits.preset,
      presetStrength: photo.edits.presetStrength,
      rotate: photo.edits.rotate,
      straighten: photo.edits.straighten,
      crop: photo.edits.crop
    }
    await this.persist()
    this.emit('catalog:update', this.catalog)
    return this.catalog
  }

  async resetEdits(id: string): Promise<Catalog> {
    const photo = this.catalog.photos.find((item) => item.id === id)
    if (!photo) return this.catalog
    photo.edits = cloneEdits(NEUTRAL_EDITS)
    await this.persist()
    this.emit('catalog:update', this.catalog)
    return this.catalog
  }

  async restore(ids: string[]): Promise<Catalog> {
    const wanted = new Set(ids)
    for (const photo of this.catalog.photos) {
      if (wanted.has(photo.id)) photo.pin = 'kept'
    }
    this.catalog.photos = applyCulling(this.catalog.photos, this.catalog.settings)
    await this.persist()
    this.emit('catalog:update', this.catalog)
    return this.catalog
  }

  async markBlurry(ids: string[]): Promise<Catalog> {
    const wanted = new Set(ids)
    for (const photo of this.catalog.photos) {
      if (wanted.has(photo.id)) photo.pin = 'blurry'
    }
    this.catalog.photos = applyCulling(this.catalog.photos, this.catalog.settings)
    await this.persist()
    this.emit('catalog:update', this.catalog)
    return this.catalog
  }

  async removeFromLibrary(ids: string[]): Promise<Catalog> {
    const wanted = new Set(ids)
    this.catalog.photos = applyCulling(
      this.catalog.photos.filter((photo) => !wanted.has(photo.id)),
      this.catalog.settings
    )
    await this.persist()
    this.emit('catalog:update', this.catalog)
    this.notice('info', 'Aus der Bibliothek genommen. Die Dateien auf der Festplatte bleiben erhalten.')
    return this.catalog
  }

  async preview(
    id: string,
    edits: EditParams | null,
    maxEdge: number,
    options: { ignoreCrop?: boolean; purpose?: string } = {}
  ): Promise<PreviewPayload | null> {
    const photo = this.requirePhoto(id)
    const purpose = options.purpose ?? 'main'
    try {
      const rendered = await this.pool.render(
        {
          filePath: photo.sourcePath,
          edits: edits ? sanitizeEdits(edits) : cloneEdits(NEUTRAL_EDITS),
          maxEdge: clamp(Math.round(maxEdge), 200, 4096),
          format: 'jpeg',
          quality: 84,
          ignoreCrop: options.ignoreCrop === true
        },
        { affinity: photo.sourcePath, supersede: `preview:${purpose}` }
      )
      return {
        dataUrl: `data:image/jpeg;base64,${Buffer.from(rendered.buffer).toString('base64')}`,
        width: rendered.width,
        height: rendered.height,
        histogram: rendered.histogram
      }
    } catch (error) {
      if (error instanceof SupersededError) return null
      throw error
    }
  }

  async lookPreviews(id: string, edits: EditParams): Promise<string[] | null> {
    const photo = this.requirePhoto(id)
    try {
      const buffers = await this.pool.looks(
        { filePath: photo.sourcePath, edits: sanitizeEdits(edits), edge: 220 },
        { affinity: photo.sourcePath, supersede: 'looks' }
      )
      return buffers.map((buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`)
    } catch (error) {
      if (error instanceof SupersededError) return null
      throw error
    }
  }

  /** „Alle sichern“: alle behaltenen Fotos mit Bearbeitung als JPEG in einen Ordner. */
  async saveAll(): Promise<ExportResult | null> {
    const directory = await this.chooseOutputDir()
    if (!directory) return null
    const result = await this.exportPhotos({ directory, format: 'jpeg', quality: 92, scope: 'kept' })
    this.notice('info', `${result.exported} Fotos gesichert in ${directory}`)
    if (result.files[0]) shell.showItemInFolder(result.files[0])
    return result
  }

  /** Vorschaubild als JPEG-Bytes (für das lkthumb-Protokoll). Rendert nur, wenn die Bearbeitung neuer ist. */
  async thumbBytes(id: string): Promise<Buffer | null> {
    const photo = this.catalog.photos.find((item) => item.id === id)
    if (!photo) return null
    const file = join(this.thumbDir, `${photo.id}.jpg`)
    const keyFile = join(this.thumbDir, `${photo.id}.txt`)
    const edits = photo.edits
    const key = editKey(edits)
    let current = ''
    try {
      current = await readFile(keyFile, 'utf8')
    } catch {
      current = ''
    }
    if (current === key) {
      try {
        return await readFile(file)
      } catch {
        /* neu rendern */
      }
    }
    try {
      const rendered = await this.pool.render(
        { filePath: photo.sourcePath, edits, maxEdge: 480, format: 'jpeg', quality: 78 },
        { affinity: photo.sourcePath, supersede: `thumb:${photo.id}` }
      )
      void writeFile(file, rendered.buffer)
        .then(() => writeFile(keyFile, key))
        .catch(() => undefined)
      return Buffer.from(rendered.buffer)
    } catch (error) {
      if (error instanceof SupersededError) return null
      throw error
    }
  }

  async chooseOutputDir(): Promise<string | null> {
    const window = this.getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Zielordner',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }

  async exportPhotos(options: ExportOptions): Promise<ExportResult> {
    if (this.busy) throw new Error('Es läuft bereits ein Vorgang.')
    const selected = this.catalog.photos.filter((photo) => {
      if (options.scope === 'selected') return photo.id === options.selectedId
      return photo.status === 'kept'
    })
    if (typeof options.directory !== 'string' || options.directory.includes('\0') || !isAbsolute(options.directory)) {
      throw new Error('Der Zielordner ist ungültig.')
    }
    if (selected.length === 0) throw new Error('Keine Fotos für den Export ausgewählt.')
    this.busy = true
    this.cancelRequested = false
    const files: string[] = []
    const failed: string[] = []
    try {
      await mkdir(options.directory, { recursive: true })
      for (let index = 0; index < selected.length; index += 1) {
        if (this.cancelRequested) break
        const photo = selected[index]
        this.progress({
          active: true,
          phase: 'export',
          current: index + 1,
          total: selected.length,
          label: photo.fileName
        })
        const extension = options.format === 'png' ? '.png' : '.jpg'
        const base = photo.fileName.replace(/\.[^.]+$/, '')
        const target = await uniqueFile(options.directory, `${base}_lichtkammer${extension}`)
        try {
          const rendered = await this.pool.render({
            filePath: photo.sourcePath,
            edits: photo.edits,
            maxEdge: 0,
            format: options.format,
            quality: options.quality
          })
          await writeFile(target, rendered.buffer)
          files.push(target)
          photo.savedKey = editKey(photo.edits)
        } catch (error) {
          failed.push(`${photo.fileName}: ${shortError(error)}`)
        }
      }
    } finally {
      this.progress(IDLE)
      this.busy = false
      await this.persist()
      this.emit('catalog:update', this.catalog)
    }
    if (failed.length) this.notice('error', `Nicht exportiert: ${failed.slice(0, 3).join(' · ')}`)
    return { exported: files.length, directory: options.directory, files }
  }

  async copyCulled(): Promise<CopyResult> {
    const directory = await this.chooseOutputDir()
    if (!directory) return { copied: 0, blurryDir: '', duplicateDir: '' }
    if (this.busy) throw new Error('Es läuft bereits ein Vorgang.')
    this.busy = true
    this.progress({
      active: true,
      phase: 'copy',
      current: 0,
      total: 1,
      label: 'Kopiere aussortierte Fotos'
    })
    try {
      const result = await copyCulledFiles(this.catalog.photos, directory)
      this.notice(
        'info',
        result.copied === 0
          ? 'Nichts zu kopieren. Originale bleiben unberührt.'
          : `${result.copied} Kopien unter „Aussortiert“ abgelegt. Originale bleiben am Ursprungsort.`
      )
      return result
    } finally {
      this.progress(IDLE)
      this.busy = false
    }
  }

  async showPath(target: string): Promise<void> {
    if (!this.ownsPath(target)) return
    shell.showItemInFolder(target)
  }

  ownsPath(target: string): boolean {
    if (!isImportablePath(target)) return false
    const resolved = resolve(target)
    return this.catalog.photos.some((photo) => {
      const source = resolve(photo.sourcePath)
      return resolved === source || resolved === dirname(source)
    })
  }

  cancel(): void {
    this.cancelRequested = true
  }

  private createPhoto(
    filePath: string,
    fileSize: number,
    analyzed: Awaited<ReturnType<ImagePool['analyze']>>
  ): PhotoRecord {
    return {
      id: randomUUID(),
      sourcePath: filePath,
      fileName: basename(filePath),
      ext: extname(filePath).toLowerCase(),
      fileSize,
      width: analyzed.width,
      height: analyzed.height,
      sharpness: analyzed.sharpness,
      sharpnessScore: analyzed.sharpnessScore,
      hash: analyzed.hash,
      pHash: analyzed.pHash,
      contentHash: analyzed.contentHash,
      capturedAt: analyzed.capturedAt,
      status: 'kept',
      edits: cloneEdits(analyzed.autoEdits),
      autoEdits: cloneEdits(analyzed.autoEdits),
      importedAt: Date.now(),
      developedFrom: analyzed.developedFrom,
      usedEmbeddedPreview: analyzed.usedEmbeddedPreview,
      camera: analyzed.camera
    }
  }

  private requirePhoto(id: string): PhotoRecord {
    const photo = this.catalog.photos.find((item) => item.id === id)
    if (!photo) throw new Error('Foto nicht mehr in der Bibliothek')
    return photo
  }

  private progress(progress: JobProgress): void {
    this.emit('job:progress', progress)
  }

  private notice(kind: Notice['kind'], message: string): void {
    this.emit('notice', { kind, message } satisfies Notice)
  }

  private queueSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.persist()
    }, 250)
  }

  private async persist(): Promise<void> {
    const temporary = `${this.catalogPath}.tmp`
    await writeFile(temporary, JSON.stringify(this.catalog))
    await rename(temporary, this.catalogPath)
  }
}

function isImportablePath(target: string): boolean {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096 || target.includes('\0')) return false
  if (!isAbsolute(target)) return false
  return existsSync(target)
}

function samplesDirectory(): string | null {
  const candidates = [join(app.getAppPath(), 'beispiele'), join(process.resourcesPath, 'beispiele')]
  return candidates.find((directory) => existsSync(directory)) ?? null
}

async function uniqueFile(directory: string, fileName: string): Promise<string> {
  const extension = extname(fileName)
  const base = fileName.slice(0, fileName.length - extension.length)
  let candidate = join(directory, fileName)
  let index = 2
  while (existsSync(candidate)) {
    candidate = join(directory, `${base}-${index}${extension}`)
    index += 1
  }
  return candidate
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unbekannter Fehler'
  return message.replace(/\s+/g, ' ').slice(0, 160)
}
