// Display formatting shared by pages. No server imports here.
import { describePack, isRawUnit, standardQuantity } from './units'
import type { BaseUnit } from './units'

export function euro(
  n: number | null | undefined,
  opts: { cents?: boolean } = {},
): string {
  if (n == null || !Number.isFinite(n)) return '-'
  const cents = opts.cents ?? Math.abs(n) < 100
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(n)
}

/** "€2.10 per litre" from a per-ml price. */
export function perStandard(
  ppu: number | null | undefined,
  unit: BaseUnit | null | undefined,
): string {
  if (ppu == null || !unit) return '-'
  const { amount, label } = standardQuantity(unit)
  const v = ppu * amount
  return `${euro(v, { cents: true })} ${label}`
}

/** Compact form for tables: "€2.10/L", "€7.70/kg", "€0.28 each". */
export function perStandardShort(
  ppu: number | null | undefined,
  unit: BaseUnit | null | undefined,
): string {
  if (ppu == null || !unit) return '-'
  const { amount, short } = standardQuantity(unit)
  const v = euro(ppu * amount, { cents: true })
  return short ? `${v}/${short}` : `${v} each`
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x == null) return '-'
  return `${(x * 100).toFixed(digits)}%`
}

export function pack(p: {
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
}): string {
  if (!isRawUnit(p.pack_unit)) return 'unknown pack'
  return describePack({
    pack_size: p.pack_size,
    pack_unit: p.pack_unit,
    units_per_case: p.units_per_case,
  })
}

export function shortDate(d: string | null | undefined): string {
  if (!d) return '-'
  return new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
  })
}

export function monthName(d: string): string {
  return new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IE', {
    month: 'long',
  })
}

/** "just now", "12 min ago", "3 hours ago", "yesterday", "5 days ago", then a date. */
export function timeAgo(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return 'never'
  const mins = Math.round((now - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return shortDate(iso)
}

/** "7 Nov, 14:32", in Irish time. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-IE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Dublin',
  })
}
