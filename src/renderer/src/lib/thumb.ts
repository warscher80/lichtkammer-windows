import type { PhotoRecord } from '../../../shared/types'
import { editKey } from '../../../shared/types'

/** Vorschaubild über das App-Protokoll: lädt träge, ohne Umweg über base64. */
export function thumbUrl(photo: PhotoRecord): string {
  return `lkthumb://photo/${photo.id}?k=${editKey(photo.edits)}`
}
