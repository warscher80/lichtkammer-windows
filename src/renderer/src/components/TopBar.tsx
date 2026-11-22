import { FolderOpen, Images, Sparkles, Download } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

export type ViewId = 'library' | 'culled' | 'develop'

interface TopBarProps {
  view: ViewId
  onView: (view: ViewId) => void
  kept: number
  blurry: number
  duplicates: number
  busy: boolean
  onImportFolder: () => void
  onImportFiles: () => void
  onSamples: () => void
  onExport: () => void
}

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'library', label: 'Bibliothek' },
  { id: 'culled', label: 'Aussortiert' },
  { id: 'develop', label: 'Entwickeln' }
]

export function TopBar(props: TopBarProps) {
  return (
    <header className="flex h-[52px] items-center gap-4 border-b border-white/10 bg-panel px-4">
      <div className="flex items-center gap-2.5 pr-2">
        <Aperture />
        <div className="leading-none">
          <div className="wordmark text-[22px] text-ink">Lichtkammer</div>
          <div className="mt-0.5 text-[9px] tracking-[0.22em] text-faint uppercase">Sichten & entwickeln</div>
        </div>
      </div>
      <nav className="flex items-center gap-1">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            className={cn(
              'relative px-3 py-2 text-[13px] tracking-wide',
              props.view === item.id ? 'text-ink' : 'text-ink-soft hover:text-ink'
            )}
            onClick={() => props.onView(item.id)}
          >
            {item.label}
            {item.id === 'culled' && props.blurry + props.duplicates > 0 && (
              <span className="ml-1.5 text-[11px] text-brass">{props.blurry + props.duplicates}</span>
            )}
            {props.view === item.id && <span className="absolute right-3 bottom-1 left-3 h-px bg-brass" />}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="quiet" onClick={props.onSamples} disabled={props.busy}>
          <Sparkles className="size-3.5" />
          Beispiele
        </Button>
        <Button variant="outline" onClick={props.onImportFolder} disabled={props.busy}>
          <FolderOpen className="size-3.5" />
          Ordner
        </Button>
        <Button variant="outline" onClick={props.onImportFiles} disabled={props.busy}>
          <Images className="size-3.5" />
          Dateien
        </Button>
        <Button onClick={props.onExport} disabled={props.busy || props.kept === 0}>
          <Download className="size-3.5" />
          Export
        </Button>
      </div>
    </header>
  )
}

function Aperture() {
  return (
    <svg viewBox="0 0 32 32" className="size-8 text-brass" aria-hidden="true">
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16" cy="16" r="3.2" fill="currentColor" />
      <path
        d="M16 5.5v3.2M16 23.3V26.5M5.5 16h3.2M23.3 16H26.5M8.4 8.4l2.2 2.2M21.4 21.4l2.2 2.2M23.6 8.4l-2.2 2.2M10.6 21.4l-2.2 2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
