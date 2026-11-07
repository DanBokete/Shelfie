// Read models for the pages. All numbers come from lib/savings.ts.
import { classify, productInsight } from './savings'
import type {
  FindingGroup,
  Observation,
  PriceSource,
  ProductInsight,
} from './savings'
import { db, must } from './supabase.server'
import { perStandardUnit } from './units'
import type { BaseUnit } from './units'

export interface Product {
  id: string
  canonical_name: string
  brand: string | null
  barcode: string | null
  category: string | null
  base_unit: BaseUnit
  /** What the owner sells it for, ex VAT, per 1 ml, 1 g or 1 item. Null until entered. */
  selling_price_per_base_unit: number | null
}

const PRODUCT_COLS =
  'id, canonical_name, brand, barcode, category, base_unit, selling_price_per_base_unit'

/** First and last invoice dates across the business, used to annualise volume. */
export async function invoicePeriod(): Promise<{
  first: string
  last: string
} | null> {
  const rows = must(
    await db()
      .from('invoices')
      .select('invoice_date')
      .eq('status', 'done')
      .not('invoice_date', 'is', null),
    'invoice period',
  ) as Array<{ invoice_date: string }>
  if (rows.length === 0) return null
  const dates = rows.map((r) => r.invoice_date).sort()
  return { first: dates[0], last: dates[dates.length - 1] }
}

interface ObsRow {
  product_id: string
  supplier_id: string
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  price_per_base_unit: number | null
  quantity: number | null
  observed_on: string
  observed_at: string
  source: PriceSource
  raw_description: string
  source_url: string | null
  invoice_id: string | null
  review_reasons: Array<string>
  suppliers: { name: string } | null
}

/** Web prices older than this stop counting towards savings: re-check to refresh them. */
export const WEB_PRICE_MAX_AGE_DAYS = 14

/** All matched observations, grouped by product. Pages through results (PostgREST caps at 1000). */
export async function observationsByProduct(
  productIds?: Array<string>,
  includeUntrusted = false,
): Promise<Map<string, Array<Observation & { invoice_id: string | null }>>> {
  const out = new Map<
    string,
    Array<Observation & { invoice_id: string | null }>
  >()
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    let q = db()
      .from('price_observations')
      .select(
        'product_id, supplier_id, pack_price, pack_size, pack_unit, units_per_case, price_per_base_unit, quantity, observed_on, observed_at, source, raw_description, source_url, invoice_id, review_reasons, suppliers(name)',
      )
      .not('product_id', 'is', null)
      .order('id')
      .range(from, from + pageSize - 1)
    if (productIds) q = q.in('product_id', productIds)
    const rows = must(await q, 'load observations') as unknown as Array<ObsRow>
    for (const r of rows) {
      // A line with a reading or maths problem is not trusted until the owner checks it.
      // Match-only flags (60-85% confident) are accepted, as the matching rules say.
      if (
        !includeUntrusted &&
        r.review_reasons.some((x) => !x.startsWith('Match:'))
      )
        continue
      if (
        r.source === 'web' &&
        Date.now() - Date.parse(r.observed_at) >
          WEB_PRICE_MAX_AGE_DAYS * 86_400_000
      )
        continue
      const list = out.get(r.product_id) ?? []
      list.push({
        supplier_id: r.supplier_id,
        supplier_name: r.suppliers?.name ?? 'Unknown supplier',
        pack_price: Number(r.pack_price),
        pack_size: r.pack_size == null ? null : Number(r.pack_size),
        pack_unit: r.pack_unit,
        units_per_case: r.units_per_case,
        price_per_base_unit:
          r.price_per_base_unit == null ? null : Number(r.price_per_base_unit),
        quantity: r.quantity == null ? null : Number(r.quantity),
        observed_on: r.observed_on,
        source: r.source,
        raw_description: r.raw_description,
        source_url: r.source_url,
        invoice_id: r.invoice_id,
      })
      out.set(r.product_id, list)
    }
    if (rows.length < pageSize) break
  }
  return out
}

export async function allProducts(): Promise<Array<Product>> {
  return must(
    await db().from('products').select(PRODUCT_COLS).order('canonical_name'),
    'load products',
  ) as Array<Product>
}

export interface Opportunity {
  product: Product
  insight: ProductInsight
  group: FindingGroup
}

export async function allOpportunities(): Promise<Array<Opportunity>> {
  const [products, obs, period] = await Promise.all([
    allProducts(),
    observationsByProduct(),
    invoicePeriod(),
  ])
  return products.map((p) => {
    const insight = productInsight(obs.get(p.id) ?? [], { period })
    return { product: p, insight, group: classify(insight) }
  })
}

/** Monday of the week a YYYY-MM-DD date falls in. */
function weekStart(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Invoice spend per week, and in total per supplier. Lines still needing a check are left out. */
export async function spendSummary() {
  const rows = must(
    await db()
      .from('price_observations')
      .select('observed_on, line_total, suppliers(name)')
      .eq('source', 'invoice')
      .eq('needs_review', false)
      .not('line_total', 'is', null),
    'load spend',
  ) as unknown as Array<{
    observed_on: string
    line_total: number
    suppliers: { name: string } | null
  }>
  const byWeek = new Map<string, Record<string, number>>()
  const bySupplier = new Map<string, number>()
  for (const r of rows) {
    const week = weekStart(r.observed_on)
    const supplier = r.suppliers?.name ?? 'Unknown supplier'
    const amount = Number(r.line_total)
    const row = byWeek.get(week) ?? {}
    row[supplier] = (row[supplier] ?? 0) + amount
    byWeek.set(week, row)
    bySupplier.set(supplier, (bySupplier.get(supplier) ?? 0) + amount)
  }
  return {
    weeks: [...byWeek.keys()]
      .sort()
      .map((week) => ({ week, by_supplier: byWeek.get(week)! })),
    // Biggest first: the main supplier takes the first chart colour.
    suppliers: [...bySupplier.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => ({ name, total })),
  }
}

/** Price per litre / kg / each over time, at the supplier whose price crept up. */
async function creepHistory(opps: Array<Opportunity>) {
  const obs = await observationsByProduct(opps.map((o) => o.product.id))
  return new Map(
    opps.map((o) => {
      const creep = o.insight.creep!
      const points = (obs.get(o.product.id) ?? [])
        .filter(
          (x) =>
            x.supplier_id === creep.supplier_id &&
            x.price_per_base_unit != null,
        )
        .sort((a, b) => a.observed_on.localeCompare(b.observed_on))
        .map((x) => ({
          date: x.observed_on,
          price: perStandardUnit(x.price_per_base_unit!, o.product.base_unit),
        }))
      return [o.product.id, points]
    }),
  )
}

export async function homeSummary() {
  const [opps, counts, review, spend] = await Promise.all([
    allOpportunities(),
    Promise.all([
      db()
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'done'),
      db()
        .from('suppliers')
        .select('id', { count: 'exact', head: true })
        .eq('kind', 'supplier'),
      db()
        .from('price_observations')
        .select('id', { count: 'exact', head: true }),
    ]),
    db()
      .from('price_observations')
      .select('id', { count: 'exact', head: true })
      .eq('needs_review', true),
    spendSummary(),
  ])
  const switches = opps
    .filter((o) => o.group === 'switch' && (o.insight.annual_saving ?? 0) > 0)
    .sort(
      (a, b) => (b.insight.annual_saving ?? 0) - (a.insight.annual_saving ?? 0),
    )
  const creeps = opps
    .filter((o) => o.insight.creep)
    .sort((a, b) => b.insight.creep!.pct - a.insight.creep!.pct)
    .slice(0, 3)
  const history = await creepHistory(creeps)
  return {
    total_annual_saving: switches.reduce(
      (s, o) => s + (o.insight.annual_saving ?? 0),
      0,
    ),
    top: switches.slice(0, 5).map(summarise),
    creeps: creeps.map((o) => ({
      ...summarise(o),
      history: history.get(o.product.id) ?? [],
    })),
    invoices: counts[0].count ?? 0,
    suppliers: counts[1].count ?? 0,
    prices: counts[2].count ?? 0,
    products: opps.length,
    needs_review: review.count ?? 0,
    spend,
  }
}

function summarise(o: Opportunity) {
  return {
    product_id: o.product.id,
    name: o.product.canonical_name,
    base_unit: o.product.base_unit,
    annual_saving: o.insight.annual_saving,
    current_supplier: o.insight.current?.supplier_name ?? null,
    cheapest_supplier: o.insight.cheapest?.supplier_name ?? null,
    pct_cheaper: o.insight.pct_cheaper,
    creep_pct: o.insight.creep?.pct ?? null,
  }
}

export async function productDetail(productId: string) {
  const product = must(
    await db()
      .from('products')
      .select(PRODUCT_COLS)
      .eq('id', productId)
      .maybeSingle<Product>(),
    'load product',
  )
  if (!product) return null
  const [obsMap, period] = await Promise.all([
    observationsByProduct([productId]),
    invoicePeriod(),
  ])
  const obs = obsMap.get(productId) ?? []
  const insight = productInsight(obs, { period })

  // "How we matched this": every distinct raw name per supplier with its unit maths.
  const seen = new Set<string>()
  const names = [...obs]
    .sort((a, b) => (a.observed_on < b.observed_on ? 1 : -1))
    .filter((o) => {
      const k = `${o.supplier_id}|${o.raw_description}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map((o) => ({
      supplier_name: o.supplier_name,
      raw_description: o.raw_description,
      source: o.source,
      pack_price: o.pack_price,
      pack_size: o.pack_size,
      pack_unit: o.pack_unit,
      units_per_case: o.units_per_case,
      ppu: o.price_per_base_unit,
      observed_on: o.observed_on,
    }))

  // Price history of the current supplier, for the creep line.
  const history = obs
    .filter(
      (o) =>
        insight.current &&
        o.supplier_id === insight.current.supplier_id &&
        o.price_per_base_unit != null,
    )
    .sort((a, b) => (a.observed_on < b.observed_on ? -1 : 1))
    .map((o) => ({ date: o.observed_on, ppu: o.price_per_base_unit! }))

  const supplier = insight.current
    ? (must(
        await db()
          .from('suppliers')
          .select('id, name, email')
          .eq('id', insight.current.supplier_id)
          .single(),
        'load supplier',
      ) as { id: string; name: string; email: string | null })
    : null

  return {
    product,
    insight,
    group: classify(insight),
    names,
    history,
    supplier,
    period,
  }
}

export async function findByBarcode(code: string): Promise<Product | null> {
  return must(
    await db()
      .from('products')
      .select(PRODUCT_COLS)
      .eq('barcode', code.trim())
      .maybeSingle<Product>(),
    'barcode lookup',
  )
}

export async function searchProducts(q: string): Promise<Array<Product>> {
  const term = q.trim()
  let query = db()
    .from('products')
    .select(PRODUCT_COLS)
    .order('canonical_name')
    .limit(20)
  if (term)
    query = query.ilike('canonical_name', `%${term.replace(/[%_,()]/g, ' ')}%`)
  return must(await query, 'search products') as Array<Product>
}

export async function invoiceList() {
  const invoices = must(
    await db()
      .from('invoices')
      .select(
        'id, file_name, status, error, invoice_date, invoice_number, confidence, created_at, suppliers(name)',
      )
      .order('created_at', { ascending: false }),
    'load invoices',
  ) as unknown as Array<{
    id: string
    file_name: string | null
    status: string
    error: string | null
    invoice_date: string | null
    invoice_number: string | null
    confidence: number | null
    created_at: string
    suppliers: { name: string } | null
  }>
  return invoices.map((i) => ({
    ...i,
    supplier_name: i.suppliers?.name ?? null,
  }))
}

export async function invoiceLines(invoiceId: string) {
  const rows = must(
    await db()
      .from('price_observations')
      .select(
        'id, line_index, raw_description, quantity, pack_price, line_total, pack_size, pack_unit, units_per_case, price_per_base_unit, extraction_confidence, match_confidence, match_reason, needs_review, review_reasons, products(id, canonical_name, base_unit)',
      )
      .eq('invoice_id', invoiceId)
      .order('line_index'),
    'load invoice lines',
  )
  return rows as unknown as Array<InvoiceLineRow>
}

export interface InvoiceLineRow {
  id: string
  line_index: number
  raw_description: string
  quantity: number | null
  pack_price: number
  line_total: number | null
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  price_per_base_unit: number | null
  extraction_confidence: number | null
  match_confidence: number | null
  match_reason: string | null
  needs_review: boolean
  review_reasons: Array<string>
  products: { id: string; canonical_name: string; base_unit: BaseUnit } | null
}

export async function reviewQueue() {
  const rows = must(
    await db()
      .from('price_observations')
      .select(
        'id, raw_description, quantity, pack_price, line_total, pack_size, pack_unit, units_per_case, observed_on, source, review_reasons, match_confidence, suppliers(name), products(id, canonical_name, base_unit), invoices(invoice_number)',
      )
      .eq('needs_review', true)
      .order('observed_on', { ascending: false }),
    'load review queue',
  )
  return rows as unknown as Array<{
    id: string
    raw_description: string
    quantity: number | null
    pack_price: number
    line_total: number | null
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
    observed_on: string
    source: string
    review_reasons: Array<string>
    match_confidence: number | null
    suppliers: { name: string } | null
    products: { id: string; canonical_name: string; base_unit: BaseUnit } | null
    invoices: { invoice_number: string | null } | null
  }>
}
