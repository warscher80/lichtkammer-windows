import { useEffect, useRef, useState } from 'react'
import type { EditParams, PhotoRecord } from '../../../shared/types'
import { editKey } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Separator } from '@renderer/components/ui/separator'
import { Slider } from '@renderer/components/ui/slider'
import { formatEdit, formatPixels, formatScore } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

const FIELDS: {
  key: keyof EditParams
  label: string
  group: 'Licht' | 'Farbe' | 'Details'
  min: number
  max: number
  step: number
  hint?: [string, string]
}[] = [
  { key: 'exposure', label: 'Belichtung', group: 'Licht', min: -2, max: 2, step: 0.05 },
  { key: 'contrast', label: 'Kontrast', group: 'Licht', min: -100, max: 100, step: 1 },
  { key: 'highlights', label: 'Lichter', group: 'Licht', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: 'Tiefen', group: 'Licht', min: -100, max: 100, step: 1 },
  { key: 'clarity', label: 'Klarheit', group: 'Licht', min: -100, max: 100, step: 1 },
  { key: 'temperature', label: 'Temperatur', group: 'Farbe', min: -100, max: 100, step: 1, hint: ['Kalt', 'Warm'] },
  { key: 'tint', label: 'Farbton', group: 'Farbe', min: -100, max: 100, step: 1, hint: ['Grün', 'Magenta'] },
  { key: 'vibrance', label: 'Dynamik', group: 'Farbe', min: -100, max: 100, step: 1 },
  { key: 'saturation', label: 'Sättigung', group: 'Farbe', min: -100, max: 100, step: 1 },
  { key: 'sharpen', label: 'Schärfung', group: 'Details', min: 0, max: 100, step: 1 },
  { key: 'noise', label: 'Rauschreduzierung', group: 'Details', min: 0, max: 100, step: 1 }
]

interface DevelopViewProps {
  photos: PhotoRecord[]
  selectedId: string | null
  thumbs: Record<string, string>
  onSelect: (id: string) => void
  onEdit: (id: string, edits: EditParams, dragging: boolean) => void
  onAuto: (id: string) => void
  onNeutral: (id: string) => void
}

export function DevelopView(props: DevelopViewProps) {
  const photo = props.photos.find((item) => item.id === props.selectedId) ?? props.photos.find((item) => item.status === 'kept') ?? null
  const strip = props.photos.filter((item) => item.status === 'kept' || item.id === photo?.id)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [histogram, setHistogram] = useState<number[]>([])
  const [split, setSplit] = useState(0.52)
  const [mode, setMode] = useState<'compare' | 'after'>('compare')
  const [holdBefore, setHoldBefore] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [loading, setLoading] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!photo) return
    let cancel = false
    void window.api.preview(photo.id, null, 1500).then((payload) => {
      if (!cancel) setBefore(payload.dataUrl)
    })
    return () => {
      cancel = true
    }
  }, [photo?.id])

  useEffect(() => {
    if (!photo) return
    let cancel = false
    setLoading(true)
    const handle = window.setTimeout(() => {
      void window.api
        .preview(photo.id, photo.edits, scrubbing ? 980 : 1500)
        .then((payload) => {
          if (cancel) return
          setAfter(payload.dataUrl)
          setHistogram(payload.histogram)
          setLoading(false)
        })
        .catch(() => {
          if (!cancel) setLoading(false)
        })
    }, scrubbing ? 30 : 0)
    return () => {
      cancel = true
      window.clearTimeout(handle)
    }
  }, [photo?.id, photo ? editKey(photo.edits) : '', scrubbing])

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === '\\') setHoldBefore(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === '\\') setHoldBefore(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  if (!photo) {
    return (
      <div className="flex h-full items-center justify-center text-ink-soft">
        Importiere Fotos, um sie zu entwickeln.
      </div>
    )
  }

  const showBeforeOnly = holdBefore
  const showCompare = mode === 'compare' && !showBeforeOnly

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_312px] grid-rows-[minmax(0,1fr)_92px]">
      <div ref={stageRef} className="relative min-h-0 bg-[#0b0c0e]">
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="relative h-full w-full">
            {after && (
              <img
                src={showBeforeOnly ? before || after : after}
                alt="Nachher"
                className={cn('absolute inset-0 h-full w-full object-contain', loading && 'opacity-80')}
              />
            )}
            {showCompare && before && (
              <img
                src={before}
                alt="Vorher"
                className="absolute inset-0 h-full w-full object-contain"
                style={{ clipPath: `inset(0 ${100 - split * 100}% 0 0)` }}
              />
            )}
            {showCompare && (
              <div
                className="absolute inset-y-6 w-px cursor-ew-resize bg-white/80"
                style={{ left: `${split * 100}%` }}
                onPointerDown={(event) => {
                  const target = event.currentTarget
                  target.setPointerCapture(event.pointerId)
                  const move = (ev: PointerEvent): void => {
                    const bounds = stageRef.current?.getBoundingClientRect()
                    if (!bounds) return
                    const ratio = (ev.clientX - bounds.left) / bounds.width
                    setSplit(Math.min(0.96, Math.max(0.04, ratio)))
                  }
                  const stop = (): void => {
                    target.removeEventListener('pointermove', move)
                    target.removeEventListener('pointerup', stop)
                  }
                  target.addEventListener('pointermove', move)
                  target.addEventListener('pointerup', stop)
                }}
              >
                <span className="absolute top-1/2 left-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-black/70" />
              </div>
            )}
          </div>
        </div>
        <div className="absolute top-3 left-3 flex gap-2 text-[11px] tracking-wide uppercase">
          <span className="rounded bg-black/60 px-2 py-1 text-ink-soft">Vorher</span>
          {!showBeforeOnly && <span className="rounded bg-brass px-2 py-1 text-brass-ink">Nachher</span>}
        </div>
        <div className="absolute top-3 right-3 flex gap-1 rounded-lg bg-black/50 p-1">
          <button
            className={cn('rounded px-2 py-1 text-[12px]', mode === 'compare' ? 'bg-white/15 text-ink' : 'text-ink-soft')}
            onClick={() => setMode('compare')}
          >
            Vergleich
          </button>
          <button
            className={cn('rounded px-2 py-1 text-[12px]', mode === 'after' ? 'bg-white/15 text-ink' : 'text-ink-soft')}
            onClick={() => setMode('after')}
          >
            Nachher
          </button>
        </div>
        <div className="absolute right-3 bottom-3 left-3 text-[11px] text-faint">
          {photo.fileName} · {formatPixels(photo.width, photo.height)} · Schärfe {formatScore(photo.sharpnessScore)}
          {showCompare ? ' · Trennlinie ziehen' : ''} · \\ halten für das Original
        </div>
      </div>
      <aside className="row-span-2 flex min-h-0 flex-col border-l border-white/10 bg-panel">
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[11px] tracking-[0.16em] text-faint uppercase">Entwicklung</div>
            <div className="text-[13px] text-ink-soft">Nicht destruktiv</div>
          </div>
          <div className="flex gap-1">
            <Button variant="quiet" size="sm" onClick={() => props.onAuto(photo.id)}>
              Auto
            </Button>
            <Button variant="ghost" size="sm" onClick={() => props.onNeutral(photo.id)}>
              Neutral
            </Button>
          </div>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-4 py-4">
            <Histogram bins={histogram} />
            {(['Licht', 'Farbe', 'Details'] as const).map((group) => (
              <section key={group} className="space-y-3">
                <h3 className="text-[11px] tracking-[0.16em] text-faint uppercase">{group}</h3>
                {FIELDS.filter((field) => field.group === group).map((field) => {
                  const value = photo.edits[field.key]
                  const auto = photo.autoEdits[field.key]
                  const dirty = Math.abs(value - auto) > field.step / 2
                  return (
                    <div
                      key={field.key}
                      onPointerDown={() => setScrubbing(true)}
                      onPointerUp={() => setScrubbing(false)}
                      onPointerCancel={() => setScrubbing(false)}
                    >
                      <div
                        className="mb-1.5 flex items-baseline justify-between text-[12px]"
                        onDoubleClick={() => props.onEdit(photo.id, { ...photo.edits, [field.key]: auto }, false)}
                        title="Doppelklick setzt den Auto-Wert"
                      >
                        <span>{field.label}</span>
                        <span className={dirty ? 'text-brass' : 'text-ink-soft'}>{formatEdit(field.key, value)}</span>
                      </div>
                      <Slider
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={[value]}
                        aria-label={field.label}
                        onValueChange={([next]) =>
                          props.onEdit(photo.id, { ...photo.edits, [field.key]: next }, true)
                        }
                        onValueCommit={() => setScrubbing(false)}
                      />
                      {field.hint && (
                        <div className="mt-1 flex justify-between text-[10px] text-faint">
                          <span>{field.hint[0]}</span>
                          <span>{field.hint[1]}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        </ScrollArea>
      </aside>
      <div className="flex items-center gap-2 overflow-x-auto border-t border-white/10 bg-[#14171b] px-3">
        {strip.map((item) => {
          const src = props.thumbs[`${item.id}:${editKey(item.edits)}`]
          return (
            <button
              key={item.id}
              className={cn(
                'h-[68px] w-[96px] shrink-0 overflow-hidden rounded-md bg-black ring-1',
                item.id === photo.id ? 'ring-brass' : 'ring-white/10'
              )}
              onClick={() => props.onSelect(item.id)}
            >
              {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <div className="h-full animate-pulse bg-white/5" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Histogram({ bins }: { bins: number[] }) {
  if (bins.length === 0) {
    return <div className="h-14 rounded-md bg-black/30" />
  }
  return (
    <div className="flex h-14 items-end gap-px rounded-md bg-black/30 px-2 py-2">
      {bins.map((value, index) => (
        <div
          key={index}
          className="flex-1 rounded-t-[1px] bg-brass/80"
          style={{ height: `${Math.max(6, value * 100)}%` }}
        />
      ))}
    </div>
  )
}
