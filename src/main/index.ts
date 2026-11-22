import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, protocol, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { ImagePool } from './pool'
import { Session } from './session'
import { runGpuTest } from './gputest'
import { runPerfTest } from './perf'
import { runImportBench, runSmokeTest } from './smoke'
import { Updater } from './updater'
import type { EditParams, ExportOptions, Settings } from '../shared/types'

let mainWindow: BrowserWindow | null = null
// Vorschaubilder kommen über lkthumb://, damit die Oberfläche sie träge und ohne base64 lädt.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lkthumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  // lkraw:// liefert Fotos roh (RGB) für die Grafikkarte; die Oberfläche holt sie per fetch.
  { scheme: 'lkraw', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])
const updater = new Updater((state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', state)
})
const updateTestArg = process.argv.find((arg) => arg.startsWith('--update-test='))
const smokeArg = process.argv.find((arg) => arg.startsWith('--smoke-test='))
const smokeDir = smokeArg ? smokeArg.slice('--smoke-test='.length) : null
const benchDir = process.argv.find((arg) => arg.startsWith('--bench-dir='))?.slice('--bench-dir='.length) ?? null
const perfArg = process.argv.find((arg) => arg.startsWith('--perf-test='))
const perfDir = perfArg ? perfArg.slice('--perf-test='.length) : null
const perfPhotos = process.argv.find((arg) => arg.startsWith('--perf-photos='))?.slice('--perf-photos='.length) ?? ''
const perfPhase = process.argv.find((arg) => arg.startsWith('--perf-phase='))?.slice('--perf-phase='.length) ?? 'run'
const gpuArg = process.argv.find((arg) => arg.startsWith('--gpu-test='))
const gpuDir = gpuArg ? gpuArg.slice('--gpu-test='.length) : null
const processStart = Date.now() - process.uptime() * 1000
let readyAt = 0
let shownAt = 0
if (smokeDir) app.setPath('userData', join(smokeDir, 'userdata'))
if (perfDir) app.setPath('userData', join(perfDir, 'userdata'))
if (gpuDir) app.setPath('userData', join(gpuDir, 'userdata'))
// Ohne Grafikkarte (Server, virtuelle Maschine) rechnet WebGL in Software weiter.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
const pool = new ImagePool()
const session = new Session(
  pool,
  (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  },
  () => mainWindow
)

function createWindow(): void {
  const icon = join(app.getAppPath(), 'resources', 'icon.png')
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    show: false,
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    title: 'Lichtkammer',
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!smokeDir && !perfDir && !gpuDir) mainWindow?.maximize()
    mainWindow?.show()
    shownAt = Date.now()
    // Erst nach dem Anzeigen: einen Arbeitsprozess vorwärmen, damit der erste Import sofort losläuft.
    if (!smokeDir && !perfDir && !gpuDir) {
      setTimeout(() => session.pool.warm(), 1200)
      setTimeout(() => void session.backfillMotifs(), 5000)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isHttpsUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppNavigation(url)) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), gpuDir ? { hash: 'gputest' } : undefined)
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Datei',
      submenu: [
        { label: 'Ordner importieren', click: () => void session.importDialog('folder') },
        { label: 'Dateien importieren', click: () => void session.importDialog('files') },
        { label: 'Beispielbilder laden', click: () => void session.importSamples() },
        { type: 'separator' },
        {
          label: 'Exportieren…',
          click: () => mainWindow?.webContents.send('menu:export')
        },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' }
      ]
    },
    {
      label: 'Hilfe',
      submenu: [
        { label: 'Nach Updates suchen', click: () => void updater.check(true) },
        { label: `Version ${app.getVersion()}`, enabled: false }
      ]
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Originalgröße' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' }
      ]
    }
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: 'Lichtkammer',
      submenu: [
        { role: 'about', label: 'Über Lichtkammer' },
        { type: 'separator' },
        { role: 'hide', label: 'Lichtkammer ausblenden' },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: 'Lichtkammer beenden' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  readyAt = Date.now()
  electronApp.setAppUserModelId('studio.lichtkammer.app')
  app.setName('Lichtkammer')
  await session.init()
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  protocol.handle('lkthumb', async (request) => {
    try {
      const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      const bytes = await session.thumbBytes(id)
      if (!bytes) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(bytes), {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' }
      })
    } catch {
      return new Response(null, { status: 500 })
    }
  })
  protocol.handle('lkraw', async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const edge = Number(url.searchParams.get('edge') ?? 2560)
      const purpose = url.searchParams.get('p') ?? 'main'
      if (!Number.isFinite(edge)) return new Response(null, { status: 400 })
      const raw = await session.rawPreview(id, edge, purpose)
      if (!raw) return new Response(null, { status: 404, headers: { 'access-control-allow-origin': '*' } })
      return new Response(raw.data as unknown as BodyInit, {
        headers: {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'x-lk-width, x-lk-height, x-lk-full-width, x-lk-full-height, x-lk-from',
          'x-lk-width': String(raw.width),
          'x-lk-height': String(raw.height),
          'x-lk-full-width': String(raw.fullWidth),
          'x-lk-full-height': String(raw.fullHeight),
          'x-lk-from': raw.developedFrom
        }
      })
    } catch {
      return new Response(null, { status: 500, headers: { 'access-control-allow-origin': '*' } })
    }
  })
  if (updateTestArg) {
    // Nur für den Update-Test im Workflow: ohne Fenster prüfen, laden und still installieren.
    await updater.runTest(updateTestArg.slice('--update-test='.length))
    return
  }
  registerIpc()
  buildMenu()
  createWindow()
  if (!smokeDir && !perfDir && !gpuDir) updater.start()
  if (gpuDir && mainWindow) {
    const ok = await runGpuTest(mainWindow, gpuDir)
    app.exit(ok ? 0 : 1)
    return
  }
  if (perfDir && mainWindow) {
    const ok = await runPerfTest(session, mainWindow, perfDir, perfPhotos, perfPhase, {
      processStart,
      ready: readyAt,
      shown: () => shownAt
    })
    app.exit(ok ? 0 : 1)
    return
  }
  if (smokeDir && mainWindow) {
    const ok = benchDir
      ? await runImportBench(session, mainWindow, benchDir, smokeDir)
      : await runSmokeTest(session, mainWindow, smokeDir)
    app.exit(ok ? 0 : 1)
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  ipcMain.handle('catalog:get', () => session.getCatalog())
  ipcMain.handle('import:dialog', (_event, kind: unknown) => {
    if (kind !== 'files' && kind !== 'folder') return
    return session.importDialog(kind)
  })
  ipcMain.handle('import:samples', () => session.importSamples())
  ipcMain.handle('import:paths', (_event, paths: unknown) => session.importPaths(stringList(paths)))
  ipcMain.handle('settings:set', (_event, settings: unknown) => {
    if (!isRecord(settings)) return session.getCatalog()
    return session.setSettings(settings as unknown as Settings)
  })
  ipcMain.handle('edits:set', (_event, id: unknown, edits: unknown) => {
    if (!isId(id) || !isRecord(edits)) return
    return session.setEdits(id, edits as unknown as EditParams)
  })
  ipcMain.handle('edits:auto', (_event, id: unknown) => (isId(id) ? session.applyAuto(id) : session.getCatalog()))
  ipcMain.handle('edits:autoPerfect', (_event, ids: unknown) => session.autoPerfect(Array.isArray(ids) ? stringList(ids) : undefined))
  ipcMain.handle('edits:applyTo', (_event, source: unknown, ids: unknown) =>
    isRecord(source) ? session.applyEditsTo(source as unknown as EditParams, stringList(ids)) : session.getCatalog()
  )
  ipcMain.handle('edits:reset', (_event, id: unknown) => (isId(id) ? session.resetEdits(id) : session.getCatalog()))
  ipcMain.handle('photos:restore', (_event, ids: unknown) => session.restore(stringList(ids)))
  ipcMain.handle('photos:blurry', (_event, ids: unknown) => session.markBlurry(stringList(ids)))
  ipcMain.handle('photos:remove', (_event, ids: unknown) => session.removeFromLibrary(stringList(ids)))
  ipcMain.handle('preview', (_event, id: unknown, edits: unknown, maxEdge: unknown, options: unknown) => {
    if (!isId(id) || (edits !== null && !isRecord(edits)) || typeof maxEdge !== 'number') return null
    const extra = isRecord(options) ? options : {}
    return session.preview(id, edits as EditParams | null, maxEdge, {
      ignoreCrop: extra.ignoreCrop === true,
      purpose: typeof extra.purpose === 'string' && extra.purpose.length < 40 ? extra.purpose : 'main'
    })
  })
  ipcMain.handle('looks', (_event, id: unknown, edits: unknown) => {
    if (!isId(id) || !isRecord(edits)) return null
    return session.lookPreviews(id, edits as unknown as EditParams)
  })
  ipcMain.handle('save:all', () => session.saveAll())
  ipcMain.handle('dialog:directory', () => session.chooseOutputDir())
  ipcMain.handle('export', (_event, options: unknown) => {
    if (!isExportOptions(options)) throw new Error('Ungültige Exportangaben.')
    return session.exportPhotos(options)
  })
  ipcMain.handle('culled:copy', () => session.copyCulled())
  ipcMain.handle('shell:show', (_event, target: unknown) => {
    if (typeof target !== 'string' || !isAbsolute(target)) return
    return session.showPath(target)
  })
  ipcMain.handle('update:get', () => updater.getState())
  ipcMain.handle('update:check', () => updater.check(true))
  ipcMain.handle('update:install', () => {
    updater.install()
  })
  ipcMain.handle('job:cancel', () => {
    session.cancel()
  })
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isAppNavigation(url: string): boolean {
  if (url.startsWith('file://')) return true
  const dev = process.env['ELECTRON_RENDERER_URL']
  return Boolean(is.dev && dev && url.startsWith(dev))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 200 && !value.includes('\0')
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5000) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length < 4096 && !item.includes('\0'))
}

function isExportOptions(value: unknown): value is ExportOptions {
  if (!isRecord(value)) return false
  return (
    typeof value.directory === 'string' &&
    isAbsolute(value.directory) &&
    !value.directory.includes('\0') &&
    (value.format === 'jpeg' || value.format === 'png') &&
    typeof value.quality === 'number' &&
    (value.scope === 'kept' || value.scope === 'selected')
  )
}
