import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Crop, Maximize, RotateCcw, RotateCw, Sparkles, Sun, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import type { CropRect, EditParams, PhotoRecord, ScalarKey } from '../../../shared/types'
import { BAND_COLORS, BAND_NAMES, cloneEdits, editKey, NEUTRAL_EDITS } from '../../../shared/types'
import { AUTOMATIC_LOOK, LOOKS } from '../../../shared/looks'
import { Button } from '@renderer/components/ui/button'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Separator } from '@renderer/components/ui/separator'
import { Slider } from '@renderer/components/ui/slider'
import { formatEdit, formatPixels } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { getEngine } from '@renderer/lib/gpu/shared'
import type { EngineInfo } from '@renderer/lib/gpu/engine'

interface Field {
  key: ScalarKey
  label: string
  min: number
  max: number
  step: number
  hint?: [string, string]
}

const LIGHT: Field[] = [
  { key: 'exposure', label: 'Belichtung', min: -3, max: 3, step: 0.05, hint: ['Dunkler', 'Heller'] },
  { key: 'contrast', label: 'Kontrast', min: -100, max: 100, step: 1 },
  { key: 'highlights', label: 'Lichter', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: 'Tiefen', min: -100, max: 100, step: 1 },
  { key: 'whites', label: 'Weiß', min: -100, max: 100, step: 1 },
  { key: 'blacks', label: 'Schwarz', min: -100, max: 100, step: 1 }
]

const COLOR: Field[] = [
  { key: 'temperature', label: 'Temperatur', min: -100, max: 100, step: 1, hint: ['Kalt', 'Warm'] },
  { key: 'tint', label: 'Tönung', min: -100, max: 100, step: 1, hint: ['Grün', 'Magenta'] },
  { key: 'vibrance', label: 'Dynamik', min: -100, max: 100, step: 1 },
  { key: 'saturation', label: 'Sättigung', min: -100, max: 100, step: 1 }
]

const DETAIL: Field[] = [
  { key: 'clarity', label: 'Klarheit', min: -100, max: 100, step: 1 },
  { key: 'sharpen', label: 'Schärfen', min: 0, max: 100, step: 1 },
  { key: 'noise', label: 'Rauschen entfernen', min: 0, max: 100, step: 1 }
]

const ASPECTS: { id: string; label: string; ratio: number | 'original' | null }[] = [
  { id: 'free', label: 'Frei', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 }
]

const LOOK_TILE_W = 160
const LOOK_TILE_H = 116
const LOOK_COLUMNS = 4

const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 }

interface DevelopViewProps {
  photos: PhotoRecord[]
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit: (id: string, edits: EditParams, dragging: boolean) => void
  onAuto: (id: string) => void
  onNeutral: (id: string) => void
  onSaveAll: () => void
}

export function DevelopView(props: DevelopViewProps) {
  const photo = props.photos.find((item) => item.id === props.selectedId) ?? props.photos.find((item) => item.status === 'kept') ?? null
  const strip = props.photos.filter((item) => item.status === 'kept' || item.id === photo?.id)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState<{ url: string; width: number; height: number } | null>(null)
  const [histogram, setHistogram] = useState<number[]>([])
  const [split, setSplit] = useState(0.5)
  const [compare, setCompare] = useState(false)
  const [holdBefore, setHoldBefore] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cropMode, setCropMode] = useState(false)
  const [aspect, setAspect] = useState('free')
  const [draftCrop, setDraftCrop] = useState<CropRect | null>(null)
  const [hslMode, setHslMode] = useState<'hslHue' | 'hslSat' | 'hslLum'>('hslSat')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [stage, setStage] = useState({ width: 800, height: 600 })
  const [looks, setLooks] = useState<string[]>([])
  const stageRef = useRef<HTMLDivElement>(null)
  const gpuHost = useMemo(() => getEngine(), [])
  const gpu = gpuHost?.engine ?? null
  const [gpuInfo, setGpuInfo] = useState<EngineInfo | null>(gpu?.lastInfo ?? null)
  const lookCanvases = useRef<(HTMLCanvasElement | null)[]>([])
  const dims = gpu ? gpuInfo : after

  const edits = photo?.edits ?? NEUTRAL_EDITS
  const key = editKey(edits)
  const geometryKey = JSON.stringify([edits.rotate, edits.straighten, edits.crop])
  const lookBaseKey = editKey({ ...edits, preset: null, presetStrength: 100 })
  const previewEdge = zoom > 1.25 ? 3600 : scrubbing ? 1100 : 1700

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setStage({ width: element.clientWidth, height: element.clientHeight })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Grafikkarten-Zeichenfläche in die Bühne einhängen.
  useEffect(() => {
    const element = stageRef.current
    if (!gpuHost || !element) return
    element.insertBefore(gpuHost.canvas, element.firstChild)
    gpuHost.engine.onInfo = (info) => setGpuInfo(info)
    gpuHost.engine.onHistogram = (bins) => setHistogram(bins)
    return () => {
      gpuHost.engine.onInfo = () => undefined
      gpuHost.engine.onHistogram = () => undefined
      gpuHost.canvas.remove()
    }
  }, [gpuHost, !photo])

  // Neues Foto: Ansicht zurücksetzen.
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setCropMode(false)
    setDraftCrop(null)
    setAfter(null)
    setBefore('')
    setLooks([])
  }, [photo?.id])

  // Vorher-Bild: Original ohne Farbe, aber mit gleichem Zuschnitt.
  useEffect(() => {
    if (!photo || gpu) return
    let cancel = false
    const original = { ...cloneEdits(NEUTRAL_EDITS), rotate: edits.rotate, straighten: edits.straighten, crop: edits.crop }
    void window.api.preview(photo.id, original, zoom > 1.25 ? 3600 : 1700, { purpose: 'before' }).then((payload) => {
      if (!cancel && payload) setBefore(payload.dataUrl)
    })
    return () => {
      cancel = true
    }
  }, [photo?.id, geometryKey, zoom > 1.25])

  // Nachher-Bild.
  useEffect(() => {
    if (!photo || gpu) return
    let cancel = false
    setLoading(true)
    const handle = window.setTimeout(
      () => {
        void window.api
          .preview(photo.id, photo.edits, previewEdge, { ignoreCrop: cropMode, purpose: 'main' })
          .then((payload) => {
            if (cancel || !payload) return
            setAfter({ url: payload.dataUrl, width: payload.width, height: payload.height })
            setHistogram(payload.histogram)
            setLoading(false)
          })
          .catch(() => {
            if (!cancel) setLoading(false)
          })
      },
      scrubbing ? 16 : 0
    )
    return () => {
      cancel = true
      window.clearTimeout(handle)
    }
  }, [photo?.id, key, previewEdge, cropMode])

  // Look-Vorschauen.
  useEffect(() => {
    if (!photo || scrubbing || gpu) return
    let cancel = false
    const handle = window.setTimeout(() => {
      void window.api.lookPreviews(photo.id, photo.edits).then((list) => {
        if (!cancel && list) setLooks(list)
      })
    }, 350)
    return () => {
      cancel = true
      window.clearTimeout(handle)
    }
  }, [photo?.id, lookBaseKey, scrubbing])

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return
      if (event.key === '\\' || event.key === 'v') setHoldBefore(true)
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        if (!photo || strip.length === 0 || cropMode) return
        const index = Math.max(0, strip.findIndex((item) => item.id === photo.id))
        const next = event.key === 'ArrowRight' ? (index + 1) % strip.length : (index - 1 + strip.length) % strip.length
        props.onSelect(strip[next].id)
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === '\\' || event.key === 'v') setHoldBefore(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [photo, strip, cropMode, props])

  const fitted = useMemo(() => {
    const padding = 24
    const width = Math.max(10, stage.width - padding * 2)
    const height = Math.max(10, stage.height - padding * 2)
    const imageWidth = dims?.width ?? 3
    const imageHeight = dims?.height ?? 2
    const scale = Math.min(width / imageWidth, height / imageHeight)
    const w = imageWidth * scale
    const h = imageHeight * scale
    return { left: (stage.width - w) / 2, top: (stage.height - h) / 2, width: w, height: h }
  }, [stage, dims?.width, dims?.height])

  // Grafikkarte: bei jeder Änderung sofort neu zeichnen.
  const neighbourIds = useMemo(() => {
    if (!photo) return []
    const index = strip.findIndex((item) => item.id === photo.id)
    if (index < 0) return []
    const list: string[] = []
    for (const offset of [1, -1, 2]) {
      const item = strip[(index + offset + strip.length * 3) % strip.length]
      if (item && item.id !== photo.id && !list.includes(item.id)) list.push(item.id)
    }
    return list
  }, [photo?.id, strip.length, strip.map((item) => item.id).join(',')])

  useEffect(() => {
    if (!gpu) return
    gpu.setNeighbours(neighbourIds)
  }, [gpu, neighbourIds])

  useEffect(() => {
    gpu?.setDragging(scrubbing)
  }, [gpu, scrubbing])

  useEffect(() => {
    if (!gpu || !photo) return
    gpu.update({
      id: photo.id,
      edits: photo.edits,
      ignoreCrop: cropMode,
      stageWidth: stage.width,
      stageHeight: stage.height,
      box: [fitted.left, fitted.top, fitted.width, fitted.height],
      zoom,
      pan: [pan.x, pan.y],
      splitX: compare && !holdBefore && !cropMode ? split * stage.width : -1,
      original: holdBefore && !cropMode
    })
  }, [gpu, photo?.id, photo?.edits, cropMode, stage, fitted, zoom, pan, compare, holdBefore, split])

  // Look-Kacheln über die Grafikkarte.
  useEffect(() => {
    if (!gpu || !photo || !gpuInfo || cropMode) return
    const handle = window.setTimeout(() => {
      const tiles = gpu.renderLookTiles(photo.edits, LOOK_TILE_W, LOOK_TILE_H, LOOK_COLUMNS)
      if (!tiles) return
      const atlas = new ImageData(new Uint8ClampedArray(tiles.pixels), tiles.width, tiles.height)
      LOOKS.forEach((_look, index) => {
        const target = lookCanvases.current[index]
        const context = target?.getContext('2d')
        if (!target || !context) return
        const column = index % LOOK_COLUMNS
        const row = Math.floor(index / LOOK_COLUMNS)
        context.putImageData(atlas, -column * LOOK_TILE_W, -row * LOOK_TILE_H, column * LOOK_TILE_W, row * LOOK_TILE_H, LOOK_TILE_W, LOOK_TILE_H)
      })
    }, scrubbing ? 90 : 0)
    return () => window.clearTimeout(handle)
  }, [gpu, photo?.id, lookBaseKey, gpuInfo, cropMode, scrubbing])

  if (!photo) {
    return (
      <div className="flex h-full items-center justify-center text-ink-soft">
        Importiere Fotos, um sie zu bearbeiten.
      </div>
    )
  }

  const current = photo

  function update(next: Partial<EditParams>, dragging = false): void {
    props.onEdit(current.id, { ...current.edits, ...next }, dragging)
  }

  function setField(field: ScalarKey, value: number, dragging: boolean): void {
    update({ [field]: value } as Partial<EditParams>, dragging)
  }

  function setBand(index: number, value: number, dragging: boolean): void {
    const list = [...current.edits[hslMode]]
    list[index] = value
    update({ [hslMode]: list } as Partial<EditParams>, dragging)
  }

  function chooseLook(id: string): void {
    const preset = id === AUTOMATIC_LOOK ? null : id
    const strength = preset && preset === current.edits.preset ? current.edits.presetStrength : 100
    update({ preset, presetStrength: strength })
  }

  function zoomTo(next: number, anchor?: { x: number; y: number }): void {
    const clamped = Math.min(8, Math.max(1, next))
    if (clamped === 1) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    const ax = anchor ? anchor.x - stage.width / 2 : 0
    const ay = anchor ? anchor.y - stage.height / 2 : 0
    setPan((p) => ({ x: ax - (clamped * (ax - p.x)) / zoom, y: ay - (clamped * (ay - p.y)) / zoom }))
    setZoom(clamped)
  }

  // Zoom-Stufe, bei der ein Bildpixel einem Bildschirmpixel entspricht.
  const actualZoom = Math.max(1, current.width / Math.max(1, fitted.width) / (window.devicePixelRatio || 1))

  function startCrop(): void {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setCompare(false)
    setDraftCrop(current.edits.crop ?? FULL)
    setCropMode(true)
  }

  function finishCrop(): void {
    if (draftCrop) {
      const full = draftCrop.x < 0.001 && draftCrop.y < 0.001 && draftCrop.w > 0.999 && draftCrop.h > 0.999
      update({ crop: full ? null : draftCrop })
    }
    setCropMode(false)
    setDraftCrop(null)
  }

  function applyAspect(id: string): void {
    setAspect(id)
    const option = ASPECTS.find((item) => item.id === id)
    if (!option || option.ratio === null || !dims) return
    const imageRatio = dims.width / dims.height
    const target = option.ratio === 'original' ? current.width / current.height : option.ratio
    // Seitenverhältnis in normierten Koordinaten.
    const normalized = target / imageRatio
    let w = 1
    let h = w / normalized
    if (h > 1) {
      h = 1
      w = normalized
    }
    setDraftCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
  }

  function rotateBy(step: number): void {
    update({ rotate: (((current.edits.rotate + step) % 360) + 360) % 360, crop: null })
    setDraftCrop(FULL)
  }

  const showBefore = holdBefore && !cropMode
  const showCompare = compare && !holdBefore && !cropMode
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  const activeLook = current.edits.preset ?? AUTOMATIC_LOOK
  const saved = current.savedKey === key

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_330px] grid-rows-[minmax(0,1fr)_auto]">
      <div
        ref={stageRef}
        className={cn('relative min-h-0 overflow-hidden bg-[#0b0c0e]', zoom > 1 && !cropMode && 'cursor-grab')}
        onWheel={(event) => {
          if (cropMode || (event.target as HTMLElement).closest('button')) return
          const bounds = event.currentTarget.getBoundingClientRect()
          zoomTo(zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        }}
        onDoubleClick={(event) => {
          if (cropMode || (event.target as HTMLElement).closest('button')) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (zoom > 1) zoomTo(1)
          else zoomTo(Math.min(8, Math.max(2, actualZoom)), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        }}
        onPointerDown={(event) => {
          const element = event.target as HTMLElement
          if (cropMode || zoom <= 1 || element.dataset.handle || element.closest('button')) return
          const startX = event.clientX
          const startY = event.clientY
          const origin = { ...pan }
          const target = event.currentTarget
          target.setPointerCapture(event.pointerId)
          const move = (ev: PointerEvent): void => setPan({ x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY })
          const stop = (): void => {
            target.removeEventListener('pointermove', move)
            target.removeEventListener('pointerup', stop)
          }
          target.addEventListener('pointermove', move)
          target.addEventListener('pointerup', stop)
        }}
      >
        {!gpu && after && (
          <Layer box={fitted} transform={transform}>
            <img src={showBefore ? before || after.url : after.url} alt="Foto" draggable={false} className="h-full w-full" />
          </Layer>
        )}
        {!gpu && showCompare && before && (
          <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split * 100}% 0 0)` }}>
            <Layer box={fitted} transform={transform}>
              <img src={before} alt="Vorher" draggable={false} className="h-full w-full" />
            </Layer>
          </div>
        )}
        {showCompare && (
          <div
            data-handle="split"
            className="absolute inset-y-0 w-1 -translate-x-1/2 cursor-ew-resize bg-white/80"
            style={{ left: `${split * 100}%` }}
            onPointerDown={(event) => {
              event.stopPropagation()
              const target = event.currentTarget
              target.setPointerCapture(event.pointerId)
              const move = (ev: PointerEvent): void => {
                const bounds = stageRef.current?.getBoundingClientRect()
                if (!bounds) return
                setSplit(Math.min(0.98, Math.max(0.02, (ev.clientX - bounds.left) / bounds.width)))
              }
              const stop = (): void => {
                target.removeEventListener('pointermove', move)
                target.removeEventListener('pointerup', stop)
              }
              target.addEventListener('pointermove', move)
              target.addEventListener('pointerup', stop)
            }}
          >
            <span data-handle="split" className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-black/70 text-[10px]">
              ⇆
            </span>
          </div>
        )}
        {cropMode && dims && draftCrop && (
          <CropOverlay
            box={fitted}
            rect={draftCrop}
            ratio={aspectRatioFor(aspect, current, dims)}
            onChange={setDraftCrop}
          />
        )}
        {!dims && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-soft">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-brass" />
          </div>
        )}
        <div className="pointer-events-none absolute top-3 left-3 flex gap-2 text-[11px] tracking-wide uppercase">
          {showCompare && <span className="rounded bg-black/60 px-2 py-1 text-ink-soft">Vorher</span>}
          {showBefore ? (
            <span className="rounded bg-black/60 px-2 py-1 text-ink">Original</span>
          ) : (
            <span className="rounded bg-brass px-2 py-1 text-brass-ink">{cropMode ? 'Zuschneiden' : 'Nachher'}</span>
          )}
          {!gpu && loading && <span className="rounded bg-black/60 px-2 py-1 text-ink-soft normal-case">rechnet…</span>}
        </div>
        {!cropMode && (
          <div className="absolute top-3 right-3 flex items-center gap-1 rounded-lg bg-black/60 p-1 text-[12px]">
            <ToolButton active={compare} onClick={() => setCompare((value) => !value)} title="Vorher/Nachher nebeneinander">
              Vorher/Nachher
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-white/15" />
            <ToolButton onClick={() => zoomTo(zoom / 1.5)} title="Verkleinern">
              <ZoomOut className="size-4" />
            </ToolButton>
            <span className="w-12 text-center text-ink-soft">{Math.round(zoom * 100)} %</span>
            <ToolButton onClick={() => zoomTo(zoom * 1.5)} title="Vergrößern">
              <ZoomIn className="size-4" />
            </ToolButton>
            <ToolButton onClick={() => zoomTo(1)} title="Ganzes Bild">
              <Maximize className="size-4" />
            </ToolButton>
            <ToolButton onClick={() => zoomTo(actualZoom)} title="100 % (jedes Pixel)">
              1:1
            </ToolButton>
          </div>
        )}
        <div className="pointer-events-none absolute right-3 bottom-3 left-3 text-[11px] text-faint">
          {current.fileName} · {formatPixels(current.width, current.height)}
          {cropMode
            ? ' · Ecken oder Rahmen ziehen'
            : ' · Mausrad zoomt · Doppelklick 100 % · V halten zeigt das Original'}
        </div>
      </div>

      <aside className="row-span-2 flex min-h-0 flex-col border-l border-white/10 bg-panel">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] tracking-[0.16em] text-faint uppercase">Bearbeiten</div>
            <div className={cn('text-[12px]', saved ? 'text-keep' : 'text-ink-soft')}>
              {saved ? 'Gesichert ✓' : 'Original bleibt unverändert'}
            </div>
          </div>
          <div className="flex gap-1">
            <Button variant="quiet" size="sm" onClick={() => props.onAuto(current.id)} title="Automatisch verbessern">
              <Sparkles className="size-3.5" /> Auto
            </Button>
            <Button variant="ghost" size="sm" onClick={() => props.onNeutral(current.id)} title="Alles zurück auf das Original">
              <Undo2 className="size-3.5" /> Zurück
            </Button>
          </div>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          {cropMode ? (
            <div className="space-y-5 px-4 py-4">
              <Section title="Drehen">
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="quiet" onClick={() => rotateBy(-90)}>
                    <RotateCcw className="size-4" /> Links
                  </Button>
                  <Button variant="quiet" onClick={() => rotateBy(90)}>
                    <RotateCw className="size-4" /> Rechts
                  </Button>
                </div>
              </Section>
              <SliderRow
                label="Begradigen"
                value={current.edits.straighten}
                display={formatEdit('straighten', current.edits.straighten)}
                min={-45}
                max={45}
                step={0.1}
                dirty={Math.abs(current.edits.straighten) > 0.05}
                onReset={() => update({ straighten: 0 })}
                onChange={(value, dragging) => {
                  setScrubbing(dragging)
                  update({ straighten: value }, dragging)
                }}
              />
              <Section title="Seitenverhältnis">
                <div className="flex flex-wrap gap-1.5">
                  {ASPECTS.map((item) => (
                    <button
                      key={item.id}
                      className={cn(
                        'rounded-md px-2.5 py-1.5 text-[12px] ring-1',
                        aspect === item.id ? 'bg-brass text-brass-ink ring-brass' : 'text-ink-soft ring-white/15 hover:text-ink'
                      )}
                      onClick={() => applyAspect(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </Section>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraftCrop(FULL)
                    setAspect('free')
                    update({ straighten: 0, rotate: 0, crop: null })
                  }}
                >
                  Zurücksetzen
                </Button>
                <Button onClick={finishCrop}>
                  <Check className="size-4" /> Fertig
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-6 px-4 py-4">
              <Histogram bins={histogram} />
              <Button variant="outline" className="w-full" onClick={startCrop}>
                <Crop className="size-4" /> Zuschneiden & Drehen
              </Button>
              <Section title="Licht">
                {LIGHT.map((field) => (
                  <FieldRow key={field.key} field={field} photo={current} onScrub={setScrubbing} onChange={setField} />
                ))}
              </Section>
              <Section
                title="Farbe"
                action={
                  <button
                    className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-ink hover:bg-white/10"
                    title="Weißabgleich automatisch"
                    onClick={() =>
                      update({ temperature: current.autoEdits.temperature, tint: current.autoEdits.tint })
                    }
                  >
                    <Sun className="size-3" /> Auto-Weißabgleich
                  </button>
                }
              >
                {COLOR.map((field) => (
                  <FieldRow key={field.key} field={field} photo={current} onScrub={setScrubbing} onChange={setField} />
                ))}
              </Section>
              <Section title="Farben einzeln">
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/30 p-1 text-[12px]">
                  {(
                    [
                      ['hslHue', 'Farbton'],
                      ['hslSat', 'Sättigung'],
                      ['hslLum', 'Helligkeit']
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={cn('rounded-md py-1', hslMode === mode ? 'bg-white/15 text-ink' : 'text-ink-soft')}
                      onClick={() => setHslMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {BAND_NAMES.map((name, index) => (
                  <SliderRow
                    key={name}
                    label={
                      <span className="flex items-center gap-2">
                        <span className="size-2.5 rounded-full" style={{ background: BAND_COLORS[index] }} />
                        {name}
                      </span>
                    }
                    value={current.edits[hslMode][index]}
                    display={formatEdit('contrast', current.edits[hslMode][index])}
                    min={-100}
                    max={100}
                    step={1}
                    dirty={Math.abs(current.edits[hslMode][index]) > 0.5}
                    onReset={() => setBand(index, 0, false)}
                    onChange={(value, dragging) => {
                      setScrubbing(dragging)
                      setBand(index, value, dragging)
                    }}
                  />
                ))}
              </Section>
              <Section title="Details">
                {DETAIL.map((field) => (
                  <FieldRow key={field.key} field={field} photo={current} onScrub={setScrubbing} onChange={setField} />
                ))}
              </Section>
              <Section title="Smarte Bereiche">
                <label className="flex cursor-pointer items-center justify-between rounded-lg bg-black/25 px-3 py-2.5 text-[13px]">
                  <span>Himmel verbessern</span>
                  <input
                    type="checkbox"
                    className="size-4 accent-[#e0a44b]"
                    checked={current.edits.skyEnhance}
                    onChange={(event) => update({ skyEnhance: event.target.checked })}
                  />
                </label>
              </Section>
              <Button className="w-full" size="lg" onClick={props.onSaveAll}>
                Alle sichern
              </Button>
            </div>
          )}
        </ScrollArea>
      </aside>

      <div className="border-t border-white/10 bg-[#14171b]">
        <div className="flex items-center gap-3 px-3 pt-2">
          <div className="w-40 shrink-0">
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="text-faint uppercase tracking-[0.14em]">Looks</span>
              <span className={current.edits.preset ? 'text-brass' : 'text-faint'}>
                Stärke {Math.round(current.edits.presetStrength)} %
              </span>
            </div>
            <Slider
              min={0}
              max={100}
              step={1}
              disabled={!current.edits.preset}
              value={[current.edits.presetStrength]}
              aria-label="Stärke des Looks"
              onValueChange={([value]) => {
                setScrubbing(true)
                update({ presetStrength: value }, true)
              }}
              onValueCommit={() => setScrubbing(false)}
            />
          </div>
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-2">
            {LOOKS.map((look, index) => (
              <button
                key={look.id}
                data-look={look.id}
                className="group shrink-0 text-center"
                onClick={() => chooseLook(look.id)}
                title={look.name}
              >
                <div
                  className={cn(
                    'h-[58px] w-[80px] overflow-hidden rounded-md bg-black ring-2 transition',
                    activeLook === look.id ? 'ring-brass' : 'ring-transparent group-hover:ring-white/25'
                  )}
                >
                  {gpu ? (
                    <canvas
                      ref={(element) => {
                        lookCanvases.current[index] = element
                      }}
                      width={LOOK_TILE_W}
                      height={LOOK_TILE_H}
                      className="h-full w-full object-cover"
                    />
                  ) : looks[index] ? (
                    <img src={looks[index]} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full animate-pulse bg-white/5" />
                  )}
                </div>
                <div className={cn('mt-1 text-[11px]', activeLook === look.id ? 'text-brass' : 'text-ink-soft')}>{look.name}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto border-t border-white/5 px-3 py-2">
          {strip.map((item) => (
            <StripThumb key={item.id} photo={item} active={item.id === current.id} onSelect={props.onSelect} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Kleines Foto in der Leiste: das gerade bearbeitete lädt sich erst nach kurzer Ruhe neu (nicht bei jedem Reglerschritt). */
const StripThumb = memo(function StripThumb(props: { photo: PhotoRecord; active: boolean; onSelect: (id: string) => void }) {
  const liveKey = editKey(props.photo.edits)
  const [settled, setSettled] = useState(liveKey)
  useEffect(() => {
    if (!props.active) {
      setSettled(liveKey)
      return
    }
    const handle = window.setTimeout(() => setSettled(liveKey), 700)
    return () => window.clearTimeout(handle)
  }, [liveKey, props.active])
  const url = `lkthumb://photo/${props.photo.id}?k=${settled}`
  return (
    <button
      className={cn(
        'h-[52px] w-[74px] shrink-0 overflow-hidden rounded-md bg-black ring-1',
        props.active ? 'ring-2 ring-brass' : 'ring-white/10'
      )}
      onClick={() => props.onSelect(props.photo.id)}
    >
      <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
    </button>
  )
})

function aspectRatioFor(
  aspect: string,
  photo: PhotoRecord,
  after: { width: number; height: number }
): number | null {
  const option = ASPECTS.find((item) => item.id === aspect)
  if (!option || option.ratio === null) return null
  const target = option.ratio === 'original' ? photo.width / photo.height : option.ratio
  return target / (after.width / after.height)
}

function Layer(props: { box: { left: number; top: number; width: number; height: number }; transform: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0" style={{ transform: props.transform, transformOrigin: 'center center' }}>
      <div
        className="absolute"
        style={{ left: props.box.left, top: props.box.top, width: props.box.width, height: props.box.height }}
      >
        {props.children}
      </div>
    </div>
  )
}

function CropOverlay(props: {
  box: { left: number; top: number; width: number; height: number }
  rect: CropRect
  /** Seitenverhältnis in normierten Koordinaten (w/h) oder frei. */
  ratio: number | null
  onChange: (rect: CropRect) => void
}) {
  const { box, rect } = props

  function drag(event: React.PointerEvent, mode: string): void {
    event.preventDefault()
    event.stopPropagation()
    const start = { x: event.clientX, y: event.clientY }
    const origin = { ...rect }
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - start.x) / box.width
      const dy = (ev.clientY - start.y) / box.height
      props.onChange(resize(origin, mode, dx, dy, props.ratio))
    }
    const stop = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', stop)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', stop)
  }

  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  return (
    <div className="absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <div className="pointer-events-none absolute right-0 left-0 top-0 bg-black/65" style={{ height: rect.y * box.height }} />
      <div
        className="pointer-events-none absolute right-0 bottom-0 left-0 bg-black/65"
        style={{ top: (rect.y + rect.h) * box.height }}
      />
      <div
        className="pointer-events-none absolute left-0 bg-black/65"
        style={{ top: rect.y * box.height, height: rect.h * box.height, width: rect.x * box.width }}
      />
      <div
        className="pointer-events-none absolute right-0 bg-black/65"
        style={{ top: rect.y * box.height, height: rect.h * box.height, left: (rect.x + rect.w) * box.width }}
      />
      <div
        data-handle="move"
        className="absolute cursor-move border border-white/90"
        style={{
          left: rect.x * box.width,
          top: rect.y * box.height,
          width: rect.w * box.width,
          height: rect.h * box.height
        }}
        onPointerDown={(event) => drag(event, 'move')}
      >
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute top-1/3 right-0 left-0 h-px bg-white/35" />
          <div className="absolute top-2/3 right-0 left-0 h-px bg-white/35" />
          <div className="absolute top-0 bottom-0 left-1/3 w-px bg-white/35" />
          <div className="absolute top-0 bottom-0 left-2/3 w-px bg-white/35" />
        </div>
        {handles.map((handle) => (
          <span
            key={handle}
            data-handle={handle}
            className="absolute size-4 rounded-sm border-2 border-white bg-brass"
            style={handleStyle(handle)}
            onPointerDown={(event) => drag(event, handle)}
          />
        ))}
      </div>
    </div>
  )
}

function handleStyle(handle: string): React.CSSProperties {
  const style: React.CSSProperties = { cursor: `${handle}-resize` }
  if (handle.includes('n')) style.top = -8
  else if (handle.includes('s')) style.bottom = -8
  else style.top = 'calc(50% - 8px)'
  if (handle.includes('w')) style.left = -8
  else if (handle.includes('e')) style.right = -8
  else style.left = 'calc(50% - 8px)'
  return style
}

export function resize(origin: CropRect, mode: string, dx: number, dy: number, ratio: number | null): CropRect {
  const min = 0.05
  if (mode === 'move') {
    return {
      ...origin,
      x: Math.min(1 - origin.w, Math.max(0, origin.x + dx)),
      y: Math.min(1 - origin.h, Math.max(0, origin.y + dy))
    }
  }
  let left = origin.x
  let top = origin.y
  let right = origin.x + origin.w
  let bottom = origin.y + origin.h
  if (mode.includes('w')) left = Math.min(right - min, Math.max(0, left + dx))
  if (mode.includes('e')) right = Math.max(left + min, Math.min(1, right + dx))
  if (mode.includes('n')) top = Math.min(bottom - min, Math.max(0, top + dy))
  if (mode.includes('s')) bottom = Math.max(top + min, Math.min(1, bottom + dy))
  let w = right - left
  let h = bottom - top
  if (ratio) {
    // Seitenverhältnis halten: an der gezogenen Seite ausrichten, innerhalb des Bildes bleiben.
    const horizontal = mode === 'e' || mode === 'w'
    if (horizontal) h = w / ratio
    else if (mode === 'n' || mode === 's') w = h * ratio
    else if (w / h > ratio) w = h * ratio
    else h = w / ratio
    const anchorRight = mode.includes('w')
    const anchorBottom = mode.includes('n')
    if (anchorRight) left = right - w
    if (anchorBottom) top = bottom - h
    if (horizontal) top = origin.y + (origin.h - h) / 2
    if (mode === 'n' || mode === 's') left = origin.x + (origin.w - w) / 2
    const fit = Math.min(1, left < 0 ? (w + left) / w : 1, top < 0 ? (h + top) / h : 1, left + w > 1 ? (1 - left) / w : 1, top + h > 1 ? (1 - top) / h : 1)
    if (fit < 1) {
      const nw = w * fit
      const nh = h * fit
      if (anchorRight) left = right - nw
      if (anchorBottom) top = bottom - nh
      w = nw
      h = nh
    }
    left = Math.min(1 - w, Math.max(0, left))
    top = Math.min(1 - h, Math.max(0, top))
  }
  return { x: left, y: top, w, h }
}

function ToolButton(props: { active?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={props.title}
      className={cn(
        'flex h-7 min-w-7 items-center justify-center rounded px-2',
        props.active ? 'bg-brass text-brass-ink' : 'text-ink hover:bg-white/10'
      )}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function Section(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] tracking-[0.16em] text-faint uppercase">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

function FieldRow(props: {
  field: Field
  photo: PhotoRecord
  onScrub: (value: boolean) => void
  onChange: (key: ScalarKey, value: number, dragging: boolean) => void
}) {
  const { field, photo } = props
  const value = photo.edits[field.key]
  return (
    <SliderRow
      label={field.label}
      value={value}
      display={formatEdit(field.key, value)}
      min={field.min}
      max={field.max}
      step={field.step}
      hint={field.hint}
      dirty={Math.abs(value) > field.step / 2}
      onReset={() => props.onChange(field.key, 0, false)}
      onChange={(next, dragging) => {
        props.onScrub(dragging)
        props.onChange(field.key, next, dragging)
      }}
    />
  )
}

function SliderRow(props: {
  label: ReactNode
  value: number
  display: string
  min: number
  max: number
  step: number
  hint?: [string, string]
  dirty: boolean
  onReset: () => void
  onChange: (value: number, dragging: boolean) => void
}) {
  return (
    <div>
      <div
        className="mb-1.5 flex items-baseline justify-between text-[12.5px]"
        onDoubleClick={props.onReset}
        title="Doppelklick setzt auf 0 zurück"
      >
        <span>{props.label}</span>
        <span className={props.dirty ? 'text-brass' : 'text-ink-soft'}>{props.display}</span>
      </div>
      <Slider
        min={props.min}
        max={props.max}
        step={props.step}
        value={[props.value]}
        onValueChange={([next]) => props.onChange(next, true)}
        onValueCommit={([next]) => props.onChange(next, false)}
      />
      {props.hint && (
        <div className="mt-1 flex justify-between text-[10px] text-faint">
          <span>{props.hint[0]}</span>
          <span>{props.hint[1]}</span>
        </div>
      )}
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
        <div key={index} className="flex-1 rounded-t-[1px] bg-brass/80" style={{ height: `${Math.max(6, value * 100)}%` }} />
      ))}
    </div>
  )
}
