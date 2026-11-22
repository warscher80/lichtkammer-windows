import type { EditParams } from '../../../shared/types'

export function formatScore(score: number): string {
  return Math.round(score).toLocaleString('de-DE')
}

export function formatExposure(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} EV`
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value)
  if (rounded > 0) return `+${rounded.toLocaleString('de-DE')}`
  return rounded.toLocaleString('de-DE')
}

export function formatEdit(key: keyof EditParams, value: number): string {
  if (key === 'exposure') return formatExposure(value)
  return formatSigned(value)
}

export function formatPixels(width: number, height: number): string {
  return `${width.toLocaleString('de-DE')} × ${height.toLocaleString('de-DE')}`
}
