// How much of a product the owner uses a year, from their stock list. Pure, so it is unit-tested.
// The latest stock list uploaded on the Savings page is the owner's own count of what they
// use each week, so it beats an estimate from invoice history wherever both exist.
import { baseUnitsPerPack } from './units'
import type { BaseUnit, PackSpec } from './units'

export interface StockLine {
  /** Packs a week, as normalised when the list was read. */
  weekly_quantity: number | null
  /** What one counted unit holds, when the list said so (e.g. a case of 6 x 2L). */
  pack_spec: PackSpec | null
}

/**
 * Base units (ml, g or items) a year across a product's lines on the stock list:
 * packs a week x 52 x what one pack holds. A line with no usable pack size is counted in
 * the owner's current pack, as the Savings report does. Null when no line can be counted.
 */
export function stockAnnualUnits(
  lines: Array<StockLine>,
  baseUnit: BaseUnit,
  currentPack: PackSpec | null,
): number | null {
  const fits = (spec: PackSpec | null) => {
    const units = spec ? baseUnitsPerPack(spec) : null
    return units && units.unit === baseUnit ? units.amount : null
  }
  let total = 0
  let counted = false
  for (const line of lines) {
    if (line.weekly_quantity == null || !(line.weekly_quantity > 0)) continue
    const perPack = fits(line.pack_spec) ?? fits(currentPack)
    if (perPack == null) continue
    total += line.weekly_quantity * 52 * perPack
    counted = true
  }
  return counted ? total : null
}
