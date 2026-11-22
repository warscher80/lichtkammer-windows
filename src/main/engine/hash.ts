/** Hamming-Abstand zweier 64-bit-Hashes in Hex. */
export function hammingHex(a: string, b: string): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 64
  let dist = 0
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  while (value > 0n) {
    dist += 1
    value &= value - 1n
  }
  return dist
}

export function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0')
}

/** 64-bit-pHash aus einem Graustufenbild (wird intern auf 32×32 gebracht, falls nötig). */
export function perceptualHashFromGray(pixels: Uint8Array, width: number, height: number): string {
  const gray = width === 32 && height === 32 ? pixels : resampleGray(pixels, width, height, 32, 32)
  const n = 32
  const rows = new Float64Array(n * n)
  for (let y = 0; y < n; y += 1) {
    const row = new Float64Array(n)
    for (let x = 0; x < n; x += 1) row[x] = gray[y * n + x]
    const transformed = dct1d(row)
    rows.set(transformed, y * n)
  }
  const coeffs: number[] = []
  const freq = new Float64Array(8 * 8)
  for (let v = 0; v < 8; v += 1) {
    const col = new Float64Array(n)
    for (let u = 0; u < n; u += 1) col[u] = rows[u * n + v]
    const transformed = dct1d(col)
    for (let u = 0; u < 8; u += 1) {
      freq[u * 8 + v] = transformed[u]
      if (u !== 0 || v !== 0) coeffs.push(transformed[u])
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  let hash = 0n
  let bit = 0n
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      if (u === 0 && v === 0) continue
      if (freq[u * 8 + v] > median) hash |= 1n << bit
      bit += 1n
      if (bit === 64n) break
    }
  }
  return hashToHex(hash)
}

function dct1d(input: Float64Array): Float64Array {
  const n = input.length
  const out = new Float64Array(n)
  const factor = Math.PI / (2 * n)
  for (let k = 0; k < n; k += 1) {
    let sum = 0
    for (let i = 0; i < n; i += 1) sum += input[i] * Math.cos((2 * i + 1) * k * factor)
    out[k] = sum
  }
  return out
}

function resampleGray(
  pixels: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number
): Uint8Array {
  const out = new Uint8Array(targetWidth * targetHeight)
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / targetHeight))
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / targetWidth))
      out[y * targetWidth + x] = pixels[sy * width + sx]
    }
  }
  return out
}
