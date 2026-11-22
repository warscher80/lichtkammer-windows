import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { PhotoRecord } from '../../shared/types'

export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.tif',
  '.tiff',
  '.gif',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.raf',
  '.orf',
  '.rw2',
  '.raw'
])

export async function collectImages(paths: string[]): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()

  const walk = async (target: string): Promise<void> => {
    let info
    try {
      info = await stat(target)
    } catch {
      return
    }
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        await walk(join(target, entry.name))
      }
      return
    }
    if (!info.isFile()) return
    const extension = extname(target).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension) || seen.has(target)) return
    seen.add(target)
    found.push(target)
  }

  for (const target of paths) await walk(target)
  found.sort((a, b) => a.localeCompare(b, 'de'))
  return found
}

export async function copyCulledFiles(
  photos: PhotoRecord[],
  destinationRoot: string
): Promise<{ copied: number; blurryDir: string; duplicateDir: string }> {
  const blurryDir = join(destinationRoot, 'Aussortiert', 'Unscharf')
  const duplicateDir = join(destinationRoot, 'Aussortiert', 'Duplikate')
  await mkdir(blurryDir, { recursive: true })
  await mkdir(duplicateDir, { recursive: true })
  let copied = 0
  for (const photo of photos) {
    if (photo.status !== 'blurry' && photo.status !== 'duplicate') continue
    const directory = photo.status === 'blurry' ? blurryDir : duplicateDir
    const target = await uniqueDestination(directory, photo.fileName)
    await copyFile(photo.sourcePath, target)
    copied += 1
  }
  return { copied, blurryDir, duplicateDir }
}

async function uniqueDestination(directory: string, fileName: string): Promise<string> {
  const extension = extname(fileName)
  const base = fileName.slice(0, fileName.length - extension.length)
  let candidate = join(directory, fileName)
  let index = 2
  while (await exists(candidate)) {
    candidate = join(directory, `${base}-${index}${extension}`)
    index += 1
  }
  return candidate
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
