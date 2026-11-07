// Supplier price lists: structured CSV rows loaded as price_observations (source = 'price_list').
import { randomUUID } from 'node:crypto'
import Papa from 'papaparse'
import { findOrCreateSupplier } from './invoices.server'
import { applyOutcomes, matchLines, observationPpu } from './match.server'
import { db, must } from './supabase.server'

export interface PriceListRow {
  description: string
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
}

export function parsePriceListCsv(csv: string): Array<PriceListRow> {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
  })
  return parsed.data.map((r) => ({
    description: r.description.trim(),
    pack_price: Number(r.pack_price),
    pack_size: r.pack_size ? Number(r.pack_size) : null,
    pack_unit: r.pack_unit || null,
    units_per_case: r.units_per_case ? Number(r.units_per_case) : 1,
  }))
}

export async function loadPriceList(
  supplierName: string,
  date: string,
  rows: Array<PriceListRow>,
) {
  const supplier = await findOrCreateSupplier(supplierName)
  // Replace any earlier copy of the same list.
  await db()
    .from('price_observations')
    .delete()
    .eq('supplier_id', supplier.id)
    .eq('source', 'price_list')
    .eq('observed_on', date)
  const obs = rows.map((r, i) => {
    const { ppu, reason } = observationPpu(r, null)
    return {
      id: randomUUID(),
      supplier_id: supplier.id,
      line_index: i,
      raw_description: r.description,
      quantity: null,
      pack_price: r.pack_price,
      pack_size: r.pack_size,
      pack_unit: r.pack_unit,
      units_per_case: r.units_per_case,
      price_per_base_unit: ppu,
      observed_on: date,
      source: 'price_list' as const,
      needs_review: reason != null,
      review_reasons: reason ? [reason] : [],
    }
  })
  must(await db().from('price_observations').insert(obs), 'store price list')
  const outcomes = await matchLines(
    obs.map((o) => ({
      id: o.id,
      description: o.raw_description,
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      barcode: null,
    })),
  )
  await applyOutcomes(outcomes)
  return { supplier, lines: obs.length, outcomes }
}
