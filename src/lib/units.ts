// Unit-price normalisation. Every price becomes a price per 1 ml, 1 g or 1 item.
// This is the only number used to compare suppliers, so keep it small and tested.

export type RawUnit = 'ml' | 'l' | 'cl' | 'g' | 'kg' | 'each'
export type BaseUnit = 'ml' | 'g' | 'each'

const TO_BASE: Record<RawUnit, { base: BaseUnit; factor: number }> = {
  ml: { base: 'ml', factor: 1 },
  cl: { base: 'ml', factor: 10 },
  l: { base: 'ml', factor: 1000 },
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  each: { base: 'each', factor: 1 },
}

export function isRawUnit(u: unknown): u is RawUnit {
  return typeof u === 'string' && u in TO_BASE
}

/** Converts a size like (2, 'l') to (2000, 'ml'). */
export function toBase(
  size: number,
  unit: RawUnit,
): { size: number; unit: BaseUnit } {
  const { base, factor } = TO_BASE[unit]
  return { size: size * factor, unit: base }
}

export interface PackSpec {
  pack_size: number | null
  pack_unit: RawUnit | null
  units_per_case: number | null
}

/** Total base units in one pack as sold, e.g. a case of 12 x 2L = 24000 ml. */
export function baseUnitsPerPack(
  spec: PackSpec,
): { amount: number; unit: BaseUnit } | null {
  if (spec.pack_unit == null) return null
  // A bare "each" item with no size is one item.
  const size = spec.pack_size ?? (spec.pack_unit === 'each' ? 1 : null)
  if (size == null || !(size > 0)) return null
  const perCase = spec.units_per_case ?? 1
  if (!(perCase > 0)) return null
  const { size: baseSize, unit } = toBase(size, spec.pack_unit)
  return { amount: baseSize * perCase, unit }
}

/** Price per 1 ml, 1 g or 1 item. Null when the pack size is unknown. */
export function pricePerBaseUnit(
  packPrice: number,
  spec: PackSpec,
): { price: number; unit: BaseUnit } | null {
  const units = baseUnitsPerPack(spec)
  if (!units || !(packPrice >= 0)) return null
  return { price: packPrice / units.amount, unit: units.unit }
}

/** The "standard" display quantity for a base unit: per litre, per kg or each. */
export function standardQuantity(unit: BaseUnit): {
  amount: number
  label: string
  /** Short unit for maths, e.g. 'L' in "2L". */
  short: string
} {
  if (unit === 'ml') return { amount: 1000, label: 'per litre', short: 'L' }
  if (unit === 'g') return { amount: 1000, label: 'per kg', short: 'kg' }
  return { amount: 1, label: 'each', short: '' }
}

/** Price per litre / per kg / each, from a per-base-unit price. */
export function perStandardUnit(ppu: number, unit: BaseUnit): number {
  return ppu * standardQuantity(unit).amount
}

/** Human-readable pack description, e.g. "6 x 2L" or "3kg". */
export function describePack(spec: PackSpec): string {
  if (spec.pack_unit == null) return 'unknown pack'
  const size = spec.pack_size ?? (spec.pack_unit === 'each' ? 1 : null)
  if (size == null) return 'unknown pack'
  const perCase = spec.units_per_case ?? 1
  if (spec.pack_unit === 'each') {
    const total = size * perCase
    return total === 1 ? 'single' : `pack of ${fmtNum(total)}`
  }
  const one = `${fmtNum(size)}${UNIT_LABEL[spec.pack_unit]}`
  return perCase > 1 ? `${perCase} x ${one}` : one
}

const UNIT_LABEL: Record<RawUnit, string> = {
  ml: 'ml',
  cl: 'cl',
  l: 'L',
  g: 'g',
  kg: 'kg',
  each: '',
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}
