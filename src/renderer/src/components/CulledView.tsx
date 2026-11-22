import { Copy, RotateCcw } from 'lucide-react'
import type { PhotoRecord } from '../../../shared/types'
import { editKey } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { formatPixels, formatScore } from '@renderer/lib/format'

interface CulledViewProps {
  photos: PhotoRecord[]
  tab: 'blurry' | 'duplicate'
  onTab: (tab: 'blurry' | 'duplicate') => void
  thumbs: Record<string, string>
  threshold: number
  onRestore: (ids: string[]) => void
  onOpen: (id: string) => void
  onCopy: () => void
}

export function CulledView(props: CulledViewProps) {
  const blurry = props.photos.filter((photo) => photo.status === 'blurry')
  const duplicates = props.photos.filter((photo) => photo.status === 'duplicate')
  const groups = groupDuplicates(props.photos)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <Tabs value={props.tab} onValueChange={(value) => props.onTab(value as 'blurry' | 'duplicate')}>
          <TabsList>
            <TabsTrigger value="blurry">Unscharf ({blurry.length})</TabsTrigger>
            <TabsTrigger value="duplicate">Duplikate ({duplicates.length})</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="outline" onClick={props.onCopy}>
          <Copy className="size-3.5" />
          Kopien ablegen…
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Tabs value={props.tab}>
          <TabsContent value="blurry">
            {blurry.length === 0 ? (
              <Empty text="Keine unscharfen Fotos. Entweder ist die Serie scharf oder die Schwelle steht sehr niedrig." />
            ) : (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => props.onRestore(blurry.map((photo) => photo.id))}>
                    <RotateCcw className="size-3.5" />
                    Alle wiederherstellen
                  </Button>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
                  {blurry.map((photo) => (
                    <article key={photo.id} className="flex min-w-0 gap-3 overflow-hidden rounded-lg bg-panel p-3 ring-1 ring-white/10">
                      <Thumb photo={photo} thumbs={props.thumbs} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="truncate text-[13px]">{photo.fileName}</div>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                          Schärfe {formatScore(photo.sharpnessScore)} von 100, Schwelle {formatScore(props.threshold)}.
                          Das Original bleibt im Ursprungsordner.
                        </p>
                        <div className="mt-auto flex flex-wrap gap-2 pt-3">
                          <Button variant="quiet" size="sm" onClick={() => props.onRestore([photo.id])}>
                            Wiederherstellen
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => props.onOpen(photo.id)}>
                            Ansehen
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>
          <TabsContent value="duplicate">
            {groups.length === 0 ? (
              <Empty text="Keine Duplikate. Identische und sehr ähnliche Aufnahmen erscheinen hier, die schärfste bleibt in der Bibliothek." />
            ) : (
              <div className="space-y-4">
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => props.onRestore(duplicates.map((photo) => photo.id))}>
                    <RotateCcw className="size-3.5" />
                    Alle wiederherstellen
                  </Button>
                </div>
                {groups.map((group) => (
                  <section key={group.keeper?.id ?? group.copies[0].id} className="rounded-lg bg-panel p-3 ring-1 ring-white/10">
                    {group.keeper && (
                      <div className="mb-3 flex items-center gap-3">
                        <Thumb photo={group.keeper} thumbs={props.thumbs} />
                        <div>
                          <div className="text-[11px] tracking-[0.14em] text-keep uppercase">Behalten</div>
                          <div className="text-[13px]">{group.keeper.fileName}</div>
                          <div className="text-[12px] text-ink-soft">
                            Schärfe {formatScore(group.keeper.sharpnessScore)} · {formatPixels(group.keeper.width, group.keeper.height)}
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2 border-t border-white/10 pt-3">
                      {group.copies.map((photo) => (
                        <div key={photo.id} className="flex items-center gap-3">
                          <Thumb photo={photo} thumbs={props.thumbs} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px]">{photo.fileName}</div>
                            <div className="text-[12px] text-ink-soft">
                              Duplikat · Schärfe {formatScore(photo.sharpnessScore)} · {formatPixels(photo.width, photo.height)}
                            </div>
                          </div>
                          <Button variant="quiet" size="sm" onClick={() => props.onRestore([photo.id])}>
                            Wiederherstellen
                          </Button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function groupDuplicates(photos: PhotoRecord[]): { keeper?: PhotoRecord; copies: PhotoRecord[] }[] {
  const copies = photos.filter((photo) => photo.status === 'duplicate')
  const map = new Map<string, PhotoRecord[]>()
  for (const photo of copies) {
    const key = photo.duplicateOf ?? photo.groupId ?? photo.id
    const list = map.get(key)
    if (list) list.push(photo)
    else map.set(key, [photo])
  }
  return [...map.entries()].map(([keeperId, groupCopies]) => ({
    keeper: photos.find((photo) => photo.id === keeperId),
    copies: groupCopies
  }))
}

function Thumb({ photo, thumbs }: { photo: PhotoRecord; thumbs: Record<string, string> }) {
  const src = thumbs[`${photo.id}:${editKey(photo.edits)}`]
  return (
    <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black">
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full animate-pulse bg-white/5" />}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-[50vh] items-center justify-center">
      <p className="max-w-md text-center text-[14px] leading-relaxed text-ink-soft">{text}</p>
    </div>
  )
}
