/**
 * Sucht das größte gültige JPEG in einer Datei.
 * So können CR2, NEF, ARW, DNG und ähnliche RAW-Dateien über ihre
 * eingebettete Vorschau gesichtet werden, ohne die RAW-Datei zu verändern.
 */
export function extractLargestJpeg(buffer: Buffer): Buffer | null {
  const candidates: Buffer[] = []
  let offset = 0
  const soi = Buffer.from([0xff, 0xd8])
  while (offset < buffer.length - 4) {
    const start = buffer.indexOf(soi, offset)
    if (start < 0) break
    const end = findJpegEnd(buffer, start)
    if (end > start + 1000) {
      candidates.push(buffer.subarray(start, end))
      offset = end
    } else {
      offset = start + 2
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0]
}

function findJpegEnd(buffer: Buffer, start: number): number {
  let index = start + 2
  while (index < buffer.length - 1) {
    if (buffer[index] !== 0xff) return -1
    while (index < buffer.length && buffer[index] === 0xff) index += 1
    if (index >= buffer.length) return -1
    const marker = buffer[index]
    index += 1
    if (marker === 0xd9) return index
    if (marker === 0xda) {
      if (index + 1 >= buffer.length) return -1
      const length = buffer.readUInt16BE(index)
      if (length < 2) return -1
      index += length
      while (index < buffer.length - 1) {
        if (buffer[index] !== 0xff) {
          index += 1
          continue
        }
        const next = buffer[index + 1]
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          index += 2
          continue
        }
        if (next === 0xd9) return index + 2
        break
      }
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (index + 1 >= buffer.length) return -1
    const length = buffer.readUInt16BE(index)
    if (length < 2) return -1
    index += length
  }
  return -1
}
