// What the owner sells a product for. Entered per pack (the pack they buy now), stored per base
// unit so it still means the same thing if the supplier's pack size changes.
import { invoicePeriod, observationsByProduct } from './queries.server'
import { productInsight } from './savings'
import { db, must, mustOne } from './supabase.server'
import { baseUnitsPerPack, isRawUnit } from './units'

/** Base units (ml, g or items) in the pack the owner buys now, or null with no usable invoice. */
async function currentPackAmount(productId: string): Promise<number | null> {
  const [obs, period] = await Promise.all([
    observationsByProduct([productId]),
    invoicePeriod(),
  ])
  const cur = productInsight(obs.get(productId) ?? [], { period }).current
  if (!cur || !isRawUnit(cur.pack_unit)) return null
  return (
    baseUnitsPerPack({
      pack_size: cur.pack_size,
      pack_unit: cur.pack_unit,
      units_per_case: cur.units_per_case,
    })?.amount ?? null
  )
}

/** The selling price of the pack the owner buys now (ex VAT, euro), or null when not entered. */
export async function sellingPricePerPack(
  productId: string,
): Promise<number | null> {
  const row = mustOne(
    await db()
      .from('products')
      .select('selling_price_per_base_unit')
      .eq('id', productId)
      .single<{ selling_price_per_base_unit: number | null }>(),
    'load selling price',
  )
  if (row.selling_price_per_base_unit == null) return null
  const amount = await currentPackAmount(productId)
  if (amount == null) return null
  return (
    Math.round(Number(row.selling_price_per_base_unit) * amount * 100) / 100
  )
}

/** Saves what a pack sells for (ex VAT), or clears it with null. */
export async function setSellingPrice(
  productId: string,
  packPrice: number | null,
): Promise<void> {
  let perUnit: number | null = null
  if (packPrice != null) {
    const amount = await currentPackAmount(productId)
    if (amount == null)
      throw new Error(
        'Add an invoice for this product first, so Shelfie knows the pack size.',
      )
    perUnit = packPrice / amount
  }
  must(
    await db()
      .from('products')
      .update({ selling_price_per_base_unit: perUnit })
      .eq('id', productId),
    'save selling price',
  )
}
