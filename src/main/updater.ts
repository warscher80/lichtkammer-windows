import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { writeFile } from 'node:fs/promises'
import type { UpdateState } from '../shared/types'

/**
 * Automatische Updates über GitHub Releases (warscher80/lichtkammer-windows).
 * Beim Start wird geprüft, ein Update lädt im Hintergrund, danach erscheint ein Hinweis.
 * Funktioniert ohne Signatur (NSIS). Nur in der installierten App aktiv.
 */
export class Updater {
  private state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
  private started = false
  private manual = false

  constructor(private readonly emit: (state: UpdateState) => void) {}

  getState(): UpdateState {
    return this.state
  }

  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next, currentVersion: app.getVersion() }
    this.emit(this.state)
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (!app.isPackaged || process.platform !== 'win32') {
      this.set({ status: 'unsupported' })
      return
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', message: undefined }))
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, percent: 0 })
    )
    autoUpdater.on('update-not-available', () => {
      this.set({ status: 'none', version: undefined, percent: undefined })
    })
    autoUpdater.on('download-progress', (progress) =>
      this.set({ status: 'downloading', percent: Math.round(progress.percent) })
    )
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, percent: 100 }))
    autoUpdater.on('error', (error) =>
      this.set({ status: 'error', message: error instanceof Error ? error.message.slice(0, 200) : 'Unbekannter Fehler' })
    )
    // Kurz nach dem Start prüfen, damit das Fenster zuerst erscheint.
    setTimeout(() => void this.check(false), 4000)
    // Und danach alle 6 Stunden, falls die App lange offen bleibt.
    setInterval(() => void this.check(false), 6 * 60 * 60 * 1000).unref()
  }

  async check(manual: boolean): Promise<UpdateState> {
    this.manual = manual
    if (this.state.status === 'unsupported' || !this.started) return this.state
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.state
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.set({ status: 'error', message: error instanceof Error ? error.message.slice(0, 200) : 'Prüfung fehlgeschlagen' })
    }
    return this.state
  }

  install(): void {
    if (this.state.status !== 'ready') return
    // Installation ohne Dialog, danach startet Lichtkammer wieder.
    autoUpdater.quitAndInstall(true, true)
  }

  wasManual(): boolean {
    return this.manual
  }

  /**
   * Testmodus für CI (--update-test=Ordner): prüft, lädt, installiert still und schreibt einen Bericht.
   * Die installierte Version prüft danach der Workflow.
   */
  async runTest(outDir: string): Promise<void> {
    const report: Record<string, unknown> = { from: app.getVersion(), events: [] as string[] }
    const events = report.events as string[]
    const write = async (): Promise<void> => {
      await writeFile(`${outDir}/update-test.json`, JSON.stringify(report, null, 2))
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => events.push('prüfe'))
    autoUpdater.on('update-available', (info) => events.push(`gefunden ${info.version}`))
    autoUpdater.on('update-not-available', () => events.push('kein Update'))
    autoUpdater.on('error', (error) => events.push(`Fehler: ${String(error).slice(0, 300)}`))
    const downloaded = new Promise<string>((resolve) => {
      autoUpdater.on('update-downloaded', (info) => resolve(info.version))
      autoUpdater.on('update-not-available', () => resolve(''))
      autoUpdater.on('error', () => resolve(''))
    })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      events.push(`Fehler: ${String(error).slice(0, 300)}`)
    }
    const version = await Promise.race([downloaded, new Promise<string>((resolve) => setTimeout(() => resolve(''), 240_000))])
    report.to = version
    report.ok = version !== ''
    await write()
    if (version) {
      events.push('installiere')
      await write()
      autoUpdater.quitAndInstall(true, false)
    } else {
      app.exit(1)
    }
  }
}
