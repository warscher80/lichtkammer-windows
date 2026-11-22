import type { PhotoRecord, Settings } from '../../shared/types'
import { duplicateRoots } from './duplicates'

/**
 * Gruppiert nahe Aufnahmen und markiert Unschärfe.
 * Es werden nur die Metadaten im Katalog geändert, niemals Dateien.
 */
export function applyCulling(photos: PhotoRecord[], settings: Settings): PhotoRecord[] {
  const roots = duplicateRoots(
    photos.map((photo) => ({
      id: photo.id,
      dHash: photo.hash,
      pHash: photo.pHash,
      contentHash: photo.contentHash,
      width: photo.width,
      height: photo.height,
      capturedAt: photo.capturedAt
    })),
    settings.duplicateDistance
  )

  const groups = new Map<string, PhotoRecord[]>()
  for (const photo of photos) {
    const root = roots.get(photo.id) ?? photo.id
    const list = groups.get(root)
    if (list) list.push(photo)
    else groups.set(root, [photo])
  }

  const patch = new Map<string, Pick<PhotoRecord, 'status' | 'duplicateOf' | 'groupId'>>()
  for (const [root, group] of groups) {
    const ranked = [...group].sort(compareKeepers)
    const best = ranked[0]
    for (const photo of group) {
      const isBest = photo.id === best.id
      let status = photo.status
      let duplicateOf: string | undefined
      if (photo.pin === 'kept') {
        status = 'kept'
      } else if (photo.pin === 'blurry') {
        status = 'blurry'
      } else if (!isBest) {
        status = 'duplicate'
        duplicateOf = best.id
      } else if (photo.sharpnessScore < settings.blurThreshold) {
        status = 'blurry'
      } else {
        status = 'kept'
      }
      patch.set(photo.id, {
        status,
        duplicateOf,
        groupId: group.length > 1 ? root : undefined
      })
    }
  }

  return photos.map((photo) => {
    const next = patch.get(photo.id)
    if (!next) return photo
    return {
      ...photo,
      status: next.status,
      duplicateOf: next.duplicateOf,
      groupId: next.groupId
    }
  })
}

function compareKeepers(a: PhotoRecord, b: PhotoRecord): number {
  if (b.sharpness !== a.sharpness) return b.sharpness - a.sharpness
  const pixels = b.width * b.height - a.width * a.height
  if (pixels !== 0) return pixels
  if (b.fileSize !== a.fileSize) return b.fileSize - a.fileSize
  return a.fileName.localeCompare(b.fileName, 'de')
}
