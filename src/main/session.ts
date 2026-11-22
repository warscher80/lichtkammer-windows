import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { app, dialog, type BrowserWindow, shell } from 'electron'
import { applyCulling } from './engine/culling'
import { collectImages, copyCulledFiles } from './engine/files'
import type { ImagePool } from './pool'
import {
  cloneEdits,
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

const IDLE: JobProgress = { active: false, phase: 'idle', current: 0, total: 0, label: '' }

export class Session {
  private catalog: Catalog = { version: 1, settings: { ...DEFAULT_SETTINGS }, photos: [] }
  private saveTimer: NodeJS.Timeout | null = null
  private busy = false
  private cancelRequested = false
  private readonly catalogPath: string
  private readonly thumbDir: string

  constructor(
    private readonly pool: ImagePool,
    private readonly emit: (channel: string, payload: unknown) => void,
    private readonly getWindow: () => BrowserWindow | null
  ) {
    const root = app.getPath('userData')
    this.catalogPath = join(root, 'catalog.json')
    this.thumbDir = join(root, 'cache', 'thumbs')
  }

  async init(): Promise<void> {
    await mkdir(this.thumbDir, { recursive: true })
    try {
      const raw = await readFile(this.catalogPath, 'utf8')
      const parsed = JSON.parse(raw) as Catalog
      if (parsed.version === 1 && Array.isArray(parsed.photos) && parsed.settings) {
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

  async importPaths(paths: string[]): Promise<void> {
    const accepted = paths.filter((target) => isImportablePath(target))
    if (this.busy) {
      this.notice('info', 'Es läuft bereits ein Vorgang.')
      return
    }
    this.busy = true
    this.cancelRequested = false
    const files = await collectImages(accepted)
    const known = new Set(this.catalog.photos.map((photo) => photo.sourcePath))
    const fresh = files.filter((file) => !known.has(file))
    const skipped = files.length - fresh.length
    const failed: string[] = []
    let added = 0

    for (let index = 0; index < fresh.length; index += 1) {
      if (this.cancelRequested) break
      const filePath = fresh[index]
      this.progress({
        active: true,
        phase: 'import',
        current: index + 1,
        total: fresh.length,
        label: basename(filePath)
      })
      try {
        const analyzed = await this.pool.analyze(filePath)
        const info = await stat(filePath)
        const photo = this.createPhoto(filePath, info.size, analyzed)
        await writeFile(join(this.thumbDir, `${photo.id}.jpg`), analyzed.thumb)
        await writeFile(join(this.thumbDir, `${photo.id}.txt`), editKey(photo.edits))
        this.catalog.photos.push(photo)
        added += 1
      } catch (error) {
        failed.push(`${basename(filePath)}: ${shortError(error)}`)
      }
    }

    this.catalog.photos = applyCulling(this.catalog.photos, this.catalog.settings)
    await this.persist()
    this.emit('catalog:update', this.catalog)
    this.progress(IDLE)
    this.busy = false

    const parts = [`${added} neue Fotos`]
    if (skipped > 0) parts.push(`${skipped} bereits vorhanden`)
    if (this.cancelRequested) parts.push('abgebrochen')
    this.notice(failed.length ? 'error' : 'info', `${parts.join(', ')}. Originale bleiben unberührt.`)
    if (failed.length) {
      this.notice('error', `Nicht lesbar: ${failed.slice(0, 3).join(' · ')}`)
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
    photo.edits = cloneEdits(photo.autoEdits)
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

  async preview(id: string, edits: EditParams | null, maxEdge: number): Promise<PreviewPayload> {
    const photo = this.requirePhoto(id)
    const rendered = await this.pool.render({
      filePath: photo.sourcePath,
      edits: edits ? sanitizeEdits(edits) : cloneEdits(NEUTRAL_EDITS),
      maxEdge: clamp(Math.round(maxEdge), 320, 2400),
      format: 'jpeg',
      quality: 82
    })
    return {
      dataUrl: `data:image/jpeg;base64,${Buffer.from(rendered.buffer).toString('base64')}`,
      width: rendered.width,
      height: rendered.height,
      histogram: rendered.histogram
    }
  }

  async thumb(id: string): Promise<string> {
    const photo = this.requirePhoto(id)
    const file = join(this.thumbDir, `${photo.id}.jpg`)
    const keyFile = join(this.thumbDir, `${photo.id}.txt`)
    const key = editKey(photo.edits)
    let current = ''
    try {
      current = await readFile(keyFile, 'utf8')
    } catch {
      current = ''
    }
    if (current !== key || !existsSync(file)) {
      const rendered = await this.pool.render({
        filePath: photo.sourcePath,
        edits: photo.edits,
        maxEdge: 560,
        format: 'jpeg',
        quality: 76
      })
      await writeFile(file, rendered.buffer)
      await writeFile(keyFile, key)
    }
    const bytes = await readFile(file)
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
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
        const rendered = await this.pool.render({
          filePath: photo.sourcePath,
          edits: photo.edits,
          maxEdge: 0,
          format: options.format,
          quality: options.quality
        })
        await writeFile(target, rendered.buffer)
        files.push(target)
      }
    } finally {
      this.progress(IDLE)
      this.busy = false
    }
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

function sanitizeEdits(edits: EditParams): EditParams {
  const next = cloneEdits(NEUTRAL_EDITS)
  const keys = Object.keys(NEUTRAL_EDITS) as (keyof EditParams)[]
  for (const key of keys) {
    const value = edits?.[key]
    next[key] = typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  next.exposure = Math.round(clamp(next.exposure, -3, 3) * 20) / 20
  for (const key of keys) {
    if (key === 'exposure') continue
    const max = key === 'sharpen' || key === 'noise' ? 100 : 100
    const min = key === 'sharpen' || key === 'noise' ? 0 : -100
    next[key] = Math.round(clamp(next[key], min, max))
  }
  return next
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
