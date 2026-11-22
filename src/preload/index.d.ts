import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Catalog,
  CopyResult,
  EditParams,
  ExportOptions,
  ExportResult,
  JobProgress,
  Notice,
  PreviewPayload,
  Settings
} from '../shared/types'

export interface LichtkammerApi {
  getCatalog: () => Promise<Catalog>
  importDialog: (kind: 'files' | 'folder') => Promise<void>
  importSamples: () => Promise<void>
  setSettings: (settings: Settings) => Promise<Catalog>
  setEdits: (id: string, edits: EditParams) => Promise<void>
  applyAuto: (id: string) => Promise<Catalog>
  resetEdits: (id: string) => Promise<Catalog>
  restore: (ids: string[]) => Promise<Catalog>
  markBlurry: (ids: string[]) => Promise<Catalog>
  removeFromLibrary: (ids: string[]) => Promise<Catalog>
  preview: (
    id: string,
    edits: EditParams | null,
    maxEdge: number,
    options?: { ignoreCrop?: boolean; purpose?: string }
  ) => Promise<PreviewPayload | null>
  lookPreviews: (id: string, edits: EditParams) => Promise<string[] | null>
  saveAll: () => Promise<ExportResult | null>
  thumb: (id: string) => Promise<string>
  chooseOutputDir: () => Promise<string | null>
  exportPhotos: (options: ExportOptions) => Promise<ExportResult>
  copyCulled: () => Promise<CopyResult>
  showPath: (target: string) => Promise<void>
  cancelJob: () => Promise<void>
  onCatalog: (callback: (catalog: Catalog) => void) => () => void
  onProgress: (callback: (progress: JobProgress) => void) => () => void
  onNotice: (callback: (notice: Notice) => void) => () => void
  onExportRequest: (callback: () => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: LichtkammerApi
  }
}
