import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  Catalog,
  CopyResult,
  EditParams,
  ExportOptions,
  ExportResult,
  JobProgress,
  Notice,
  PreviewPayload,
  Settings,
  UpdateState
} from '../shared/types'

const api = {
  getCatalog: (): Promise<Catalog> => ipcRenderer.invoke('catalog:get'),
  importDialog: (kind: 'files' | 'folder'): Promise<void> => ipcRenderer.invoke('import:dialog', kind),
  importSamples: (): Promise<void> => ipcRenderer.invoke('import:samples'),
  setSettings: (settings: Settings): Promise<Catalog> => ipcRenderer.invoke('settings:set', settings),
  setEdits: (id: string, edits: EditParams): Promise<void> => ipcRenderer.invoke('edits:set', id, edits),
  applyAuto: (id: string): Promise<Catalog> => ipcRenderer.invoke('edits:auto', id),
  autoPerfect: (ids?: string[]): Promise<Catalog> => ipcRenderer.invoke('edits:autoPerfect', ids),
  applyEditsTo: (source: EditParams, ids: string[]): Promise<Catalog> => ipcRenderer.invoke('edits:applyTo', source, ids),
  resetEdits: (id: string): Promise<Catalog> => ipcRenderer.invoke('edits:reset', id),
  restore: (ids: string[]): Promise<Catalog> => ipcRenderer.invoke('photos:restore', ids),
  markBlurry: (ids: string[]): Promise<Catalog> => ipcRenderer.invoke('photos:blurry', ids),
  removeFromLibrary: (ids: string[]): Promise<Catalog> => ipcRenderer.invoke('photos:remove', ids),
  preview: (
    id: string,
    edits: EditParams | null,
    maxEdge: number,
    options?: { ignoreCrop?: boolean; purpose?: string }
  ): Promise<PreviewPayload | null> => ipcRenderer.invoke('preview', id, edits, maxEdge, options ?? {}),
  lookPreviews: (id: string, edits: EditParams): Promise<string[] | null> => ipcRenderer.invoke('looks', id, edits),
  saveAll: (): Promise<ExportResult | null> => ipcRenderer.invoke('save:all'),
  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:directory'),
  exportPhotos: (options: ExportOptions): Promise<ExportResult> => ipcRenderer.invoke('export', options),
  copyCulled: (): Promise<CopyResult> => ipcRenderer.invoke('culled:copy'),
  showPath: (target: string): Promise<void> => ipcRenderer.invoke('shell:show', target),
  cancelJob: (): Promise<void> => ipcRenderer.invoke('job:cancel'),
  onCatalog: (callback: (catalog: Catalog) => void): (() => void) => subscribe('catalog:update', callback),
  onProgress: (callback: (progress: JobProgress) => void): (() => void) => subscribe('job:progress', callback),
  onNotice: (callback: (notice: Notice) => void): (() => void) => subscribe('notice', callback),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:get'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => subscribe('update:state', callback),
  gpuTestNext: (): Promise<unknown> => ipcRenderer.invoke('gputest:next'),
  gpuTestInfo: (info: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('gputest:info', info),
  gpuTestSubmit: (pixels: Uint8Array, ms: number): Promise<void> => ipcRenderer.invoke('gputest:submit', pixels, ms),
  onExportRequest: (callback: () => void): (() => void) => subscribe('menu:export', callback)
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error preload fallback
  window.electron = electronAPI
  // @ts-expect-error preload fallback
  window.api = api
}

window.addEventListener('dragover', (event) => {
  event.preventDefault()
})

window.addEventListener('drop', (event) => {
  event.preventDefault()
  const files = Array.from(event.dataTransfer?.files ?? [])
  const paths = files
    .map((file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    })
    .filter((filePath) => filePath.length > 0)
  if (paths.length > 0) void ipcRenderer.invoke('import:paths', paths)
})
