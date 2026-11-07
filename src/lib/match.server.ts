// Feature 2: matching pipeline. Alias lookup -> barcode -> shortlist -> Claude -> thresholds -> remember.
import { askJSON } from './claude.server'
import { P2_PRODUCT_MATCHING } from './prompts'
import { MatchResponse } from './schemas'
import type { MatchResult } from './schemas'
import { db, must } from './supabase.server'
import { shortlist } from './tokens'
import type { Candidate } from './tokens'
import { isRawUnit, pricePerBaseUnit, toBase } from './units'
import type { BaseUnit } from './units'

export const ACCEPT = 0.85
export const REVIEW = 0.6

export interface MatchLine {
  /** price_observations.id */
  id: string
  description: string
  supplier_id: string
  supplier_name: string
  barcode: string | null
}

export interface MatchOutcome {
  id: string
  product_id: string
  method: 'alias' | 'barcode' | 'ai' | 'new_product'
  confidence: number
  reason: string
  needs_review: boolean
}

/** A product the matcher would create; for a suggestion nothing is created yet. */
export interface NewProduct {
  canonical_name: string
  brand: string | null
  category: string
  base_unit: BaseUnit
}

/**
 * A match that is only suggested (suggestMatches): no alias saved, no product created. When
 * the matcher would create a product, product_id is null and new_product says what.
 */
export interface MatchSuggestion extends Omit<MatchOutcome, 'product_id'> {
  product_id: string | null
  new_product: NewProduct | null
}

export interface ProductRow {
  id: string
  canonical_name: string
  brand: string | null
  barcode: string | null
  category: string | null
  base_unit: BaseUnit
}

// Matching reads and grows the catalogue, so concurrent invoices must not interleave or
// they would each create their own "Whole milk". One queue per server process.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

export async function loadCatalogue(): Promise<{
  products: Array<ProductRow>
  candidates: Array<Candidate>
}> {
  const products = must(
    await db()
      .from('products')
      .select('id, canonical_name, brand, barcode, category, base_unit'),
    'load products',
  ) as Array<ProductRow>
  const aliases = must(
    await db().from('product_aliases').select('product_id, raw_text'),
    'load aliases',
  ) as Array<{ product_id: string; raw_text: string }>
  const byProduct = new Map<string, Array<string>>()
  for (const a of aliases) {
    const list = byProduct.get(a.product_id) ?? []
    list.push(a.raw_text)
    byProduct.set(a.product_id, list)
  }
  const candidates = products.map((p) => ({
    product_id: p.id,
    name:
      p.brand && !p.canonical_name.toLowerCase().includes(p.brand.toLowerCase())
        ? `${p.brand} ${p.canonical_name}`
        : p.canonical_name,
    names: [p.canonical_name, ...(byProduct.get(p.id) ?? [])],
  }))
  return { products, candidates }
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function findProduct(
  products: Array<ProductRow>,
  name: string,
): ProductRow | undefined {
  return products.find((p) => normName(p.canonical_name) === normName(name))
}

/** Uses the product with this name, or creates it (only when remembering). */
async function resolveProduct(
  products: Array<ProductRow>,
  np: NewProduct,
  remember: boolean,
): Promise<{ id: string | null; new_product: NewProduct | null }> {
  const existing = findProduct(products, np.canonical_name)
  if (existing) return { id: existing.id, new_product: null }
  if (!remember) return { id: null, new_product: np }
  const created = await createProduct(products, np)
  return { id: created.id, new_product: null }
}

/** Creates a product, or returns the one with the same name. */
export async function findOrCreateProduct(
  products: Array<ProductRow>,
  np: NewProduct,
): Promise<ProductRow> {
  return findProduct(products, np.canonical_name) ?? createProduct(products, np)
}

async function createProduct(
  products: Array<ProductRow>,
  np: NewProduct,
): Promise<ProductRow> {
  const created = must(
    await db()
      .from('products')
      .insert({
        canonical_name: np.canonical_name,
        brand: np.brand,
        category: np.category,
        base_unit: np.base_unit,
      })
      .select('id, canonical_name, brand, barcode, category, base_unit')
      .single(),
    'create product',
  ) as ProductRow
  products.push(created)
  return created
}

/** Runs the whole pipeline for a batch of lines (one invoice or one price list). */
export async function matchLines(
  lines: Array<MatchLine>,
): Promise<Array<MatchOutcome>> {
  const out = await serial(() => matchLinesNow(lines, true))
  return out.map(({ new_product: _n, product_id, ...o }) => ({
    ...o,
    product_id: product_id!,
  }))
}

/**
 * The same pipeline without remembering anything: no alias is saved, no barcode attached and
 * no product created. For prices that wait for the owner (supplier replies): applying a line
 * remembers its match then.
 */
export function suggestMatches(
  lines: Array<MatchLine>,
): Promise<Array<MatchSuggestion>> {
  return serial(() => matchLinesNow(lines, false))
}

async function matchLinesNow(
  lines: Array<MatchLine>,
  remember: boolean,
): Promise<Array<MatchSuggestion>> {
  if (lines.length === 0) return []
  const { products, candidates } = await loadCatalogue()
  const outcomes = new Map<string, MatchSuggestion>()

  // 1. Alias lookup (free, instant)
  const aliasRows = must(
    await db()
      .from('product_aliases')
      .select('supplier_id, raw_text, product_id, confirmed')
      .in('raw_text', [...new Set(lines.map((l) => l.description))]),
    'alias lookup',
  ) as Array<{
    supplier_id: string | null
    raw_text: string
    product_id: string
    confirmed: boolean
  }>
  for (const l of lines) {
    const hit = aliasRows.find(
      (a) => a.supplier_id === l.supplier_id && a.raw_text === l.description,
    )
    if (hit) {
      outcomes.set(l.id, {
        id: l.id,
        product_id: hit.product_id,
        new_product: null,
        method: 'alias',
        confidence: 1,
        reason: hit.confirmed
          ? 'Confirmed by owner before'
          : 'Matched this exact text before',
        needs_review: false,
      })
    }
  }

  // 2. Barcode lookup
  for (const l of lines) {
    if (outcomes.has(l.id) || !l.barcode) continue
    const p = products.find((x) => x.barcode === l.barcode)
    if (p) {
      outcomes.set(l.id, {
        id: l.id,
        product_id: p.id,
        new_product: null,
        method: 'barcode',
        confidence: 1,
        reason: `Barcode ${l.barcode}`,
        needs_review: false,
      })
    }
  }

  // 3 + 4. Shortlist candidates and ask Claude about everything still unmatched, in one call.
  const pending = lines.filter((l) => !outcomes.has(l.id))
  if (pending.length > 0) {
    const shortlists = new Map(
      pending.map((l) => [l.id, shortlist(l.description, candidates)]),
    )
    // Short, stable ids in the prompt (not database uuids) so identical inputs give an
    // identical request, which keeps the demo cache valid after a database reset.
    const keyOf = new Map<string, string>()
    const productOfKey = new Map<string, string>()
    for (const c of [...shortlists.values()].flat()) {
      if (keyOf.has(c.product_id)) continue
      const k = `p${keyOf.size + 1}`
      keyOf.set(c.product_id, k)
      productOfKey.set(k, c.product_id)
    }
    const payload = pending.map((l, i) => ({
      line_id: `L${i + 1}`,
      description: l.description,
      supplier: l.supplier_name,
      candidates: shortlists
        .get(l.id)!
        .map((c) => ({ product_id: keyOf.get(c.product_id)!, name: c.name })),
    }))
    const res = await askJSON({
      name: 'match',
      system: P2_PRODUCT_MATCHING,
      content: JSON.stringify({ lines: payload }),
      schema: MatchResponse,
      effort: 'medium',
    })
    const byLine = new Map(res.results.map((r) => [r.line_id, r]))

    // 5. Apply thresholds
    for (const [i, l] of pending.entries()) {
      const raw = byLine.get(`L${i + 1}`)
      const r = raw && {
        ...raw,
        product_id: raw.product_id
          ? (productOfKey.get(raw.product_id) ?? raw.product_id)
          : null,
      }
      const allowed = new Set(shortlists.get(l.id)!.map((c) => c.product_id))
      outcomes.set(
        l.id,
        await applyThresholds(l, r, allowed, products, remember),
      )
    }
  }

  if (!remember) return lines.map((l) => outcomes.get(l.id)!)

  // 6. Remember it, and attach barcodes we learned.
  const toRemember = lines.filter((l) => {
    const o = outcomes.get(l.id)!
    return o.method !== 'alias'
  })
  if (toRemember.length > 0) {
    const seen = new Set<string>()
    const rows = toRemember
      .map((l) => ({
        supplier_id: l.supplier_id,
        raw_text: l.description,
        product_id: outcomes.get(l.id)!.product_id!,
      }))
      .filter((r) => {
        const k = `${r.supplier_id}|${r.raw_text}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
    must(
      await db()
        .from('product_aliases')
        .upsert(rows, { onConflict: 'supplier_id,raw_text' }),
      'save aliases',
    )
  }
  for (const l of lines) {
    if (!l.barcode) continue
    const p = products.find((x) => x.id === outcomes.get(l.id)!.product_id)
    if (p && !p.barcode && !products.some((x) => x.barcode === l.barcode)) {
      await db().from('products').update({ barcode: l.barcode }).eq('id', p.id)
      p.barcode = l.barcode
    }
  }

  return lines.map((l) => outcomes.get(l.id)!)
}

async function applyThresholds(
  l: MatchLine,
  r: MatchResult | undefined,
  allowed: Set<string>,
  products: Array<ProductRow>,
  remember: boolean,
): Promise<MatchSuggestion> {
  if (!r) {
    const p = await resolveProduct(
      products,
      fallbackNewProduct(l.description, null),
      remember,
    )
    return {
      id: l.id,
      product_id: p.id,
      new_product: p.new_product,
      method: 'new_product',
      confidence: 0,
      reason: 'No answer from matcher',
      needs_review: true,
    }
  }
  if (r.product_id && allowed.has(r.product_id) && r.confidence >= REVIEW) {
    return {
      id: l.id,
      product_id: r.product_id,
      new_product: null,
      method: 'ai',
      confidence: r.confidence,
      reason: r.reason,
      needs_review: r.confidence < ACCEPT,
    }
  }
  // Below 0.60, an unknown id, or a proposed new product: create (or reuse) a product.
  const template =
    r.new_product ??
    fallbackNewProduct(
      l.description,
      products.find((p) => p.id === r.product_id) ?? null,
    )
  const p = await resolveProduct(products, template, remember)
  const lowConfidence = r.product_id != null || r.confidence < REVIEW
  return {
    id: l.id,
    product_id: p.id,
    new_product: p.new_product,
    method: 'new_product',
    confidence: r.confidence,
    reason: r.product_id
      ? `Unsure match (${r.reason}); kept separate`
      : r.reason,
    needs_review: lowConfidence,
  }
}

function fallbackNewProduct(
  description: string,
  like: ProductRow | null,
): NewProduct {
  const name = description
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
  return {
    canonical_name: name,
    brand: null,
    category: like?.category ?? 'other',
    base_unit: like?.base_unit ?? 'each',
  }
}

/**
 * Price per base unit for an observation of a product, or null with a reason.
 * A line whose unit family differs from the product's (e.g. 'each' vs 'ml') is never compared.
 */
export function observationPpu(
  obs: {
    pack_price: number
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
  },
  productBaseUnit: BaseUnit | null,
): { ppu: number | null; reason: string | null } {
  if (!isRawUnit(obs.pack_unit))
    return { ppu: null, reason: 'Pack size unknown' }
  const r = pricePerBaseUnit(obs.pack_price, {
    pack_size: obs.pack_size,
    pack_unit: obs.pack_unit,
    units_per_case: obs.units_per_case,
  })
  if (!r) return { ppu: null, reason: 'Pack size unknown' }
  if (productBaseUnit && toBase(1, obs.pack_unit).unit !== productBaseUnit) {
    return {
      ppu: null,
      reason: `Unit mismatch: line is in ${r.unit}, product in ${productBaseUnit}`,
    }
  }
  return { ppu: r.price, reason: null }
}

/** Writes match outcomes onto price_observations, recomputing unit prices against the product. */
export async function applyOutcomes(
  outcomes: Array<MatchOutcome>,
): Promise<void> {
  if (outcomes.length === 0) return
  const ids = outcomes.map((o) => o.id)
  const obsRows = must(
    await db()
      .from('price_observations')
      .select(
        'id, pack_price, pack_size, pack_unit, units_per_case, review_reasons, needs_review',
      )
      .in('id', ids),
    'load observations',
  ) as Array<{
    id: string
    pack_price: number
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
    review_reasons: Array<string>
    needs_review: boolean
  }>
  const productIds = [...new Set(outcomes.map((o) => o.product_id))]
  const prods = must(
    await db().from('products').select('id, base_unit').in('id', productIds),
    'load product units',
  ) as Array<{ id: string; base_unit: BaseUnit }>
  const unitOf = new Map(prods.map((p) => [p.id, p.base_unit]))

  await Promise.all(
    outcomes.map(async (o) => {
      const row = obsRows.find((r) => r.id === o.id)
      if (!row) return
      const { ppu, reason } = observationPpu(
        row,
        unitOf.get(o.product_id) ?? null,
      )
      const reasons = row.review_reasons.filter(
        (x) =>
          !x.startsWith('Match:') &&
          !x.startsWith('Unit mismatch') &&
          x !== 'Pack size unknown',
      )
      if (o.needs_review)
        reasons.push(`Match: ${o.reason} (${Math.round(o.confidence * 100)}%)`)
      if (reason) reasons.push(reason)
      must(
        await db()
          .from('price_observations')
          .update({
            product_id: o.product_id,
            match_confidence: o.confidence,
            match_reason: `${o.method}: ${o.reason}`,
            price_per_base_unit: ppu,
            review_reasons: reasons,
            needs_review: reasons.length > 0,
          })
          .eq('id', o.id),
        'save match',
      )
    }),
  )
}
