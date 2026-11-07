// Feature 4: stock list audit. The browser parses the file and sends batches; the server
// detects columns, matches rows, and computes savings with lib/savings.ts.
import { askJSON } from './claude.server'
import { loadCatalogue } from './match.server'
import { mediaTypeFor, toContentBlock } from './media.server'
import {
  P2B_STOCK_MATCHING,
  P4_COLUMN_DETECTION,
  P5_PHOTO_LIST,
} from './prompts'
import { invoicePeriod, observationsByProduct } from './queries.server'
import { ColumnDetection, PhotoRows, StockMatchResponse } from './schemas'
import { GROUP_ORDER, classify, productInsight } from './savings'
import type { ProductInsight, SupplierPrice } from './savings'
import type { AuditReport, ReportItem } from './audit-types'
import { db, must } from './supabase.server'
import { shortlist } from './tokens'
import { baseUnitsPerPack, describePack, isRawUnit } from './units'
import type { BaseUnit, PackSpec } from './units'

export const MAX_ROWS = 300
export const WEEKS_PER_MONTH = 4.33

export async function transcribePhoto(file: {
  name: string
  type: string
  bytes: Uint8Array
}) {
  const block = await toContentBlock(
    file.bytes,
    mediaTypeFor(file.name, file.type),
  )
  const res = await askJSON({
    name: 'photo-list',
    system: P5_PHOTO_LIST,
    content: [block, { type: 'text', text: 'Transcribe this list.' }],
    schema: PhotoRows,
    effort: 'low',
  })
  return res.rows
}

/** rows: the first 10 and last 5 rows of the sheet, each with its real row index. */
export async function detectColumns(
  rows: Array<{ index: number; cells: Array<string> }>,
) {
  const sample = rows.map((r) => [r.index, ...r.cells])
  return askJSON({
    name: 'columns',
    system: P4_COLUMN_DETECTION,
    content: JSON.stringify(sample),
    schema: ColumnDetection,
    effort: 'low',
  })
}

export interface StockRow {
  raw_name: string
  raw_quantity: string | null
  raw_unit: string | null
  raw_price: string | null
  raw_supplier: string | null
}

export async function createUpload(
  fileName: string,
  mapping: unknown,
): Promise<string> {
  const row = must(
    await db()
      .from('stock_uploads')
      .insert({
        file_name: fileName,
        column_mapping: mapping,
        status: 'matching',
      })
      .select('id')
      .single(),
    'create upload',
  ) as { id: string }
  return row.id
}

/** Parses '€3.55', '3,55', '12' etc. Null when there is no number. */
export function parseNumber(s: string | null): number | null {
  if (!s) return null
  const m = s.replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/)
  if (!m) return null
  return Number(m[0].replace(',', '.'))
}

/** Matches one batch (up to 25 rows) and stores it. */
export async function matchBatch(
  uploadId: string,
  period: 'week' | 'month' | 'unknown',
  rows: Array<StockRow>,
) {
  const { candidates, products } = await loadCatalogue()
  const shortlists = rows.map((r) => shortlist(r.raw_name, candidates))
  const keyOf = new Map<string, string>()
  const productOfKey = new Map<string, string>()
  for (const c of shortlists.flat()) {
    if (keyOf.has(c.product_id)) continue
    const k = `p${keyOf.size + 1}`
    keyOf.set(c.product_id, k)
    productOfKey.set(k, c.product_id)
  }
  const payload = rows.map((r, i) => ({
    line_id: `L${i + 1}`,
    description: r.raw_name,
    raw_quantity: r.raw_quantity ?? '',
    raw_unit: r.raw_unit ?? '',
    candidates: shortlists[i].map((c) => ({
      product_id: keyOf.get(c.product_id)!,
      name: c.name,
    })),
  }))
  const res = await askJSON({
    name: 'stock-match',
    system: P2B_STOCK_MATCHING,
    content: JSON.stringify({ lines: payload }),
    schema: StockMatchResponse,
    effort: 'low',
  })
  const byLine = new Map(res.results.map((r) => [r.line_id, r]))

  const items = rows.map((r, i) => {
    const m = byLine.get(`L${i + 1}`)
    const pid = m?.product_id ? productOfKey.get(m.product_id) : undefined
    const allowed =
      pid &&
      shortlists[i].some((c) => c.product_id === pid) &&
      (m?.confidence ?? 0) >= 0.6
    const product = allowed ? products.find((p) => p.id === pid) : undefined
    const packs = m?.packs_per_period ?? parseNumber(r.raw_quantity)
    const weekly =
      packs == null
        ? null
        : period === 'month'
          ? packs / WEEKS_PER_MONTH
          : packs
    const spec: PackSpec | null =
      m && isRawUnit(m.pack_unit)
        ? {
            pack_size: m.pack_size,
            pack_unit: m.pack_unit,
            units_per_case: m.units_per_case,
          }
        : null
    return {
      upload_id: uploadId,
      raw_name: r.raw_name,
      raw_quantity: r.raw_quantity,
      raw_unit: r.raw_unit,
      raw_price: r.raw_price,
      raw_supplier: r.raw_supplier,
      weekly_quantity: weekly,
      product_id: product?.id ?? null,
      match_confidence: m?.confidence ?? 0,
      pack_spec: spec,
    }
  })
  must(await db().from('stock_items').insert(items), 'store stock items')
  return {
    matched: items.filter((i) => i.product_id).length,
    total: items.length,
  }
}

/** Computes savings for every stored row, groups them and saves the total. */
export async function finalize(uploadId: string): Promise<AuditReport> {
  const upload = must(
    await db()
      .from('stock_uploads')
      .select('id, file_name')
      .eq('id', uploadId)
      .single(),
    'load upload',
  ) as { id: string; file_name: string | null }
  const rows = must(
    await db()
      .from('stock_items')
      .select(
        'id, raw_name, raw_price, raw_supplier, weekly_quantity, product_id, pack_spec, products(canonical_name, base_unit)',
      )
      .eq('upload_id', uploadId)
      .order('id'),
    'load stock items',
  ) as unknown as Array<{
    id: string
    raw_name: string
    raw_price: string | null
    raw_supplier: string | null
    weekly_quantity: number | null
    product_id: string | null
    pack_spec: PackSpec | null
    products: { canonical_name: string; base_unit: BaseUnit } | null
  }>
  const productIds = [
    ...new Set(rows.map((r) => r.product_id).filter((x): x is string => !!x)),
  ]
  const [obsMap, period, suppliers] = await Promise.all([
    observationsByProduct(productIds),
    invoicePeriod(),
    db().from('suppliers').select('id, name'),
  ])
  const supplierList = (suppliers.data ?? []) as Array<{
    id: string
    name: string
  }>

  const items: Array<ReportItem> = rows.map((r) => {
    const base: ReportItem = {
      id: r.id,
      raw_name: r.raw_name,
      product_id: r.product_id,
      product_name: r.products?.canonical_name ?? null,
      base_unit: r.products?.base_unit ?? null,
      group: 'no_data',
      annual_saving: null,
      weekly_quantity:
        r.weekly_quantity == null ? null : Number(r.weekly_quantity),
      current: null,
      cheapest: null,
      pct_cheaper: null,
      creep_pct: null,
      pack_label: null,
      your_pack_price: null,
      best_pack_price: null,
      used_stock_price: false,
      used_stock_quantity: false,
    }
    if (!r.product_id || !r.products) return base
    const obs = obsMap.get(r.product_id) ?? []
    const history = productInsight(obs, { period })

    // What one counted unit on the stock list holds; fall back to the current supplier's pack.
    let spec: PackSpec | null = r.pack_spec
    let unitsPerPack = spec ? baseUnitsPerPack(spec) : null
    if (unitsPerPack && unitsPerPack.unit !== r.products.base_unit)
      unitsPerPack = null
    if (
      !unitsPerPack &&
      history.current &&
      isRawUnit(history.current.pack_unit)
    ) {
      spec = {
        pack_size: history.current.pack_size,
        pack_unit: history.current.pack_unit,
        units_per_case: history.current.units_per_case,
      }
      unitsPerPack = baseUnitsPerPack(spec)
    }

    // Volume: stock list weekly quantity x 52 when present, else invoice history.
    const weekly = base.weekly_quantity
    const annualFromStock =
      weekly != null && unitsPerPack ? weekly * 52 * unitsPerPack.amount : null

    // Price: stock list price when present, else the latest invoice price.
    let current: SupplierPrice | null = history.current
    const stockPrice = parseNumber(r.raw_price)
    if (stockPrice != null && stockPrice > 0 && unitsPerPack && spec) {
      const named = r.raw_supplier
        ? matchSupplier(r.raw_supplier, supplierList)
        : null
      const sup =
        named ??
        (history.current
          ? {
              id: history.current.supplier_id,
              name: history.current.supplier_name,
            }
          : null)
      if (sup) {
        current = {
          supplier_id: sup.id,
          supplier_name: sup.name,
          ppu: stockPrice / unitsPerPack.amount,
          pack_price: stockPrice,
          pack_size: spec.pack_size,
          pack_unit: spec.pack_unit,
          units_per_case: spec.units_per_case,
          observed_on: period?.last ?? new Date().toISOString().slice(0, 10),
          source: 'invoice',
          raw_description: r.raw_name,
        }
        base.used_stock_price = true
      }
    }

    const insight: ProductInsight = productInsight(obs, {
      period,
      current,
      ...(annualFromStock != null
        ? { annual_base_units: annualFromStock }
        : {}),
    })
    base.used_stock_quantity = annualFromStock != null
    base.group = classify(insight)
    base.annual_saving = insight.annual_saving
    base.current = insight.current
    base.cheapest = insight.cheapest
    base.pct_cheaper = insight.pct_cheaper
    base.creep_pct = insight.creep?.pct ?? null
    if (insight.current && isRawUnit(insight.current.pack_unit)) {
      const cur = insight.current
      const units = baseUnitsPerPack({
        pack_size: cur.pack_size,
        pack_unit: cur.pack_unit as PackSpec['pack_unit'],
        units_per_case: cur.units_per_case,
      })
      base.pack_label = describePack({
        pack_size: cur.pack_size,
        pack_unit: cur.pack_unit as PackSpec['pack_unit'],
        units_per_case: cur.units_per_case,
      })
      base.your_pack_price = cur.pack_price
      base.best_pack_price =
        insight.cheapest && units ? insight.cheapest.ppu * units.amount : null
    }
    return base
  })

  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    items: items
      .filter((i) => i.group === g)
      .sort(
        (a, b) =>
          (b.annual_saving ?? -1) - (a.annual_saving ?? -1) ||
          (b.pct_cheaper ?? 0) - (a.pct_cheaper ?? 0),
      ),
  }))
  const withSaving = items.filter((i) => (i.annual_saving ?? 0) > 0)
  const report: AuditReport = {
    upload_id: uploadId,
    file_name: upload.file_name,
    total_annual_saving: items.reduce((s, i) => s + (i.annual_saving ?? 0), 0),
    items_with_saving: withSaving.length,
    suppliers_with_saving: new Set(
      withSaving.map((i) => i.current?.supplier_id),
    ).size,
    item_count: items.length,
    groups,
  }

  await Promise.all(
    items.map((i) =>
      db()
        .from('stock_items')
        .update({ finding_group: i.group, annual_saving: i.annual_saving })
        .eq('id', i.id),
    ),
  )
  must(
    await db()
      .from('stock_uploads')
      .update({
        status: 'done',
        total_annual_saving: report.total_annual_saving,
        report,
      })
      .eq('id', uploadId),
    'save report',
  )
  return report
}

function matchSupplier(raw: string, list: Array<{ id: string; name: string }>) {
  const w = raw
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim()
  if (!w) return null
  return (
    list.find((s) => {
      const n = s.name.toLowerCase()
      return (
        n.includes(w) || w.includes(n) || n.split(' ')[0] === w.split(' ')[0]
      )
    }) ?? null
  )
}
