import { useCallback, useEffect, useRef, useState } from 'react'
import type { Catalog, EditParams, JobProgress, Notice, Settings, UpdateState } from '../../shared/types'
import { CulledView } from '@renderer/components/CulledView'
import { DevelopView } from '@renderer/components/DevelopView'
import { ExportDialog } from '@renderer/components/ExportDialog'
import { LibraryView } from '@renderer/components/LibraryView'
import { TopBar, type ViewId } from '@renderer/components/TopBar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [view, setView] = useState<ViewId>('library')
  const [culledTab, setCulledTab] = useState<'blurry' | 'duplicate'>('blurry')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const openDevelop = useCallback((id: string) => {
    setSelectedId(id)
    setView('develop')
  }, [])
  const dragDepth = useRef(0)
  const settingsTimer = useRef<number | null>(null)

  useEffect(() => {
    void window.api.getCatalog().then((next) => {
      setCatalog(next)
      setSelectedId(next.photos.find((photo) => photo.status === 'kept')?.id ?? next.photos[0]?.id ?? null)
    })
    const offCatalog = window.api.onCatalog((next) => setCatalog(next))
    const offProgress = window.api.onProgress(setProgress)
    const offNotice = window.api.onNotice((item) => {
      setNotice(item)
      window.setTimeout(() => {
        setNotice((current) => (current?.message === item.message ? null : current))
      }, 5600)
    })
    const offExport = window.api.onExportRequest(() => setExportOpen(true))
    const enter = (): void => {
      dragDepth.current += 1
      setDragging(true)
    }
    const leave = (): void => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const drop = (): void => {
      dragDepth.current = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      offCatalog()
      offProgress()
      offNotice()
      offExport()
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  useEffect(() => {
    void window.api.getUpdateState().then(setUpdate)
    return window.api.onUpdateState(setUpdate)
  }, [])

  useEffect(() => {
    if (!catalog) return
    if (selectedId && catalog.photos.some((photo) => photo.id === selectedId)) return
    setSelectedId(catalog.photos.find((photo) => photo.status === 'kept')?.id ?? catalog.photos[0]?.id ?? null)
  }, [catalog, selectedId])

  useEffect(() => {
    // Für den Rauchtest: Entwickeln öffnen.
    ;(window as unknown as { __lkOpenDevelop?: () => void }).__lkOpenDevelop = () => setView('develop')
  }, [])

  if (!catalog) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <div className="wordmark text-3xl">Lichtkammer</div>
      </div>
    )
  }

  const kept = catalog.photos.filter((photo) => photo.status === 'kept').length
  const blurry = catalog.photos.filter((photo) => photo.status === 'blurry').length
  const duplicates = catalog.photos.filter((photo) => photo.status === 'duplicate').length
  const busy = Boolean(progress?.active)
  const importing = busy && progress?.phase === 'import'

  function updateSettings(settings: Settings): void {
    setCatalog((current) => (current ? { ...current, settings } : current))
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = window.setTimeout(() => {
      void window.api.setSettings(settings).then(setCatalog)
    }, 80)
  }

  function saveAll(): void {
    void window.api.saveAll().catch((error: unknown) => {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Sichern fehlgeschlagen' })
    })
  }

  function edit(id: string, edits: EditParams, _dragging: boolean): void {
    setCatalog((current) =>
      current
        ? {
            ...current,
            photos: current.photos.map((photo) => (photo.id === id ? { ...photo, edits } : photo))
          }
        : current
    )
    void window.api.setEdits(id, edits)
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-canvas text-ink">
        <TopBar
          view={view}
          onView={setView}
          kept={kept}
          blurry={blurry}
          duplicates={duplicates}
          busy={busy}
          importing={importing}
          onImportFolder={() => void window.api.importDialog('folder')}
          onImportFiles={() => void window.api.importDialog('files')}
          onSamples={() => void window.api.importSamples()}
          onExport={() => setExportOpen(true)}
          onSaveAll={saveAll}
        />
        {busy && progress && (
          <div className="border-b border-white/10 bg-panel px-4 py-2">
            <div className="mb-1 flex items-center justify-between text-[12px] text-ink-soft">
              <span>{progressText(progress)}</span>
              <button className="text-brass" onClick={() => void window.api.cancelJob()}>
                Abbrechen
              </button>
            </div>
            <div className="h-[3px] overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-brass transition-[width]"
                style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 8}%` }}
              />
            </div>
          </div>
        )}
        {update?.status === 'ready' && (
          <div className="flex items-center justify-between gap-4 border-b border-brass/40 bg-[#2a2113] px-4 py-2 text-[13px]">
            <span>
              Neue Version verfügbar – Jetzt neu starten und aktualisieren
              {update.version ? ` (${update.version})` : ''}
            </span>
            <button
              className="rounded-md bg-brass px-3 py-1 text-[12px] font-medium text-brass-ink hover:brightness-110"
              onClick={() => void window.api.installUpdate()}
            >
              Jetzt neu starten
            </button>
          </div>
        )}
        {update?.status === 'downloading' && (
          <div className="border-b border-white/10 bg-panel px-4 py-1.5 text-[12px] text-ink-soft">
            Neue Version {update.version ?? ''} wird im Hintergrund geladen… {update.percent ?? 0} %
          </div>
        )}
        <main className="relative min-h-0 flex-1">
          {view === 'library' && (
            <LibraryView
              photos={catalog.photos}
              settings={catalog.settings}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={openDevelop}
              onSettings={updateSettings}
              onMarkBlurry={(id) => void window.api.markBlurry([id]).then(setCatalog)}
              onRemove={(id) => {
                void window.api.removeFromLibrary([id]).then(setCatalog)
                setSelectedId(null)
              }}
              onImportFolder={() => void window.api.importDialog('folder')}
              onImportFiles={() => void window.api.importDialog('files')}
              onSamples={() => void window.api.importSamples()}
              onShowCulled={(which) => {
                setCulledTab(which)
                setView('culled')
              }}
            />
          )}
          {view === 'culled' && (
            <CulledView
              photos={catalog.photos}
              tab={culledTab}
              onTab={setCulledTab}
              threshold={catalog.settings.blurThreshold}
              onRestore={(ids) => void window.api.restore(ids).then(setCatalog)}
              onOpen={(id) => {
                setSelectedId(id)
                setView('develop')
              }}
              onCopy={() => void window.api.copyCulled()}
            />
          )}
          {view === 'develop' && (
            <DevelopView
              photos={catalog.photos}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onEdit={edit}
              onAuto={(id) => void window.api.applyAuto(id).then(setCatalog)}
              onNeutral={(id) => void window.api.resetEdits(id).then(setCatalog)}
              onSaveAll={saveAll}
            />
          )}
          {dragging && (
            <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border border-dashed border-brass bg-black/55">
              <div className="text-center">
                <div className="wordmark text-3xl">Loslassen zum Importieren</div>
                <p className="mt-2 text-[13px] text-ink-soft">Ordner oder Fotos. Nichts wird gelöscht.</p>
              </div>
            </div>
          )}
        </main>
        <footer className="flex h-8 items-center justify-between border-t border-white/10 bg-panel px-4 text-[11px] text-faint">
          <span>
            {kept} behalten · {blurry} unscharf · {duplicates} Duplikate
          </span>
          <span className="flex items-center gap-3">
            <span>Originale bleiben unberührt</span>
            <button
              className="text-ink-soft hover:text-ink"
              title="Prüft, ob es eine neuere Version gibt"
              onClick={() => void window.api.checkForUpdates()}
            >
              {updateLabel(update)}
            </button>
          </span>
        </footer>
        {notice && (
          <div className="absolute bottom-12 left-1/2 z-30 max-w-xl -translate-x-1/2 rounded-full border border-white/10 bg-[#2a241b] px-4 py-2 text-[13px] text-ink shadow-xl">
            {notice.message}
          </div>
        )}
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} photos={catalog.photos} selectedId={selectedId} />
      </div>
    </TooltipProvider>
  )
}

function progressText(progress: JobProgress): string {
  if (progress.phase === 'import') {
    const eta = progress.etaSeconds
    const rest = eta === null || eta === undefined ? '' : eta <= 1 ? ' · gleich fertig' : ` · noch ca. ${formatDuration(eta)}`
    const cached = progress.cached ? ` (${progress.cached} schon bekannt)` : ''
    return `Analysiert ${progress.current} von ${progress.total}${cached}${rest} · du kannst schon arbeiten`
  }
  const verb = progress.phase === 'export' ? 'Exportiert' : 'Kopiert'
  return `${verb} ${progress.current} von ${progress.total}${progress.label ? ` · ${progress.label}` : ''}`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} min ${rest} s`
}

function updateLabel(update: UpdateState | null): string {
  if (!update) return ''
  const version = `Version ${update.currentVersion}`
  switch (update.status) {
    case 'checking':
      return `${version} · suche Updates…`
    case 'none':
      return `${version} · aktuell · Nach Updates suchen`
    case 'error':
      return `${version} · Suche fehlgeschlagen · Erneut versuchen`
    case 'downloading':
      return `${version} · lädt Update…`
    case 'ready':
      return `${version} · Update bereit`
    default:
      return `${version} · Nach Updates suchen`
  }
}
