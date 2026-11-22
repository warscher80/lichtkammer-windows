import { BAND_COUNT, cloneEdits, NEUTRAL_EDITS, type EditParams } from './types'

/**
 * Feste Looks im Lightroom-Stil, gleiche Werte wie in der iPhone-App.
 * Ein Look wird als Änderung auf die Regler gelegt und mit der Stärke gemischt.
 */
export interface Look {
  id: string
  name: string
  delta: EditParams
  monochrome?: boolean
}

export const AUTOMATIC_LOOK = 'automatik'

function make(body: (edits: EditParams) => void): EditParams {
  const edits = cloneEdits(NEUTRAL_EDITS)
  body(edits)
  return edits
}

export const LOOKS: Look[] = [
  { id: AUTOMATIC_LOOK, name: 'Automatik', delta: make(() => undefined) },
  {
    id: 'natuerlich',
    name: 'Natürlich',
    delta: make((e) => {
      e.vibrance = -8
      e.contrast = -5
      e.clarity = -4
      e.highlights = -5
    })
  },
  {
    id: 'lebendig',
    name: 'Lebendig',
    delta: make((e) => {
      e.vibrance = 25
      e.saturation = 8
      e.contrast = 10
      e.clarity = 8
    })
  },
  {
    id: 'schwarzweiss',
    name: 'Schwarzweiß',
    monochrome: true,
    delta: make((e) => {
      e.contrast = 15
      e.clarity = 10
      e.whites = 8
      e.blacks = -10
    })
  },
  {
    id: 'film',
    name: 'Film',
    delta: make((e) => {
      e.temperature = 12
      e.blacks = 30
      e.contrast = -12
      e.saturation = -12
      e.highlights = -10
      e.hslSat[3] = -10
      e.hslHue[3] = -8
    })
  },
  {
    id: 'portraet',
    name: 'Porträt',
    delta: make((e) => {
      e.exposure = 0.1
      e.clarity = -12
      e.vibrance = 5
      e.shadows = 8
      e.hslSat[1] = -8
      e.hslLum[1] = 10
    })
  },
  {
    id: 'landschaft',
    name: 'Landschaft',
    delta: make((e) => {
      e.vibrance = 18
      e.clarity = 15
      e.contrast = 6
      e.hslSat[3] = 10
      e.hslSat[5] = 15
      e.hslLum[5] = -10
      e.skyEnhance = true
    })
  },
  {
    id: 'nacht',
    name: 'Nacht',
    delta: make((e) => {
      e.shadows = 20
      e.highlights = -20
      e.noise = 20
      e.temperature = -8
      e.contrast = 8
      e.blacks = -8
    })
  },
  {
    id: 'kuehl',
    name: 'Kühl',
    delta: make((e) => {
      e.temperature = -22
      e.tint = -3
    })
  },
  {
    id: 'warm',
    name: 'Warm',
    delta: make((e) => {
      e.temperature = 22
      e.tint = 3
    })
  },
  {
    id: 'dramatisch',
    name: 'Dramatisch',
    delta: make((e) => {
      e.contrast = 25
      e.clarity = 25
      e.highlights = -30
      e.shadows = 15
      e.saturation = -10
      e.blacks = -15
    })
  },
  {
    id: 'vintage',
    name: 'Vintage',
    delta: make((e) => {
      e.temperature = 18
      e.tint = 6
      e.saturation = -25
      e.blacks = 20
      e.whites = -15
      e.contrast = -8
      e.hslHue[3] = -15
    })
  }
]

export function findLook(id: string | null | undefined): Look | null {
  if (!id || id === AUTOMATIC_LOOK) return null
  return LOOKS.find((look) => look.id === id) ?? null
}

/** Die Werte, mit denen tatsächlich gerendert wird: Regler plus gewählter Look. */
export function effectiveEdits(edits: EditParams): EditParams {
  const look = findLook(edits.preset)
  if (!look) return edits
  const k = Math.min(1, Math.max(0, edits.presetStrength / 100))
  const d = look.delta
  const e = cloneEdits(edits)
  e.exposure += d.exposure * k
  e.temperature += d.temperature * k
  e.tint += d.tint * k
  e.contrast += d.contrast * k
  e.highlights += d.highlights * k
  e.shadows += d.shadows * k
  e.whites += d.whites * k
  e.blacks += d.blacks * k
  e.clarity += d.clarity * k
  e.vibrance += d.vibrance * k
  e.saturation += d.saturation * k
  e.sharpen = Math.max(0, e.sharpen + d.sharpen * k)
  e.noise = Math.max(0, e.noise + d.noise * k)
  for (let index = 0; index < BAND_COUNT; index += 1) {
    e.hslHue[index] += d.hslHue[index] * k
    e.hslSat[index] += d.hslSat[index] * k
    e.hslLum[index] += d.hslLum[index] * k
  }
  if (d.skyEnhance && k > 0.3) e.skyEnhance = true
  return e
}

/** Wie stark Farbe entzogen wird (Schwarzweiß-Look), 0–1. */
export function monochromeAmount(edits: EditParams): number {
  const look = findLook(edits.preset)
  if (!look?.monochrome) return 0
  return Math.min(1, Math.max(0, edits.presetStrength / 100))
}
