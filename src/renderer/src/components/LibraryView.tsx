import { memo, useEffect, type ReactNode } from 'react'
import { FolderOpen, Images, Save, Sparkles } from 'lucide-react'
import { MOTIF_LABELS } from '../../../shared/motif'
import type { PhotoRecord, Settings } from '../../../shared/types'
import { thumbUrl } from '@renderer/lib/thumb'
import { Button } from '@renderer/components/ui/button'
import { Slider } from '@renderer/components/ui/slider'
import { formatPixels, formatScore } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

interface LibraryViewProps {
  photos: PhotoRecord[]
  settings: Settings
  selectedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onSettings: (settings: Settings) => void
  onMarkBlurry: (id: string) => void
  onRemove: (id: string) => void
  onShowCulled: (which: 'blurry' | 'duplicate') => void
  onImportFolder: () => void
  onImportFiles: () => void
  onSamples: () => void
  onAutoPerfect: () => void
  onSaveAll: () => void
  busy: boolean
}

export function LibraryView(props: LibraryViewProps) {
  const kept = props.photos.filter((photo) => photo.status === 'kept')
  const blurry = props.photos.filter((photo) => photo.status === 'blurry').length
  const duplicates = props.photos.filter((photo) => photo.status === 'duplicate').length
  const selected = props.photos.find((photo) => photo.id === props.selectedId) ?? null
  const seriesSize = new Map<string, number>()
  for (const photo of props.photos) if (photo.groupId) seriesSize.set(photo.groupId, (seriesSize.get(photo.groupId) ?? 0) + 1)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && props.selectedId && (event.target === document.body || (event.target as HTMLElement | null)?.hasAttribute?.('data-photo-card'))) {
        props.onOpen(props.selectedId)
        return
      }
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      if (kept.length === 0) return
      const index = Math.max(0, kept.findIndex((photo) => photo.id === props.selectedId))
      const next = event.key === 'ArrowRight' ? (index + 1) % kept.length : (index - 1 + kept.length) % kept.length
      props.onSelect(kept[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kept, props])

  return (
    <div className="grid h-full min-h-0 grid-cols-[268px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-5 overflow-auto border-r border-white/10 bg-panel px-4 py-4">
        <section>
          <h2 className="text-[11px] tracking-[0.16em] text-faint uppercase">Bestand</h2>
          <ul className="mt-2 space-y-1 text-[13px]">
            <Count label="Behalten" value={kept.length} tone="text-keep" />
            <button className="flex w-full justify-between py-1 text-left" onClick={() => props.onShowCulled('blurry')}>
              <span className="text-ink-soft">Unscharf</span>
              <span className="text-blur">{blurry}</span>
            </button>
            <button className="flex w-full justify-between py-1 text-left" onClick={() => props.onShowCulled('duplicate')}>
              <span className="text-ink-soft">Duplikate</span>
              <span className="text-brass">{duplicates}</span>
            </button>
          </ul>
        </section>
        <section className="space-y-4">
          <h2 className="text-[11px] tracking-[0.16em] text-faint uppercase">Schwellen</h2>
          <Threshold
            label="Unscharf unter"
            valueLabel={formatScore(props.settings.blurThreshold)}
            help="Niedrig sortiert nur deutlich weiche Bilder aus. Hoch ist strenger."
            min={0}
            max={80}
            step={1}
            value={props.settings.blurThreshold}
            onChange={(value) => props.onSettings({ ...props.settings, blurThreshold: value })}
          />
          <Threshold
            label="Duplikat-Toleranz"
            valueLabel={`${Math.round(props.settings.duplicateDistance)} / 64`}
            help="0 erkennt nur identische Hashes. 8 fasst Serienaufnahmen zusammen."
            min={0}
            max={20}
            step={1}
            value={props.settings.duplicateDistance}
            onChange={(value) => props.onSettings({ ...props.settings, duplicateDistance: value })}
          />
        </section>
        {selected && (
          <section className="mt-auto space-y-2 border-t border-white/10 pt-4">
            <div className="truncate text-[13px] text-ink">{selected.fileName}</div>
            <div className="text-[12px] text-ink-soft">
              {formatPixels(selected.width, selected.height)} · Schärfe {formatScore(selected.sharpnessScore)}
            </div>
            <div className="flex flex-col gap-2 pt-1">
              <Button onClick={() => props.onOpen(selected.id)}>Bearbeiten</Button>
              <Button variant="ghost" onClick={() => props.onMarkBlurry(selected.id)}>
                Als unscharf markieren
              </Button>
              <Button variant="ghost" onClick={() => props.onRemove(selected.id)}>
                Aus der Bibliothek nehmen
              </Button>
            </div>
          </section>
        )}
      </aside>
      <div data-library-scroll className="min-h-0 overflow-auto p-4">
        {kept.length === 0 ? (
          <EmptyLibrary
            total={props.photos.length}
            onImportFolder={props.onImportFolder}
            onImportFiles={props.onImportFiles}
            onSamples={props.onSamples}
          />
        ) : (
          <>
          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-xl bg-gradient-to-r from-brass/20 to-brass/5 px-5 py-4 ring-1 ring-brass/40">
            <div className="min-w-[260px] flex-1">
              <div className="text-[16px] text-ink">{kept.length} {kept.length === 1 ? 'Foto' : 'Fotos'} bereit</div>
              <div className="mt-0.5 text-[13px] text-ink-soft">
                Ein Klick verbessert Licht und Farbe und wählt zu jedem Foto den passenden Look (Porträt, Landschaft, Nacht …). Danach „Alle sichern“.
              </div>
            </div>
            <Button size="lg" onClick={props.onAutoPerfect} disabled={props.busy}>
              <Sparkles className="size-4" /> Automatisch perfekt
            </Button>
            <Button size="lg" variant="outline" onClick={props.onSaveAll} disabled={props.busy}>
              <Save className="size-4" /> Alle sichern
            </Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
            {kept.map((photo) => (
              <PhotoTile
                key={photo.id}
                photo={photo}
                series={photo.groupId ? seriesSize.get(photo.groupId) ?? 0 : 0}
                selected={photo.id === props.selectedId}
                src={thumbUrl(photo)}
                onSelect={props.onSelect}
                onOpen={props.onOpen}
              />
            ))}
          </div>
          </>
        )}
      </div>
    </div>
  )
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <li className="flex justify-between py-1">
      <span className="text-ink-soft">{label}</span>
      <span className={tone}>{value}</span>
    </li>
  )
}

function Threshold(props: {
  label: string
  valueLabel: string
  help: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-[13px]">
        <span>{props.label}</span>
        <span className="text-brass">{props.valueLabel}</span>
      </div>
      <Slider
        min={props.min}
        max={props.max}
        step={props.step}
        value={[props.value]}
        onValueChange={([value]) => props.onChange(value)}
        aria-label={props.label}
      />
      <p className="mt-2 text-[11px] leading-relaxed text-faint">{props.help}</p>
    </div>
  )
}

const PhotoTile = memo(function PhotoTile(props: {
  photo: PhotoRecord
  series: number
  selected: boolean
  src: string
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}) {
  return (
    <button
      data-photo-card
      title="Doppelklick zum Bearbeiten"
      className={cn(
        'overflow-hidden rounded-lg bg-[#0c0d10] text-left ring-1 transition',
        props.selected ? 'ring-brass' : 'ring-white/10 hover:ring-white/25'
      )}
      onClick={() => props.onSelect(props.photo.id)}
      onDoubleClick={() => props.onOpen(props.photo.id)}
    >
      <div className="flex aspect-[3/2] items-center justify-center">
        <img src={props.src} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12px]">{props.photo.fileName}</div>
          <div className="text-[11px] text-faint">Schärfe {formatScore(props.photo.sharpnessScore)}</div>
        </div>
        {props.series > 1 && (
          <span className="shrink-0 rounded bg-keep/15 px-1.5 py-0.5 text-[10px] text-keep" title="Aus einer Serie ähnlicher Fotos wurde automatisch die beste Aufnahme behalten">
            Beste von {props.series}
          </span>
        )}
        {props.photo.motif && props.photo.motif !== 'other' && !props.series && (
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-ink-soft">{MOTIF_LABELS[props.photo.motif]}</span>
        )}
        {props.photo.developedFrom === 'sensor' && (
          <span className="shrink-0 rounded bg-brass/15 px-1.5 py-0.5 text-[10px] tracking-wide text-brass uppercase">
            RAW
          </span>
        )}
        {props.photo.developedFrom === 'embedded-preview' && (
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] tracking-wide text-ink-soft uppercase">
            Vorschau
          </span>
        )}
      </div>
    </button>
  )
}, (a, b) =>
  a.src === b.src &&
  a.selected === b.selected &&
  a.onSelect === b.onSelect &&
  a.onOpen === b.onOpen &&
  a.photo.fileName === b.photo.fileName &&
  a.photo.sharpnessScore === b.photo.sharpnessScore &&
  a.photo.developedFrom === b.photo.developedFrom &&
  a.photo.motif === b.photo.motif &&
  a.series === b.series
)

function EmptyLibrary(props: {
  total: number
  onImportFolder: () => void
  onImportFiles: () => void
  onSamples: () => void
}) {
  if (props.total > 0) {
    return (
      <div className="flex h-full items-center justify-center text-center text-ink-soft">
        <div>
          <p className="text-ink">Alle Fotos liegen in „Aussortiert“.</p>
          <p className="mt-1 text-[13px]">Schwellen lockern oder Bilder wiederherstellen.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-xl text-center">
        <p className="wordmark text-5xl text-ink">Willkommen in der Lichtkammer.</p>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
          So einfach geht’s: 1. Fotos holen · 2. „Automatisch perfekt“ klicken · 3. Wenn du magst: Foto doppelklicken, Look antippen
          (Tasten 1–9) · 4. „Alle sichern“. Unscharfe und doppelte Fotos sortiert Lichtkammer von selbst aus.
          Deine Originale werden nie verändert.
        </p>
        <div className="mt-8 grid grid-cols-3 gap-3">
          <BigAction icon={<FolderOpen className="size-7" />} label="Ordner öffnen" onClick={props.onImportFolder} />
          <BigAction icon={<Images className="size-7" />} label="Fotos auswählen" onClick={props.onImportFiles} />
          <BigAction icon={<Sparkles className="size-7" />} label="Beispiele ansehen" onClick={props.onSamples} />
        </div>
        <p className="mt-6 text-[12px] text-faint">
          Oder einfach einen Ordner hierher ziehen. JPG, PNG, TIFF, WEBP und RAW (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2).
        </p>
      </div>
    </div>
  )
}

function BigAction(props: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className="flex flex-col items-center gap-3 rounded-xl bg-white/5 px-4 py-6 text-[14px] text-ink ring-1 ring-white/10 transition hover:bg-white/10 hover:ring-brass/60"
      onClick={props.onClick}
    >
      <span className="text-brass">{props.icon}</span>
      {props.label}
    </button>
  )
}
