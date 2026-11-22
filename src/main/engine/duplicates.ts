import { hammingHex } from './hash'

export interface DuplicateFingerprint {
  id: string
  dHash: string
  pHash?: string
  contentHash?: string
  width: number
  height: number
  capturedAt?: number | null
}

const CANDIDATE_DHASH = 14
const CANDIDATE_PHASH = 18
const PHASH_LOOSE = 20
const PHASH_TIGHT = 10
const BURST_MS = 3 * 60 * 1000
const SEPARATE_SESSION_MS = 6 * 60 * 60 * 1000

/**
 * Gruppiert Duplikate. Exakte Datei-Hashes sofort, sonst Kandidaten aus BK-Trees
 * und eine zweite Prüfung aus dHash, pHash, Seitenverhältnis und Aufnahmezeit.
 * Liefert die Union-Find-Wurzel je id.
 */
export function duplicateRoots(
  items: DuplicateFingerprint[],
  duplicateDistance: number
): Map<string, string> {
  const parent = new Map<string, string>()
  for (const item of items) parent.set(item.id, item.id)
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let cursor = id
    while (cursor !== root) {
      const next = parent.get(cursor) as string
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const unite = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  const byFile = new Map<string, string[]>()
  for (const item of items) {
    if (!item.contentHash) continue
    const list = byFile.get(item.contentHash)
    if (list) list.push(item.id)
    else byFile.set(item.contentHash, [item.id])
  }
  for (const ids of byFile.values()) {
    for (let index = 1; index < ids.length; index += 1) unite(ids[0], ids[index])
  }

  const dTree = new BKTree()
  const pTree = new BKTree()
  items.forEach((item, index) => {
    const seen = new Set<number>()
    for (const other of dTree.search(item.dHash, Math.max(duplicateDistance, CANDIDATE_DHASH))) {
      seen.add(other)
    }
    if (item.pHash) {
      for (const other of pTree.search(item.pHash, CANDIDATE_PHASH)) seen.add(other)
    }
    for (const other of seen) {
      if (samePicture(items[other], item, duplicateDistance)) unite(items[other].id, item.id)
    }
    dTree.insert(item.dHash, index)
    if (item.pHash) pTree.insert(item.pHash, index)
  })

  const roots = new Map<string, string>()
  for (const item of items) roots.set(item.id, find(item.id))
  return roots
}

export function samePicture(a: DuplicateFingerprint, b: DuplicateFingerprint, duplicateDistance: number): boolean {
  if (a.contentHash && a.contentHash === b.contentHash) return true
  if (!aspectClose(a, b)) return false
  const dHash = hammingHex(a.dHash, b.dHash)
  const pHash = a.pHash && b.pHash ? hammingHex(a.pHash, b.pHash) : null
  const visual =
    pHash === null
      ? dHash <= duplicateDistance
      : (dHash <= duplicateDistance && pHash <= PHASH_LOOSE) || (pHash <= PHASH_TIGHT && dHash <= CANDIDATE_DHASH)
  if (!visual) return false
  if (a.capturedAt != null && b.capturedAt != null) {
    const delta = Math.abs(a.capturedAt - b.capturedAt)
    const veryClose = dHash <= 4 && (pHash === null || pHash <= 6)
    if (delta > SEPARATE_SESSION_MS && !veryClose) return false
    if (delta > BURST_MS && dHash > duplicateDistance && (pHash === null || pHash > PHASH_TIGHT)) return false
  }
  return true
}

function aspectClose(a: DuplicateFingerprint, b: DuplicateFingerprint): boolean {
  if (a.width < 2 || a.height < 2 || b.width < 2 || b.height < 2) return true
  const left = a.width / a.height
  const right = b.width / b.height
  return Math.abs(left - right) / Math.max(left, right) <= 0.15
}

class BKNode {
  constructor(
    readonly hash: bigint,
    readonly index: number
  ) {}

  children = new Map<number, BKNode>()
}

class BKTree {
  private root: BKNode | null = null

  insert(hex: string, index: number): void {
    const hash = BigInt(`0x${hex}`)
    if (!this.root) {
      this.root = new BKNode(hash, index)
      return
    }
    let node = this.root
    for (;;) {
      const distance = hamming(node.hash, hash)
      const child = node.children.get(distance)
      if (!child) {
        node.children.set(distance, new BKNode(hash, index))
        return
      }
      node = child
    }
  }

  search(hex: string, radius: number): number[] {
    if (!this.root) return []
    const found: number[] = []
    const hash = BigInt(`0x${hex}`)
    const walk = (node: BKNode): void => {
      const distance = hamming(node.hash, hash)
      if (distance <= radius) found.push(node.index)
      for (const [edge, child] of node.children) {
        if (Math.abs(edge - distance) <= radius) walk(child)
      }
    }
    walk(this.root)
    return found
  }
}

function hamming(a: bigint, b: bigint): number {
  let value = a ^ b
  let dist = 0
  while (value > 0n) {
    dist += 1
    value &= value - 1n
  }
  return dist
}

export function benchmarkDuplicateIndex(count: number): { naiveMs: number; indexMs: number; pairs: number } {
  const items: DuplicateFingerprint[] = []
  let state = 0x9e3779b97f4a7c15n
  const next = (): bigint => {
    state = (state * 6364136223846793005n + 1n) & 0xffffffffffffffffn
    return state
  }
  for (let index = 0; index < count; index += 1) {
    const hash = next()
    items.push({
      id: String(index),
      dHash: hash.toString(16).padStart(16, '0'),
      width: 3,
      height: 2
    })
  }
  const radius = 8
  const naiveStart = performance.now()
  let naivePairs = 0
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (hammingHex(items[i].dHash, items[j].dHash) <= radius) naivePairs += 1
    }
  }
  const naiveMs = performance.now() - naiveStart
  const indexStart = performance.now()
  const tree = new BKTree()
  let indexPairs = 0
  items.forEach((item, index) => {
    for (const other of tree.search(item.dHash, radius)) {
      if (hammingHex(items[other].dHash, item.dHash) <= radius) indexPairs += 1
    }
    tree.insert(item.dHash, index)
  })
  const indexMs = performance.now() - indexStart
  if (naivePairs !== indexPairs) {
    throw new Error(`BK-Tree weicht ab (${indexPairs} statt ${naivePairs} bei ${count})`)
  }
  return { naiveMs, indexMs, pairs: naivePairs }
}
