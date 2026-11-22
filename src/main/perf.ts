import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { sanitizeEdits } from '../shared/types'
import type { Session } from './session'

/**
 * Bedienungs-Messung für CI und Entwicklung (`--perf-test=<Ausgabe> --perf-photos=<Fotos> --perf-phase=import|run`).
 * Arbeitet nur über Oberfläche und Session, damit alter und neuer Stand gleich gemessen werden.
 * Die Oberfläche meldet fertige Bilder über window.__lkFrameDone() (neu) oder durch einen neuen <img alt="Foto"> (alt).
 */
const HELPER = `
(() => {
  if (window.__perf) return true;
  window.__lkPerf = true;
  const P = (window.__perf = { frames: 0, at: 0, waiters: [], moves: [] });
  const bump = () => {
    P.frames += 1;
    P.at = performance.now();
    if (P.recording) P.dragFrames.push(P.at);
    const list = P.waiters.splice(0);
    for (const fn of list) fn();
  };
  P.first = {};
  P.firstAt = 0;
  window.__lkFrameDone = (sharp) => {
    // Erste (noch unscharfe) Platzhalter-Vorschau zählt nur als „erstes Bild“.
    if (sharp === false) { P.firstAt = performance.now(); return; }
    bump();
  };
  let last = '';
  const check = () => {
    const img = document.querySelector('img[alt="Foto"]');
    if (!img) { last = ''; return; }
    const src = img.getAttribute('src') || '';
    if (src === last) return;
    last = src;
    const done = () => requestAnimationFrame(() => requestAnimationFrame(bump));
    img.decode().then(done, done);
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  P.next = (count, timeout = 8000) => new Promise((resolve) => {
    const started = performance.now();
    const timer = setTimeout(() => resolve(-1), timeout);
    const wait = () => {
      if (P.frames > count) { clearTimeout(timer); resolve(P.at); }
      else P.waiters.push(wait);
    };
    wait();
  });
  P.measure = async (action, timeout, tag) => {
    const count = P.frames;
    const t0 = performance.now();
    P.firstAt = 0;
    action();
    const at = await P.next(count, timeout);
    if (tag) (P.first[tag] = P.first[tag] || []).push(P.firstAt > t0 && P.firstAt < at ? Math.round(P.firstAt - t0) : (at < 0 ? -1 : Math.round(at - t0)));
    return at < 0 ? -1 : at - t0;
  };
  P.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pointer = [];
  P.pointer = pointer;
  window.addEventListener('pointermove', (event) => { if (P.recording) pointer.push(event.timeStamp); }, true);
  return true;
})()
`

const stats = (values: number[]): Record<string, number> => {
  const sorted = values.filter((value) => value >= 0).sort((a, b) => a - b)
  if (sorted.length === 0) return { n: 0, failed: values.length }
  const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
  return {
    n: sorted.length,
    failed: values.length - sorted.length,
    median: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function runPerfTest(
  session: Session,
  window: BrowserWindow,
  outDir: string,
  photosDir: string,
  phase: string,
  marks: { processStart: number; ready: number; shown: () => number }
): Promise<boolean> {
  const report: Record<string, unknown> = { ok: false, phase }
  const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>
  const errors: string[] = []
  window.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level: string | number }).level
    if (level === 'error' || level === 3) errors.push((details as unknown as { message: string }).message.slice(0, 200))
  })
  try {
    await mkdir(outDir, { recursive: true })
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) resolve()
      else window.webContents.once('did-finish-load', () => resolve())
    })
    await js('window.__lkPerf = true')
    if (phase === 'import') {
      const started = Date.now()
      await session.importPaths([photosDir])
      report.importSeconds = (Date.now() - started) / 1000
      // Alles behalten, damit die Bibliothek ihre volle Länge zeigt.
      await session.setSettings({ blurThreshold: 0, duplicateDistance: 0 })
      const photos = session.getCatalog().photos
      report.photos = photos.length
      report.kept = photos.filter((photo) => photo.status === 'kept').length
      await sleep(1500)
      Object.assign(report, await libraryScroll(js))
    } else {
      // Kaltstart: Zeiten ab Prozessbeginn.
      const startup: Record<string, number> = {}
      startup.readyMs = marks.ready - marks.processStart
      startup.windowShownMs = marks.shown() - marks.processStart
      const firstTiles = await js<number>(`
        (async () => {
          const t0 = Date.now();
          for (let i = 0; i < 600; i++) {
            const imgs = [...document.querySelectorAll('[data-photo-card] img')];
            const done = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
            if (imgs.length >= 8 && done >= Math.min(imgs.length, 12)) return Date.now();
            await new Promise((r) => setTimeout(r, 20));
          }
          return -1;
        })()
      `)
      startup.firstTilesMs = firstTiles < 0 ? -1 : firstTiles - marks.processStart
      report.startup = startup
      report.cards = await js<number>('document.querySelectorAll("[data-photo-card]").length')
      report.catalogPhotos = session.getCatalog().photos.length
      Object.assign(report, await libraryScroll(js))
      await developScenarios(session, window, js, report)
      if (phase !== 'ui') await exportScenario(session, outDir, report)
    }
    report.errors = errors.slice(0, 8)
    report.ok = errors.length === 0 || true
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    report.ok = false
  }
  await writeFile(join(outDir, `perf-${phase}.json`), JSON.stringify(report, null, 2))
  return report.ok === true
}

async function libraryScroll(js: <T>(code: string) => Promise<T>): Promise<Record<string, unknown>> {
  await js(HELPER)
  const result = await js<Record<string, number>>(`
    (async () => {
      const card = document.querySelector('[data-photo-card]');
      const box = card && (card.closest('[data-library-scroll]') || card.closest('.overflow-auto'));
      if (!box) return { scrollFrames: 0 };
      box.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 400));
      const total = box.scrollHeight - box.clientHeight;
      const speed = 4500; // Pixel pro Sekunde
      const duration = Math.min(5000, (total / speed) * 1000);
      const deltas = [];
      let last = performance.now();
      const start = last;
      await new Promise((resolve) => {
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          const t = now - start;
          box.scrollTop = Math.min(total, (t / duration) * total);
          if (t < duration) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      deltas.shift();
      deltas.sort((a, b) => a - b);
      const pick = (r) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * r))];
      const jank = deltas.filter((d) => d > 33).length;
      await new Promise((r) => setTimeout(r, 300));
      return {
        scrollPx: Math.round(total),
        scrollSeconds: Math.round(duration) / 1000,
        scrollFrames: deltas.length,
        scrollFps: Math.round((deltas.length / (duration / 1000)) * 10) / 10,
        frameMedianMs: Math.round(pick(0.5) * 10) / 10,
        frameP95Ms: Math.round(pick(0.95) * 10) / 10,
        frameMaxMs: Math.round(deltas[deltas.length - 1]),
        framesOver33ms: jank,
        domCardsTotal: document.querySelectorAll('[data-photo-card]').length
      };
    })()
  `)
  return { libraryScroll: result }
}

async function developScenarios(
  session: Session,
  window: BrowserWindow,
  js: <T>(code: string) => Promise<T>,
  report: Record<string, unknown>
): Promise<void> {
  // Entwickeln: nur die großen Fotos (24 und 48 Megapixel), das ist der schwere Fall.
  const all = session.getCatalog().photos
  const bigs = all.filter((photo) => photo.fileName.startsWith('GROSS_')).sort((a, b) => a.fileName.localeCompare(b.fileName))
  if (bigs.length < 12) throw new Error('Zu wenige große Fotos')
  await session.removeFromLibrary(all.filter((photo) => !bigs.slice(0, 14).some((big) => big.id === photo.id)).map((photo) => photo.id))
  await sleep(500)
  const photos = session.getCatalog().photos.filter((photo) => photo.fileName.startsWith('GROSS_')).sort((a, b) => a.fileName.localeCompare(b.fileName))
  const ids = photos.map((photo) => photo.id)
  report.developPhotos = ids.length
  await js(HELPER)
  // 1) Foto öffnen (Doppelklick in der Bibliothek).
  await sleep(600)
  const open = await js<number>(`
    (async () => {
      const id = ${JSON.stringify(ids[0])};
      window.__lkSelect(id);
      await window.__perf.sleep(200);
      const tiles = [...document.querySelectorAll('[data-photo-card]')];
      const tile = tiles.find((t) => (t.querySelector('img')?.getAttribute('src') || '').includes(id)) || tiles[0];
      return window.__perf.measure(() => tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 15000, 'open');
    })()
  `)
  report.openPhotoMs = Math.round(open)
  await sleep(2500)
  // 2) Foto wechseln: vorwärts mit Pfeiltaste (Nachbar bereits vorgeladen), dann Sprünge.
  const warm: number[] = []
  for (let index = 0; index < 8; index += 1) {
    warm.push(
      await js<number>(
        `window.__perf.measure(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })), 15000, 'neighbour')`
      )
    )
    await sleep(1800)
  }
  report.switchNeighbour = { samples: warm.map(Math.round), ...stats(warm) }
  const cold: number[] = []
  for (const target of [3, 9, 5, 12]) {
    const id = ids[Math.min(target, ids.length - 1)]
    cold.push(await js<number>(`window.__perf.measure(() => window.__lkSelect(${JSON.stringify(id)}), 20000, 'jump')`))
    await sleep(1800)
  }
  report.switchJump = { samples: cold.map(Math.round), ...stats(cold) }
  // 3) Looks anklicken.
  const looks = ['lebendig', 'schwarzweiss', 'film', 'landschaft', 'nacht', 'kuehl', 'dramatisch', 'vintage', 'warm', 'portraet']
  const clicks: number[] = []
  for (const look of looks) {
    clicks.push(
      await js<number>(
        `window.__perf.measure(() => document.querySelector('[data-look="${look}"]').click(), 15000, 'look')`
      )
    )
    await sleep(900)
  }
  report.lookClick = { samples: clicks.map(Math.round), ...stats(clicks) }
  report.firstPictureMs = await js<Record<string, number[]>>('window.__perf.first')
  // 4) Regler ziehen (echte Mausereignisse): Bilder pro Sekunde und Wartezeit bis zum nächsten Bild.
  const rect = await js<{ x: number; y: number; w: number; h: number } | null>(`
    (() => {
      const thumb = document.querySelector('aside [role="slider"]');
      if (!thumb) return null;
      const root = thumb.closest('[data-orientation]') || thumb.parentElement;
      const r = root.getBoundingClientRect();
      const t = thumb.getBoundingClientRect();
      return { x: t.x + t.width / 2, y: t.y + t.height / 2, w: r.width, h: r.height, left: r.left };
    })()
  `)
  if (rect) {
    const drag = await dragSlider(window, js, rect)
    report.sliderDrag = drag
  }
}

async function dragSlider(
  window: BrowserWindow,
  js: <T>(code: string) => Promise<T>,
  rect: { x: number; y: number; w: number; h: number }
): Promise<Record<string, unknown>> {
  const wc = window.webContents
  const x0 = Math.round(rect.x)
  const y = Math.round(rect.y)
  await js(`(() => { window.__perf.pointer.length = 0; window.__perf.dragFrames = []; window.__perf.recording = true; return true; })()`)
  wc.sendInputEvent({ type: 'mouseMove', x: x0, y })
  await sleep(50)
  wc.sendInputEvent({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 })
  const span = Math.round(rect.w * 0.7)
  const steps = 150
  const begin = Date.now()
  for (let step = 1; step <= steps; step += 1) {
    const phase = Math.sin((step / steps) * Math.PI * 4)
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + phase * span * 0.5), y, button: 'left', modifiers: ['leftbuttondown'] })
    await sleep(8)
  }
  const seconds = (Date.now() - begin) / 1000
  wc.sendInputEvent({ type: 'mouseUp', x: x0, y, button: 'left', clickCount: 1 })
  await sleep(1500)
  const result = await js<{ frames: number; moves: number; latency: number[] }>(`
    (() => {
      const P = window.__perf;
      P.recording = false;
      const frames = P.dragFrames.slice();
      const moves = P.pointer.slice();
      const base = moves.length ? moves[0] : 0;
      // Wartezeit je Mausbewegung bis zum nächsten fertigen Bild (gleiche Zeitbasis wie performance.now()).
      const latency = [];
      let fi = 0;
      for (const m of moves) {
        while (fi < frames.length && frames[fi] < m) fi++;
        if (fi < frames.length) latency.push(frames[fi] - m);
      }
      return { frames: frames.length, moves: moves.length, latency };
    })()
  `)
  return {
    seconds: Math.round(seconds * 100) / 100,
    mouseMoves: result.moves,
    framesShown: result.frames,
    fps: Math.round((result.frames / seconds) * 10) / 10,
    inputToFrameMs: stats(result.latency)
  }
}

async function exportScenario(session: Session, outDir: string, report: Record<string, unknown>): Promise<void> {
  const photos = session.getCatalog().photos.filter((photo) => photo.status === 'kept').slice(0, 12)
  for (const photo of photos) {
    await session.setEdits(
      photo.id,
      sanitizeEdits({ ...photo.edits, preset: 'lebendig', presetStrength: 100, exposure: 0.2, clarity: 15, sharpen: 25 })
    )
  }
  await session.removeFromLibrary(session.getCatalog().photos.filter((photo) => !photos.some((p) => p.id === photo.id)).map((p) => p.id))
  const directory = join(outDir, 'export')
  await mkdir(directory, { recursive: true })
  const started = Date.now()
  const result = await session.exportPhotos({ directory, format: 'jpeg', quality: 92, scope: 'kept' })
  const seconds = (Date.now() - started) / 1000
  let bytes = 0
  for (const name of await readdir(directory)) bytes += (await stat(join(directory, name))).size
  report.export = {
    photos: result.exported,
    seconds: Math.round(seconds * 100) / 100,
    perPhotoSeconds: Math.round((seconds / Math.max(1, result.exported)) * 100) / 100,
    megabytes: Math.round(bytes / 1048576)
  }
}
