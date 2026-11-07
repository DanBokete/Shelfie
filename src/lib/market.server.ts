// Live competitor prices. One check searches the web for one product, keeps the offers
// that are the same product or a close equivalent, and stores each as a dated 'web' price.
// The model only reads what the pages say: every stored number comes from lib/units.ts.
import { askJSON, searchWeb } from './claude.server'
import type { WebSource } from './claude.server'
import { P7_WEB_PRICE_SEARCH, P8_WEB_PRICE_READ } from './prompts'
import {
  WEB_PRICE_MAX_AGE_DAYS,
  allOpportunities,
  observationsByProduct,
} from './queries.server'
import type { Product } from './queries.server'
import { currentPrice } from './savings'
import { WebOffers } from './schemas'
import type { WebOffer } from './schemas'
import { db, must } from './supabase.server'
import {
  baseUnitsPerPack,
  describePack,
  isRawUnit,
  perStandardUnit,
  standardQuantity,
} from './units'
import type { PackSpec } from './units'

/** Offers the model is less sure of than this are dropped. */
const MIN_CONFIDENCE = 0.5

export interface PriceCheck {
  id: string
  product_id: string
  status: 'running' | 'done' | 'failed'
  started_at: string
  finished_at: string | null
  offers_found: number
  summary: string | null
  error: string | null
}

const CHECK_COLS =
  'id, product_id, status, started_at, finished_at, offers_found, summary, error'

/** Today in Ireland, YYYY-MM-DD. */
function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' })
}

/** Host and path without query or trailing slash, so the same page always compares equal. */
function pageKey(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase()
  } catch {
    return null
  }
}

/** What the owner buys now, in words, so the search looks for the same thing. */
function describeProduct(
  product: Product,
  current: ReturnType<typeof currentPrice>,
): string {
  const std = standardQuantity(product.base_unit)
  const lines = [
    `Product: ${product.canonical_name}`,
    product.brand ? `Brand: ${product.brand}` : null,
    product.category ? `Category: ${product.category}` : null,
  ]
  if (current) {
    const spec: PackSpec = {
      pack_size: current.pack_size,
      pack_unit: isRawUnit(current.pack_unit) ? current.pack_unit : null,
      units_per_case: current.units_per_case,
    }
    lines.push(
      `On the owner's invoice as: "${current.raw_description}" (${describePack(spec)})`,
      `They pay €${current.pack_price.toFixed(2)} ex VAT per pack, which is €${perStandardUnit(current.ppu, product.base_unit).toFixed(2)} ${std.label}.`,
    )
  }
  lines.push(`Today is ${today()}. The owner runs a cafe in Cork, Ireland.`)
  return lines.filter(Boolean).join('\n')
}

/** The competitor row for a shop name, created on first sight. */
async function competitorId(name: string, url: string): Promise<string> {
  const clean = name.trim()
  const find = async () =>
    must(
      await db()
        .from('suppliers')
        .select('id')
        .eq('kind', 'competitor')
        .ilike('name', clean.replace(/[%_]/g, '\\$&'))
        .maybeSingle<{ id: string }>(),
      'find competitor',
    )
  const hit = await find()
  if (hit) return hit.id
  const res = await db()
    .from('suppliers')
    .insert({ name: clean, kind: 'competitor', website: new URL(url).origin })
    .select('id')
    .single<{ id: string }>()
  // Another check running alongside created it first.
  if (res.error?.code === '23505') {
    const again = await find()
    if (again) return again.id
  }
  return (must(res, 'create competitor') as { id: string }).id
}

interface Priced {
  offer: WebOffer
  spec: PackSpec
  packPriceExVat: number
  ppu: number
  vatNote: string | null
}

/** Unit maths for one offer, ex VAT. Null when it cannot be compared with this product. */
function price(offer: WebOffer, product: Product): Priced | null {
  const spec: PackSpec = {
    pack_size: offer.pack_size,
    pack_unit: offer.pack_unit,
    units_per_case: offer.units_per_case,
  }
  const units = baseUnitsPerPack(spec)
  if (!units || units.unit !== product.base_unit || !(offer.price > 0))
    return null
  // Invoices are ex VAT, so take VAT off shelf prices. With the rate unknown the
  // price is kept as shown, which can only make the competitor look dearer.
  const rate = offer.vat_included ? offer.vat_rate_percent : 0
  const packPriceExVat =
    rate == null ? offer.price : offer.price / (1 + rate / 100)
  return {
    offer,
    spec,
    packPriceExVat: Math.round(packPriceExVat * 100) / 100,
    ppu: packPriceExVat / units.amount,
    vatNote: rate == null ? 'Web: shelf price incl. VAT, rate unknown' : null,
  }
}

/**
 * Searches the web for one product and stores what it finds. The check row is written
 * first, so the owner can see when every check ran, including ones that failed.
 */
export async function checkProductPrices(
  productId: string,
): Promise<PriceCheck> {
  const product = must(
    await db()
      .from('products')
      .select('id, canonical_name, brand, barcode, category, base_unit')
      .eq('id', productId)
      .single(),
    'load product',
  ) as Product
  const check = must(
    await db()
      .from('price_checks')
      .insert({ product_id: productId })
      .select(CHECK_COLS)
      .single(),
    'start price check',
  ) as PriceCheck

  let sources: Array<WebSource> = []
  try {
    const obs = (await observationsByProduct([productId])).get(productId) ?? []
    const current = currentPrice(obs)

    const research = await searchWeb({
      name: 'prices',
      system: P7_WEB_PRICE_SEARCH,
      prompt: describeProduct(product, current),
    })
    sources = research.sources
    if (!research.text) throw new Error('The web search came back empty.')

    const known = must(
      await db().from('suppliers').select('name').eq('kind', 'competitor'),
      'load competitors',
    ) as Array<{ name: string }>
    const read = await askJSON({
      name: 'prices-read',
      system: P8_WEB_PRICE_READ,
      content: [
        `Product: ${product.canonical_name}${product.brand ? ` (${product.brand})` : ''}`,
        `Known sellers: ${known.map((k) => k.name).join(', ') || 'none yet'}`,
        `Research notes:\n${research.text}`,
      ].join('\n\n'),
      schema: WebOffers,
      effort: 'low',
    })

    // Keep offers for pages the search really opened, that match, and that we can price.
    const seen = new Set(sources.map((s) => pageKey(s.url)))
    const priced = read.offers
      .filter(
        (o) =>
          o.match !== 'different' &&
          o.confidence >= MIN_CONFIDENCE &&
          seen.has(pageKey(o.url)),
      )
      .map((o) => price(o, product))
      .filter((p): p is Priced => p !== null)

    // One price per shop: its cheapest like-for-like listing.
    const bySeller = new Map<string, Priced>()
    for (const p of priced) {
      const k = p.offer.seller.trim().toLowerCase()
      const prev = bySeller.get(k)
      if (!prev || p.ppu < prev.ppu) bySeller.set(k, p)
    }

    const rows = []
    for (const p of bySeller.values()) {
      const reasons = [
        p.offer.match === 'equivalent'
          ? `Match: close equivalent, ${p.offer.match_note}`
          : null,
        p.vatNote,
      ].filter((x): x is string => x !== null)
      rows.push({
        product_id: productId,
        supplier_id: await competitorId(p.offer.seller, p.offer.url),
        price_check_id: check.id,
        raw_description: p.offer.title,
        pack_price: p.packPriceExVat,
        pack_size: p.spec.pack_size,
        pack_unit: p.spec.pack_unit,
        units_per_case: p.spec.units_per_case,
        price_per_base_unit: p.ppu,
        observed_on: today(),
        source: 'web',
        source_url: p.offer.url,
        extraction_confidence: p.offer.confidence,
        match_confidence: p.offer.match === 'exact' ? 0.95 : 0.75,
        match_reason: `${p.offer.match_note}${p.offer.promo ? ' (on offer)' : ''}`,
        review_reasons: reasons,
      })
    }
    if (rows.length)
      must(
        await db().from('price_observations').insert(rows),
        'save web prices',
      )

    return must(
      await db()
        .from('price_checks')
        .update({
          status: 'done',
          finished_at: new Date().toISOString(),
          offers_found: rows.length,
          summary: rows.length
            ? read.summary
            : 'No like-for-like prices found online.',
          sources,
        })
        .eq('id', check.id)
        .select(CHECK_COLS)
        .single(),
      'finish price check',
    ) as PriceCheck
  } catch (err) {
    await db()
      .from('price_checks')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        sources,
      })
      .eq('id', check.id)
    throw err
  }
}

/** A check still 'running' after this long died with the server. */
export const STALE_RUNNING_MS = 5 * 60_000

/** Latest check per product, newest first. */
export async function latestChecks(
  productIds?: Array<string>,
): Promise<Map<string, PriceCheck>> {
  let q = db()
    .from('price_checks')
    .select(CHECK_COLS)
    .order('started_at', { ascending: false })
  if (productIds) q = q.in('product_id', productIds)
  const rows = must(await q, 'load price checks') as Array<PriceCheck>
  const out = new Map<string, PriceCheck>()
  for (const r of rows) {
    if (out.has(r.product_id)) continue
    out.set(r.product_id, settle(r))
  }
  return out
}

/** Marks a check that never finished as failed. */
export function settle(c: PriceCheck): PriceCheck {
  return c.status === 'running' &&
    Date.now() - Date.parse(c.started_at) > STALE_RUNNING_MS
    ? { ...c, status: 'failed', error: c.error ?? 'The check did not finish.' }
    : c
}

/** Every product with what the owner pays, the cheapest live price online, and its last check. */
export async function livePricesOverview() {
  const [opps, checks] = await Promise.all([allOpportunities(), latestChecks()])
  return opps
    .map(({ product, insight }) => {
      const cur = insight.current
      // Suppliers come cheapest first; web prices past their age limit are already gone.
      const best = insight.suppliers.find((s) => s.source === 'web') ?? null
      return {
        product_id: product.id,
        name: product.canonical_name,
        category: product.category,
        base_unit: product.base_unit,
        current: cur
          ? { supplier_name: cur.supplier_name, ppu: cur.ppu }
          : null,
        best_online: best
          ? {
              supplier_name: best.supplier_name,
              ppu: best.ppu,
              url: best.source_url,
            }
          : null,
        pct_vs_you: cur && best ? (best.ppu - cur.ppu) / cur.ppu : null,
        last_check: checks.get(product.id) ?? null,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface WebPrice {
  id: string
  seller: string
  title: string
  url: string | null
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  ppu: number
  observed_at: string
  note: string | null
  review_reasons: Array<string>
}

/** A product's recent checks, and the prices its latest finished check found. */
export async function productPriceChecks(productId: string) {
  const checks = (
    must(
      await db()
        .from('price_checks')
        .select(CHECK_COLS)
        .eq('product_id', productId)
        .order('started_at', { ascending: false })
        .limit(10),
      'load price checks',
    ) as Array<PriceCheck>
  ).map(settle)
  const latest = checks.find((c) => c.status === 'done')
  const rows = latest
    ? (must(
        await db()
          .from('price_observations')
          .select(
            'id, raw_description, pack_price, pack_size, pack_unit, units_per_case, price_per_base_unit, source_url, observed_at, match_reason, review_reasons, suppliers(name)',
          )
          .eq('price_check_id', latest.id)
          .order('price_per_base_unit'),
        'load web prices',
      ) as unknown as Array<{
        id: string
        raw_description: string
        pack_price: number
        pack_size: number | null
        pack_unit: string | null
        units_per_case: number | null
        price_per_base_unit: number
        source_url: string | null
        observed_at: string
        match_reason: string | null
        review_reasons: Array<string>
        suppliers: { name: string } | null
      }>)
    : []
  const offers: Array<WebPrice> = rows.map((r) => ({
    id: r.id,
    seller: r.suppliers?.name ?? 'Unknown seller',
    title: r.raw_description,
    url: r.source_url,
    pack_price: Number(r.pack_price),
    pack_size: r.pack_size == null ? null : Number(r.pack_size),
    pack_unit: r.pack_unit,
    units_per_case: r.units_per_case,
    ppu: Number(r.price_per_base_unit),
    observed_at: r.observed_at,
    note: r.match_reason,
    review_reasons: r.review_reasons,
  }))
  return { checks, offers, max_age_days: WEB_PRICE_MAX_AGE_DAYS }
}
