// The savings engine. Every number shown to the owner comes from here, never
// from the model. Pure functions only, so the whole engine is unit-tested.

import { baseUnitsPerPack, isRawUnit } from './units'
import type { BaseUnit } from './units'

export interface Observation {
  supplier_id: string
  supplier_name: string
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  price_per_base_unit: number | null
  quantity: number | null
  observed_on: string // YYYY-MM-DD
  source: PriceSource
  raw_description: string
  source_url?: string | null // the product page, for web prices
}

/** Where a price came from. 'web' is a competitor's live price found online. */
export type PriceSource = 'invoice' | 'price_list' | 'web'

export interface SupplierPrice {
  supplier_id: string
  supplier_name: string
  ppu: number // price per 1 ml / 1 g / 1 item
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  observed_on: string
  source: PriceSource
  raw_description: string
  source_url: string | null
}

export interface PriceCreep {
  supplier_id: string
  supplier_name: string
  from_ppu: number
  to_ppu: number
  from_date: string
  to_date: string
  pct: number // 0.11 = up 11%
}

export interface ProductInsight {
  current: SupplierPrice | null
  cheapest: SupplierPrice | null // cheapest excluding the current supplier
  suppliers: Array<SupplierPrice> // latest price per supplier, cheapest first
  pct_cheaper: number | null // how much cheaper the cheapest option is, 0.15 = 15%
  annual_base_units: number | null
  annual_saving: number | null // euros, rounded, never negative
  per_unit_saving: number | null // ppu difference, never negative
  creep: PriceCreep | null
  two_prices: boolean
}

/** Rises below this are noise, not creep. */
export const CREEP_THRESHOLD = 0.03
export const TWO_PRICES_WINDOW_DAYS = 60
export const MIN_DAYS_COVERED = 30

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

/** Days of trading the invoices cover. Minimum 30 so a single invoice is not annualised x365. */
export function daysCovered(firstInvoice: string, lastInvoice: string): number {
  return Math.max(MIN_DAYS_COVERED, daysBetween(firstInvoice, lastInvoice))
}

function toSupplierPrice(o: Observation): SupplierPrice | null {
  if (o.price_per_base_unit == null) return null
  return {
    supplier_id: o.supplier_id,
    supplier_name: o.supplier_name,
    ppu: o.price_per_base_unit,
    pack_price: o.pack_price,
    pack_size: o.pack_size,
    pack_unit: o.pack_unit,
    units_per_case: o.units_per_case,
    observed_on: o.observed_on,
    source: o.source,
    raw_description: o.raw_description,
    source_url: o.source_url ?? null,
  }
}

/** Sort newest first; on the same day an invoice beats a price list. */
function byNewest(a: Observation, b: Observation): number {
  if (a.observed_on !== b.observed_on)
    return a.observed_on < b.observed_on ? 1 : -1
  if (a.source !== b.source) return a.source === 'invoice' ? -1 : 1
  return 0
}

/** Latest price per supplier, cheapest first. */
export function latestBySupplier(
  obs: Array<Observation>,
): Array<SupplierPrice> {
  const seen = new Map<string, SupplierPrice>()
  for (const o of [...obs].sort(byNewest)) {
    if (seen.has(o.supplier_id)) continue
    const sp = toSupplierPrice(o)
    if (sp) seen.set(o.supplier_id, sp)
  }
  return [...seen.values()].sort((a, b) => a.ppu - b.ppu)
}

/** The supplier on the most recent invoice line, at that line's price. */
export function currentPrice(obs: Array<Observation>): SupplierPrice | null {
  const invoiceLines = obs.filter(
    (o) => o.source === 'invoice' && o.price_per_base_unit != null,
  )
  if (invoiceLines.length === 0) return null
  return toSupplierPrice(invoiceLines.sort(byNewest)[0])
}

/** Total base units bought across all invoices, annualised. */
export function annualBaseUnits(
  obs: Array<Observation>,
  period: { first: string; last: string } | null,
): number | null {
  if (!period) return null
  let total = 0
  let any = false
  for (const o of obs) {
    if (o.source !== 'invoice' || o.quantity == null) continue
    if (!isRawUnit(o.pack_unit)) continue
    const units = baseUnitsPerPack({
      pack_size: o.pack_size,
      pack_unit: o.pack_unit,
      units_per_case: o.units_per_case,
    })
    if (!units) continue
    total += o.quantity * units.amount
    any = true
  }
  if (!any) return null
  return (total / daysCovered(period.first, period.last)) * 365
}

/** Latest vs earliest price from one supplier. Null below the 3% threshold. */
export function priceCreep(
  obs: Array<Observation>,
  supplierId: string,
): PriceCreep | null {
  const mine = obs
    .filter(
      (o) => o.supplier_id === supplierId && o.price_per_base_unit != null,
    )
    .sort(byNewest)
  if (mine.length < 2) return null
  const latest = mine[0]
  const earliest = mine[mine.length - 1]
  const from = earliest.price_per_base_unit!
  const to = latest.price_per_base_unit!
  if (!(from > 0)) return null
  const pct = (to - from) / from
  if (pct < CREEP_THRESHOLD) return null
  return {
    supplier_id: supplierId,
    supplier_name: latest.supplier_name,
    from_ppu: from,
    to_ppu: to,
    from_date: earliest.observed_on,
    to_date: latest.observed_on,
    pct,
  }
}

/** Bought from 2+ suppliers within 60 days of `asOf`, at different unit prices. */
export function hasTwoPrices(obs: Array<Observation>, asOf: string): boolean {
  const recent = obs.filter(
    (o) =>
      o.source === 'invoice' &&
      o.price_per_base_unit != null &&
      daysBetween(o.observed_on, asOf) <= TWO_PRICES_WINDOW_DAYS,
  )
  const latest = latestBySupplier(recent)
  if (latest.length < 2) return false
  const min = latest[0].ppu
  const max = latest[latest.length - 1].ppu
  return max - min > min * 0.005
}

export interface InsightOptions {
  /** Global invoice date range, used to annualise volume. */
  period: { first: string; last: string } | null
  /** Override the current supplier and price (e.g. from a stock list). */
  current?: SupplierPrice | null
  /** Override annual volume in base units (e.g. stock list weekly qty x 52). */
  annual_base_units?: number | null
}

export function productInsight(
  obs: Array<Observation>,
  opts: InsightOptions,
): ProductInsight {
  const suppliers = latestBySupplier(obs)
  const current = opts.current ?? currentPrice(obs)
  const others = current
    ? suppliers.filter((s) => s.supplier_id !== current.supplier_id)
    : suppliers
  const cheapestOther = others.length ? others[0] : null
  const cheaper =
    current && cheapestOther && cheapestOther.ppu < current.ppu
      ? cheapestOther
      : null

  const volume =
    opts.annual_base_units !== undefined
      ? opts.annual_base_units
      : annualBaseUnits(obs, opts.period)

  const perUnit =
    current && cheaper ? current.ppu - cheaper.ppu : current ? 0 : null
  const annual =
    perUnit != null && volume != null
      ? Math.max(0, Math.round(perUnit * volume))
      : null

  const asOf =
    opts.period?.last ??
    obs
      .map((o) => o.observed_on)
      .sort()
      .at(-1) ??
    null

  return {
    current,
    cheapest: cheaper ?? (current ? null : cheapestOther),
    suppliers,
    pct_cheaper:
      current && cheaper ? (current.ppu - cheaper.ppu) / current.ppu : null,
    annual_base_units: volume,
    annual_saving: annual,
    per_unit_saving: perUnit,
    creep: current ? priceCreep(obs, current.supplier_id) : null,
    two_prices: asOf ? hasTwoPrices(obs, asOf) : false,
  }
}

export type FindingGroup =
  'switch' | 'creep' | 'two_prices' | 'best' | 'no_data'

export const GROUP_ORDER: Array<FindingGroup> = [
  'switch',
  'creep',
  'two_prices',
  'best',
  'no_data',
]

export const GROUP_LABELS: Record<
  FindingGroup,
  { title: string; hint: string }
> = {
  switch: {
    title: 'Switch supplier',
    hint: 'A cheaper equivalent exists elsewhere.',
  },
  creep: {
    title: 'Price creep',
    hint: 'Your supplier raised the price by 3% or more.',
  },
  two_prices: {
    title: 'Two prices, one product',
    hint: 'You bought it from 2 suppliers in the last 60 days at different prices.',
  },
  best: { title: 'Best price already', hint: 'Nothing to do.' },
  no_data: {
    title: 'No price data',
    hint: 'Add an invoice from this supplier to check these.',
  },
}

/** Every item lands in exactly one group, in priority order. */
export function classify(insight: ProductInsight | null): FindingGroup {
  if (!insight || !insight.current) return 'no_data'
  if (insight.cheapest && (insight.per_unit_saving ?? 0) > 0) return 'switch'
  if (insight.creep) return 'creep'
  if (insight.two_prices) return 'two_prices'
  return 'best'
}

export function formatEuro(n: number, opts: { cents?: boolean } = {}): string {
  const cents = opts.cents ?? Math.abs(n) < 100
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(n)
}

export type { BaseUnit }
