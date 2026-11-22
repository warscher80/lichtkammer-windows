/**
 * Testbestand für die Bedienungs-Messung: npm run perf:make -- <Zielordner>
 * 560 verschiedene mittelgroße JPEGs (damit die Bibliothek wirklich 600 Karten zeigt),
 * 30 große JPEGs (24 und 48 Megapixel, zum Entwickeln und Sichern) und 10 RAW-Dateien.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

async function main(): Promise<void> {
  const target = process.argv[2]
  if (!target) throw new Error('Zielordner fehlt')
  await mkdir(target, { recursive: true })
  const dir = join(process.cwd(), 'beispiele')
  const names = await readdir(dir)
  const sources = names.filter((name) => /\.(jpg|png)$/i.test(name))
  const raws = names.filter((name) => /\.(arw|nef)$/i.test(name))
  const rand = random(20261122)
  const small = 560
  const big = 30
  const rawCount = 10
  let index = 0
  const queue: Promise<void>[] = []
  const make = async (number: number, width: number, height: number, label: string): Promise<void> => {
    const source = join(dir, sources[number % sources.length])
    const meta = await sharp(source).metadata()
    const sw = meta.width ?? 1000
    const sh = meta.height ?? 700
    const scale = 0.4 + rand() * 0.55
    const cw = Math.max(64, Math.round(sw * scale))
    const ch = Math.max(64, Math.round(sh * scale))
    const left = Math.round(rand() * (sw - cw))
    const top = Math.round(rand() * (sh - ch))
    let pipeline = sharp(source).extract({ left, top, width: cw, height: ch }).resize(width, height, { fit: 'cover' })
    pipeline = pipeline.modulate({ brightness: 0.75 + rand() * 0.5, saturation: 0.7 + rand() * 0.7, hue: Math.round(rand() * 360) })
    if (rand() < 0.5) pipeline = pipeline.flop()
    if (rand() < 0.2) pipeline = pipeline.rotate(90)
    await pipeline.jpeg({ quality: 86 }).toFile(join(target, `${label}_${String(number + 1).padStart(4, '0')}.jpg`))
  }
  for (let number = 0; number < small; number += 1) {
    queue.push(make(number, 3000, 2000, 'IMG'))
    if (queue.length >= 6) await Promise.all(queue.splice(0))
  }
  for (let number = 0; number < big; number += 1) {
    const huge = number % 3 === 0
    queue.push(make(number, huge ? 8256 : 6000, huge ? 5504 : 4000, 'GROSS'))
    if (queue.length >= 3) await Promise.all(queue.splice(0))
  }
  await Promise.all(queue)
  for (let number = 0; number < rawCount; number += 1) {
    const name = raws[number % raws.length]
    await copyFile(join(dir, name), join(target, `RAW_${String(number + 1).padStart(3, '0')}${name.slice(name.lastIndexOf('.'))}`))
    index += 1
  }
  console.log(`${small} mittlere, ${big} große JPEGs und ${index} RAW in ${target}`)
}
void main()
