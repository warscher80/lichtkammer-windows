/**
 * Erzeugt einen realistischen Testbestand: npm run bench:make -- <Zielordner> [Anzahl]
 * 24- und 48-Megapixel-JPEGs aus den Beispielen (mit Variationen, Serien, Unschärfe) plus RAW-Dateien.
 * Dritter Parameter (optional): Anzahl verschiedener JPEGs, der Rest sind Kopien mit anderem Namen (schneller erzeugt).
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

async function main(): Promise<void> {
  const target = process.argv[2]
  const total = Number(process.argv[3] ?? 600)
  const distinct = Number(process.argv[4] ?? 0)
  if (!target) throw new Error('Zielordner fehlt')
  await mkdir(target, { recursive: true })
  const dir = join(process.cwd(), 'beispiele')
  const sources = (await readdir(dir)).filter((name) => /\.(jpg|png)$/i.test(name))
  const raws = (await readdir(dir)).filter((name) => /\.(arw|nef)$/i.test(name))
  const rawCount = Math.min(30, Math.round(total * 0.05))
  const jpegCount = total - rawCount
  let made = 0
  const queue: Promise<void>[] = []
  const run = async (index: number): Promise<void> => {
    const source = sources[index % sources.length]
    const variant = Math.floor(index / sources.length)
    const big = index % 5 === 0 // jedes fünfte Foto 48 MP
    const [w, h] = big ? [8256, 5504] : [6000, 4000]
    let pipeline = sharp(join(dir, source)).resize(w, h, { fit: 'cover', position: variant % 2 ? 'left' : 'right' })
    pipeline = pipeline.modulate({ brightness: 0.85 + (variant % 7) * 0.05, saturation: 0.9 + (variant % 3) * 0.1 })
    if (variant % 6 === 5) pipeline = pipeline.blur(4)
    if (variant % 4 === 3) pipeline = pipeline.rotate(90)
    await pipeline.jpeg({ quality: 88 }).toFile(join(target, `IMG_${String(index + 1).padStart(4, '0')}.jpg`))
  }
  const uniqueCount = distinct > 0 ? Math.min(distinct, jpegCount) : jpegCount
  for (let index = 0; index < jpegCount; index += 1) {
    if (index >= uniqueCount) {
      const from = index % uniqueCount
      await copyFile(
        join(target, `IMG_${String(from + 1).padStart(4, '0')}.jpg`),
        join(target, `IMG_${String(index + 1).padStart(4, '0')}.jpg`)
      )
      made += 1
      continue
    }
    queue.push(run(index).then(() => { made += 1 }))
    if (queue.length >= 4) await Promise.all(queue.splice(0))
  }
  await Promise.all(queue)
  for (let index = 0; index < rawCount; index += 1) {
    const name = raws[index % raws.length]
    await copyFile(join(dir, name), join(target, `RAW_${String(index + 1).padStart(3, '0')}${name.slice(name.lastIndexOf('.'))}`))
  }
  console.log(`${made} JPEGs und ${rawCount} RAW in ${target}`)
}
void main()
