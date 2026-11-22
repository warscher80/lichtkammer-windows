import { useState, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import type { PhotoRecord } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Slider } from '@renderer/components/ui/slider'
import { cn } from '@renderer/lib/utils'

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  photos: PhotoRecord[]
  selectedId: string | null
}

export function ExportDialog(props: ExportDialogProps) {
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [quality, setQuality] = useState(92)
  const [scope, setScope] = useState<'kept' | 'selected'>('kept')
  const [directory, setDirectory] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const kept = props.photos.filter((photo) => photo.status === 'kept').length
  const count = scope === 'kept' ? kept : props.selectedId ? 1 : 0

  async function choose(): Promise<void> {
    const folder = await window.api.chooseOutputDir()
    if (folder) setDirectory(folder)
  }

  async function run(): Promise<void> {
    if (!directory) {
      setMessage('Bitte zuerst einen Zielordner wählen.')
      return
    }
    setWorking(true)
    setMessage(null)
    try {
      const result = await window.api.exportPhotos({
        directory,
        format,
        quality,
        scope,
        selectedId: props.selectedId
      })
      setMessage(`${result.exported} Fotos geschrieben. Originale unverändert.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Export fehlgeschlagen')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            Die Entwicklung wird in neue Dateien geschrieben. JPG und PNG, sRGB, Ausrichtung bleibt erhalten.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Format</Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Choice active={format === 'jpeg'} onClick={() => setFormat('jpeg')}>
                JPG
              </Choice>
              <Choice active={format === 'png'} onClick={() => setFormat('png')}>
                PNG
              </Choice>
            </div>
          </div>
          {format === 'jpeg' && (
            <div>
              <div className="mb-2 flex justify-between">
                <Label>Qualität</Label>
                <span className="text-[12px] text-brass">{quality}</span>
              </div>
              <Slider min={60} max={100} step={1} value={[quality]} onValueChange={([value]) => setQuality(value)} />
            </div>
          )}
          <div>
            <Label>Umfang</Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Choice active={scope === 'kept'} onClick={() => setScope('kept')}>
                Behaltene ({kept})
              </Choice>
              <Choice active={scope === 'selected'} onClick={() => setScope('selected')} disabled={!props.selectedId}>
                Auswahl
              </Choice>
            </div>
          </div>
          <div>
            <Label>Zielordner</Label>
            <button
              className="mt-2 flex w-full items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-left text-[12px] text-ink-soft hover:border-white/20"
              onClick={() => void choose()}
            >
              <FolderOpen className="size-4 shrink-0 text-brass" />
              <span className="truncate">{directory ?? 'Ordner wählen…'}</span>
            </button>
          </div>
          {message && <p className="text-[13px] leading-relaxed text-ink">{message}</p>}
          <div className="flex justify-between gap-2 pt-1">
            {directory && message?.includes('geschrieben') ? (
              <Button variant="ghost" onClick={() => void window.api.showPath(directory)}>
                Ordner zeigen
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={() => void run()} disabled={working || count === 0}>
              {working ? 'Exportiert…' : `${count} exportieren`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Choice(props: { active: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'rounded-md border px-3 py-2 text-[13px] disabled:opacity-40',
        props.active ? 'border-brass bg-brass/15 text-ink' : 'border-white/10 text-ink-soft hover:border-white/20'
      )}
    >
      {props.children}
    </button>
  )
}
