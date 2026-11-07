// The owner's latest stock list, as yearly volumes for savings across the app (Home, Live
// prices, product pages, emails and alerts). Products not on the list fall back to invoice
// history, exactly as before. The maths is in lib/stock-volume.ts.
import { currentPrice } from './savings'
import type { InsightOptions, Observation } from './savings'
import { stockAnnualUnits } from './stock-volume'
import type { StockLine } from './stock-volume'
import { db, must } from './supabase.server'
import { isRawUnit } from './units'
import type { BaseUnit, PackSpec } from './units'

export interface StockList {
  id: string
  file_name: string | null
  uploaded_at: string
  /** product id -> its lines on the list (a product can appear more than once). */
  lines: Map<string, Array<StockLine>>
}

/** The most recent stock list whose report finished, or null when none was uploaded. */
export async function latestStockList(): Promise<StockList | null> {
  const upload = must(
    await db()
      .from('stock_uploads')
      .select('id, file_name, created_at')
      .eq('status', 'done')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string
        file_name: string | null
        created_at: string
      }>(),
    'load latest stock list',
  )
  if (!upload) return null
  const rows = must(
    await db()
      .from('stock_items')
      .select('product_id, weekly_quantity, pack_spec')
      .eq('upload_id', upload.id)
      .not('product_id', 'is', null),
    'load stock list items',
  ) as Array<{
    product_id: string
    weekly_quantity: number | null
    pack_spec: PackSpec | null
  }>
  const lines = new Map<string, Array<StockLine>>()
  for (const r of rows) {
    const list = lines.get(r.product_id) ?? []
    list.push({
      weekly_quantity:
        r.weekly_quantity == null ? null : Number(r.weekly_quantity),
      pack_spec: r.pack_spec,
    })
    lines.set(r.product_id, list)
  }
  return {
    id: upload.id,
    file_name: upload.file_name,
    uploaded_at: upload.created_at,
    lines,
  }
}

/** A product's yearly volume from the stock list, or null when it is not on it. */
export function stockVolume(
  list: StockList | null,
  product: { id: string; base_unit: BaseUnit },
  obs: Array<Observation>,
): number | null {
  const lines = list?.lines.get(product.id)
  if (!lines?.length) return null
  // Lines with no pack size are counted in the pack the owner buys now.
  const cur = currentPrice(obs)
  const currentPack: PackSpec | null =
    cur && isRawUnit(cur.pack_unit)
      ? {
          pack_size: cur.pack_size,
          pack_unit: cur.pack_unit,
          units_per_case: cur.units_per_case,
        }
      : null
  return stockAnnualUnits(lines, product.base_unit, currentPack)
}

/** productInsight options that use the stock list's volume when the product is on it. */
export function withStockVolume(
  opts: InsightOptions,
  list: StockList | null,
  product: { id: string; base_unit: BaseUnit },
  obs: Array<Observation>,
): InsightOptions {
  const volume = stockVolume(list, product, obs)
  return volume == null ? opts : { ...opts, annual_base_units: volume }
}
