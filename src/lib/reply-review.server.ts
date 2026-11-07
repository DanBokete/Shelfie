// Supplier replies wait for the owner. Reading a reply stores what it proposes (reply_lines,
// reply_invoices) and what it answered (request_outcomes); nothing reaches price_observations
// until the owner applies a line. Pure rules live in lib/reply-review.ts.
import { askJSON } from './claude.server'
import { extractInvoice, storeInvoiceFile } from './invoices.server'
import {
  findOrCreateProduct,
  loadCatalogue,
  suggestMatches,
} from './match.server'
import type { MatchSuggestion } from './match.server'
import { toContentBlock } from './media.server'
import { P12_REPLY_READ } from './prompts'
import { invoicePeriod, observationsByProduct } from './queries.server'
import { quoteRows } from './quote-lines'
import {
  PACK_UNKNOWN,
  answerLines,
  compareLine,
  currentOutcomes,
  itemKey,
  outcomeLabel,
  packOf,
  replyStatus,
  requestItems,
} from './reply-review'
import type {
  LineComparison,
  LineStatus,
  OutcomeRow,
  ReplyOutcome,
  ReplyStatus,
  RequestItem,
  StoredOutcome,
} from './reply-review'
import { productInsight } from './savings'
import type { Observation, ProductInsight } from './savings'
import { ReplyRead } from './schemas'
import { latestStockList, withStockVolume } from './stock-volume.server'
import {
  INVOICE_BUCKET,
  db,
  downloadFile,
  must,
  mustOne,
} from './supabase.server'
import type { BaseUnit, RawUnit } from './units'

export const BODY = 'email body'
export const BY_HAND = 'added by hand'

interface StoredAttachment {
  name: string
  type: string
  size: number
  path: string
}

export interface ReplyForReading {
  id: string
  from_email: string
  from_name: string | null
  subject: string | null
  body_text: string | null
  received_at: string
  supplier_id: string | null
  draft_id: string | null
  attachments: Array<StoredAttachment>
}

// --- The request a reply answers --------------------------------------------------------

interface DraftRow {
  id: string
  kind: 'match' | 'quote'
  supplier_id: string | null
  subject: string | null
  items: unknown
  price_observation_id: string | null
  follow_up_of: string | null
}

export interface RequestContext {
  id: string
  kind: 'match' | 'quote'
  subject: string | null
  items: Array<RequestItem>
}

async function loadDraft(id: string | null): Promise<DraftRow | null> {
  if (!id) return null
  const row = must(
    await db()
      .from('email_drafts')
      .select(
        'id, kind, supplier_id, subject, items, price_observation_id, follow_up_of',
      )
      .eq('id', id)
      .maybeSingle<DraftRow>(),
    'load request',
  )
  // A reply to a reminder answers the request the reminder follows up.
  if (row?.follow_up_of) return loadDraft(row.follow_up_of)
  return row
}

/**
 * The request a reply answers, with each item's product, pack and the price asked. An "Ask to
 * match" item without a stored pack is for the pack on the supplier's latest invoice line; an
 * "Ask for a quote" item is the web price the request was about.
 */
export async function requestContext(
  draftId: string | null,
): Promise<RequestContext | null> {
  const draft = await loadDraft(draftId)
  if (!draft) return null
  let items = requestItems(draft.kind, draft.items)
  if (draft.kind === 'quote' && draft.price_observation_id) {
    const offer = must(
      await db()
        .from('price_observations')
        .select('product_id, pack_price, pack_size, pack_unit, units_per_case')
        .eq('id', draft.price_observation_id)
        .maybeSingle<{
          product_id: string | null
          pack_price: number
          pack_size: number | null
          pack_unit: string | null
          units_per_case: number | null
        }>(),
      'load offer',
    )
    if (offer)
      items = items.map((i) => ({
        ...i,
        product_id: i.product_id ?? offer.product_id,
        pack: i.pack ?? packOf(offer),
        asked_price: i.asked_price ?? Number(offer.pack_price),
      }))
  }
  items = await Promise.all(
    items.map(async (i) => {
      if (i.pack || !i.product_id || !draft.supplier_id) return i
      const last = must(
        await db()
          .from('price_observations')
          .select('pack_size, pack_unit, units_per_case')
          .eq('product_id', i.product_id)
          .eq('supplier_id', draft.supplier_id)
          .eq('source', 'invoice')
          .order('observed_on', { ascending: false })
          .limit(1),
        'load pack',
      ) as Array<{
        pack_size: number | null
        pack_unit: string | null
        units_per_case: number | null
      }>
      return { ...i, pack: last[0] ? packOf(last[0]) : null }
    }),
  )
  return { id: draft.id, kind: draft.kind, subject: draft.subject, items }
}

function requestText(req: RequestContext | null, subject: string | null) {
  if (!req)
    return `The request is not known. The reply's subject is: ${subject ?? '(none)'}\nThe owner's request may be quoted below the reply: use it only to tell which product and pack the reply is about. Return answers with request_item null.`
  const what =
    req.kind === 'match'
      ? 'The owner asked their supplier to match these prices ("Ask to match"):'
      : 'The owner asked this seller for a quote at the price they saw online ("Ask for a quote"):'
  const lines = req.items.map((i) => {
    const pack = i.pack
      ? `${i.pack.units_per_case > 1 ? `${i.pack.units_per_case} x ` : ''}${i.pack.pack_size ?? ''}${i.pack.pack_unit}`
      : 'pack not known'
    const price =
      i.asked_price != null
        ? `€${i.asked_price.toFixed(2)} ex VAT per pack`
        : 'no price named'
    return `${itemKey(i.index)}: ${i.product_name}, ${pack}, ${req.kind === 'match' ? 'asked' : 'seen'} ${price}`
  })
  return [`Request subject: ${req.subject ?? '(none)'}`, what, ...lines].join(
    '\n',
  )
}

// --- Reading a reply into review --------------------------------------------------------

export interface ReadSummary {
  lines: number
  better: number
  invoices: number
  outcome: ReplyOutcome | null
  errors: Array<string>
  nothingRead: boolean
}

interface LineInsert {
  source: string
  origin: 'read' | 'accepted' | 'manual'
  request_item: number | null
  line_index: number
  raw_description: string
  pack_price: number
  pack_size: number | null
  pack_unit: RawUnit | null
  units_per_case: number
  observed_on: string
  extraction_confidence: number | null
  product_id: string | null
  review_reasons: Array<string>
}

/** The reasons stored on a line: pack and unit problems are worked out when it is shown. */
function storedReasons(reasons: Array<string>): Array<string> {
  return reasons.filter((r) => r !== PACK_UNKNOWN)
}

/**
 * Reads a reply (or one part of it, for "Read again") into review. Proposed lines and the
 * reader's outcomes from the parts read are replaced; what the owner applied, rejected or set
 * by hand stays.
 */
export async function readIntoReview(
  row: ReplyForReading,
  supplierId: string,
  only?: string,
): Promise<ReadSummary> {
  const errors: Array<string> = []
  const body = (row.body_text ?? '').trim()
  const request = await requestContext(row.draft_id)
  const readBody = !only || only === BODY
  const attachments = only
    ? row.attachments.filter((a) => a.name === only)
    : row.attachments
  if (only && only !== BODY && attachments.length === 0)
    throw new Error(`This reply has no attachment called ${only}.`)

  const content: Array<
    Awaited<ReturnType<typeof toContentBlock>> | { type: 'text'; text: string }
  > = [
    {
      type: 'text',
      text: `${requestText(request, row.subject)}\n\nReply from: ${row.from_name ?? ''} <${row.from_email}>\nSubject: ${row.subject ?? ''}\n\nEmail body:\n${body || '(empty)'}`,
    },
  ]
  const readable: Array<StoredAttachment & { bytes: Uint8Array }> = []
  for (const a of attachments) {
    try {
      const bytes = new Uint8Array(
        await (await downloadFile(INVOICE_BUCKET, a.path)).arrayBuffer(),
      )
      content.push(
        { type: 'text', text: `Attachment file name: ${a.name}` },
        await toContentBlock(bytes, a.type),
      )
      readable.push({ ...a, bytes })
    } catch (err) {
      errors.push(
        `Could not open ${a.name}: ${err instanceof Error ? err.message : 'unreadable'}.`,
      )
    }
  }

  const read = await askJSON({
    name: 'reply',
    system: P12_REPLY_READ,
    content,
    schema: ReplyRead,
    effort: 'medium',
  })

  const receivedOn = row.received_at.slice(0, 10)
  const answer = answerLines(read, request?.items ?? [])
  const inserts: Array<LineInsert> = []
  if (readBody)
    for (const l of answer.lines)
      inserts.push({
        ...l,
        source: BODY,
        observed_on: receivedOn,
        extraction_confidence: null,
        review_reasons: storedReasons(l.review_reasons),
      })

  const invoiceFiles: Array<StoredAttachment> = []
  for (const doc of read.documents) {
    const fromBody = doc.source.toLowerCase() === BODY
    if (
      fromBody
        ? !readBody
        : !attachments.some((a) => sameName(a.name, doc.source))
    )
      continue
    if (doc.kind === 'invoice') {
      const file =
        readable.find((a) => sameName(a.name, doc.source)) ??
        (readable.length === 1 ? readable[0] : undefined)
      if (file) invoiceFiles.push(file)
      else
        errors.push(
          'An invoice was mentioned but no readable file came with it.',
        )
    } else if (doc.kind === 'quote' || doc.kind === 'price_list') {
      const source = fromBody
        ? BODY
        : (attachments.find((a) => sameName(a.name, doc.source))?.name ??
          doc.source)
      for (const r of quoteRows(doc, receivedOn)) {
        // The body's answer is already a line: a body "quote" repeating it is the same offer.
        if (
          fromBody &&
          answer.lines.some(
            (l) => Math.abs(l.pack_price - r.pack_price) < 0.005,
          )
        )
          continue
        inserts.push({
          source,
          origin: 'read',
          request_item: null,
          line_index: inserts.length,
          raw_description: r.raw_description,
          pack_price: r.pack_price,
          pack_size: r.pack_size,
          pack_unit: isRaw(r.pack_unit),
          units_per_case: r.units_per_case,
          observed_on: r.observed_on,
          extraction_confidence: r.extraction_confidence,
          product_id: null,
          review_reasons: storedReasons(r.review_reasons),
        })
      }
    }
  }

  const sources = [
    ...(readBody ? [BODY] : []),
    ...attachments.map((a) => a.name),
  ]
  await replaceProposed(row.id, sources)
  // A line the owner already decided on is not proposed again.
  const decided = must(
    await db()
      .from('reply_lines')
      .select('source, raw_description, pack_price')
      .eq('inbound_email_id', row.id)
      .neq('status', 'proposed'),
    'load decided lines',
  ) as Array<{ source: string; raw_description: string; pack_price: number }>
  const fresh = inserts.filter(
    (l) =>
      !decided.some(
        (d) =>
          d.source === l.source &&
          d.raw_description === l.raw_description &&
          Math.abs(Number(d.pack_price) - l.pack_price) < 0.005,
      ),
  )

  const suggestions = await suggestFor(fresh, supplierId)
  if (fresh.length > 0)
    must(
      await db()
        .from('reply_lines')
        .insert(
          fresh.map((l, i) => {
            const s = suggestions.get(i)
            return {
              inbound_email_id: row.id,
              draft_id: request?.id ?? row.draft_id,
              ...l,
              line_index: i,
              product_id: l.product_id ?? s?.product_id ?? null,
              new_product_name: l.product_id
                ? null
                : (s?.new_product?.canonical_name ?? null),
              new_product_unit: l.product_id
                ? null
                : (s?.new_product?.base_unit ?? null),
              match_method: l.product_id ? 'request' : (s?.method ?? null),
              match_confidence: l.product_id ? 1 : (s?.confidence ?? null),
              match_reason: l.product_id
                ? 'The product the request was about'
                : (s?.reason ?? null),
              review_reasons: [
                ...l.review_reasons,
                ...(s?.needs_review
                  ? [`Match: ${s.reason} (${Math.round(s.confidence * 100)}%)`]
                  : []),
              ],
            }
          }),
        ),
      'store proposed lines',
    )

  for (const f of invoiceFiles)
    must(
      await db().from('reply_invoices').upsert(
        {
          inbound_email_id: row.id,
          name: f.name,
          type: f.type,
          path: f.path,
        },
        { onConflict: 'inbound_email_id,path', ignoreDuplicates: true },
      ),
      'hold invoice',
    )

  if (readBody)
    await saveOutcomes(row.id, request?.id ?? row.draft_id, answer.outcomes)

  const lines = fresh.length
  const better = (await reviewLines(row.id)).filter(
    (l) => l.status === 'proposed' && l.comparison.better,
  ).length
  return {
    lines,
    better,
    invoices: invoiceFiles.length,
    outcome: readBody ? read.overall : null,
    errors,
    nothingRead: errors.length > 0 && lines === 0 && invoiceFiles.length === 0,
  }
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isRaw(u: string | null): RawUnit | null {
  return u === 'ml' ||
    u === 'cl' ||
    u === 'l' ||
    u === 'g' ||
    u === 'kg' ||
    u === 'each'
    ? u
    : null
}

async function replaceProposed(replyId: string, sources: Array<string>) {
  if (sources.length === 0) return
  must(
    await db()
      .from('reply_lines')
      .delete()
      .eq('inbound_email_id', replyId)
      .eq('status', 'proposed')
      .neq('origin', 'manual')
      .in('source', sources),
    'clear proposed lines',
  )
}

/** Suggested products for lines that don't know theirs, without remembering anything. */
async function suggestFor(
  lines: Array<LineInsert>,
  supplierId: string,
): Promise<Map<number, MatchSuggestion>> {
  const supplier = mustOne(
    await db()
      .from('suppliers')
      .select('name')
      .eq('id', supplierId)
      .single<{ name: string }>(),
    'load supplier',
  )
  const todo = lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.product_id)
  const out = await suggestMatches(
    todo.map(({ l, i }) => ({
      id: String(i),
      description: l.raw_description,
      supplier_id: supplierId,
      supplier_name: supplier.name,
      barcode: null,
    })),
  )
  return new Map(out.map((o) => [Number(o.id), o]))
}

async function saveOutcomes(
  replyId: string,
  draftId: string | null,
  outcomes: Array<OutcomeRow>,
) {
  const owner = must(
    await db()
      .from('request_outcomes')
      .select('request_item')
      .eq('inbound_email_id', replyId)
      .eq('set_by', 'owner'),
    'load owner outcomes',
  ) as Array<{ request_item: number | null }>
  must(
    await db()
      .from('request_outcomes')
      .delete()
      .eq('inbound_email_id', replyId)
      .eq('set_by', 'reader'),
    'clear outcomes',
  )
  const rows = outcomes
    .filter((o) => !owner.some((x) => x.request_item === o.request_item))
    .map((o) => ({
      ...o,
      inbound_email_id: replyId,
      draft_id: draftId,
      set_by: 'reader',
      updated_at: new Date().toISOString(),
    }))
  if (rows.length > 0)
    must(await db().from('request_outcomes').insert(rows), 'save outcomes')
}

// --- Showing ------------------------------------------------------------------------------

interface LineRow {
  id: string
  inbound_email_id: string
  request_item: number | null
  source: string
  origin: 'read' | 'accepted' | 'manual'
  line_index: number
  raw_description: string
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number
  observed_on: string
  product_id: string | null
  new_product_name: string | null
  new_product_unit: BaseUnit | null
  match_method: string | null
  match_confidence: number | null
  match_reason: string | null
  review_reasons: Array<string>
  status: LineStatus
  decided_at: string | null
  applied_observation_id: string | null
  created_at: string
  products: { canonical_name: string; base_unit: BaseUnit } | null
}

const LINE_COLS =
  'id, inbound_email_id, request_item, source, origin, line_index, raw_description, pack_price, pack_size, pack_unit, units_per_case, observed_on, product_id, new_product_name, new_product_unit, match_method, match_confidence, match_reason, review_reasons, status, decided_at, applied_observation_id, created_at, products!reply_lines_product_id_fkey(canonical_name, base_unit)'

export interface ReviewLine extends Omit<LineRow, 'products'> {
  product_name: string | null
  base_unit: BaseUnit | null
  comparison: LineComparison
  /** Applying it makes it a price the supplier agreed to. */
  agreed: boolean
}

/**
 * Insights per product without the prices this reply added, so a line still compares with
 * what the owner paid before it was applied.
 */
async function insightsFor(
  productIds: Array<string>,
  excludeObservations: Set<string>,
): Promise<Map<string, ProductInsight>> {
  if (productIds.length === 0) return new Map()
  const [obs, period, stock, products] = await Promise.all([
    observationsByProduct(productIds),
    invoicePeriod(),
    latestStockList(),
    db().from('products').select('id, base_unit').in('id', productIds),
  ])
  const baseUnit = new Map(
    (
      must(products, 'load product units') as Array<{
        id: string
        base_unit: BaseUnit
      }>
    ).map((p) => [p.id, p.base_unit]),
  )
  return new Map(
    productIds.map((id) => {
      const mine = (obs.get(id) ?? []).filter(
        (o: Observation) => !o.id || !excludeObservations.has(o.id),
      )
      const unit = baseUnit.get(id)
      // Yearly volume from the latest stock list when the product is on it.
      const opts = unit
        ? withStockVolume({ period }, stock, { id, base_unit: unit }, mine)
        : { period }
      return [id, productInsight(mine, opts)]
    }),
  )
}

async function loadOutcomeRows(replyId: string) {
  return must(
    await db()
      .from('request_outcomes')
      .select(
        'id, request_item, product_id, outcome, pack_price, pack_size, pack_unit, units_per_case, said, question, set_by',
      )
      .eq('inbound_email_id', replyId)
      .order('request_item', { ascending: true, nullsFirst: true }),
    'load outcomes',
  ) as Array<
    OutcomeRow & {
      id: string
      set_by: 'reader' | 'owner'
      pack_unit: RawUnit | null
    }
  >
}

/** Whether applying a line makes it an agreed price: the supplier said yes or countered. */
function isAgreed(
  line: Pick<LineRow, 'origin' | 'source' | 'request_item'>,
  outcomes: Array<{ request_item: number | null; outcome: ReplyOutcome }>,
): boolean {
  if (line.origin === 'accepted') return true
  if (line.source !== BODY || line.origin !== 'read') return false
  const o =
    outcomes.find((x) => x.request_item === line.request_item) ??
    outcomes.find((x) => x.request_item === null)
  return o?.outcome === 'accepted' || o?.outcome === 'counter_offer'
}

export async function reviewLines(replyId: string): Promise<Array<ReviewLine>> {
  const [rows, outcomes] = await Promise.all([
    must(
      await db()
        .from('reply_lines')
        .select(LINE_COLS)
        .eq('inbound_email_id', replyId)
        .order('created_at')
        .order('line_index'),
      'load reply lines',
    ) as unknown as Array<LineRow>,
    loadOutcomeRows(replyId),
  ])
  const own = new Set(
    rows.map((r) => r.applied_observation_id).filter((x): x is string => !!x),
  )
  const insights = await insightsFor(
    [...new Set(rows.map((r) => r.product_id).filter((x): x is string => !!x))],
    own,
  )
  return rows.map(({ products, ...r }) => {
    const unit = products?.base_unit ?? r.new_product_unit ?? null
    const line = {
      ...r,
      pack_price: Number(r.pack_price),
      pack_size: r.pack_size == null ? null : Number(r.pack_size),
    }
    return {
      ...line,
      product_name: products?.canonical_name ?? null,
      base_unit: unit,
      comparison: compareLine(
        line,
        unit,
        r.product_id ? (insights.get(r.product_id) ?? null) : null,
      ),
      agreed: isAgreed(r, outcomes),
    }
  })
}

export interface HeldInvoice {
  id: string
  name: string
  type: string
  status: LineStatus
  invoice_id: string | null
  invoice_status: string | null
}

async function heldInvoices(replyIds: Array<string>) {
  if (replyIds.length === 0) return []
  return (
    must(
      await db()
        .from('reply_invoices')
        .select(
          'id, inbound_email_id, name, type, status, invoice_id, invoices(status)',
        )
        .in('inbound_email_id', replyIds)
        .order('created_at'),
      'load held invoices',
    ) as unknown as Array<
      Omit<HeldInvoice, 'invoice_status'> & {
        inbound_email_id: string
        invoices: { status: string } | null
      }
    >
  ).map(({ invoices, ...i }) => ({
    ...i,
    invoice_status: invoices?.status ?? null,
  }))
}

/** Everything the review page shows for one reply. */
export async function replyReview(id: string) {
  const reply = must(
    await db()
      .from('inbound_emails')
      .select(
        'id, from_email, from_name, subject, body_text, received_at, status, error, supplier_id, draft_id, attachments, suppliers(name)',
      )
      .eq('id', id)
      .maybeSingle<
        Omit<ReplyForReading, 'attachments'> & {
          status: 'received' | 'processed' | 'failed' | 'unmatched'
          error: string | null
          attachments: Array<StoredAttachment>
          suppliers: { name: string } | null
        }
      >(),
    'load reply',
  )
  if (!reply) return null
  const [request, lines, outcomes, invoices] = await Promise.all([
    requestContext(reply.draft_id),
    reviewLines(id),
    loadOutcomeRows(id),
    heldInvoices([id]),
  ])
  const productNames = new Map<string, string>()
  const ids = [
    ...new Set(
      (request?.items ?? [])
        .map((i) => i.product_id)
        .filter((x): x is string => !!x),
    ),
  ]
  if (ids.length > 0)
    for (const p of must(
      await db().from('products').select('id, canonical_name').in('id', ids),
      'load request products',
    ) as Array<{ id: string; canonical_name: string }>)
      productNames.set(p.id, p.canonical_name)
  const { suppliers, attachments, ...rest } = reply
  return {
    reply: {
      ...rest,
      supplier_name: suppliers?.name ?? null,
      attachments: attachments.map((a, i) => ({
        index: i,
        name: a.name,
        type: a.type,
        size: a.size,
      })),
    },
    request,
    outcomes: outcomes.map((o) => {
      const item = request?.items.find((i) => i.index === o.request_item)
      return {
        ...o,
        pack_price: o.pack_price == null ? null : Number(o.pack_price),
        pack_size: o.pack_size == null ? null : Number(o.pack_size),
        product_name: item?.product_name ?? null,
        label: outcomeLabel({ ...o, asked_price: item?.asked_price ?? null }),
      }
    }),
    lines,
    invoices,
    status: replyStatus([
      ...lines,
      ...invoices.map((i) => ({ ...i, kind: 'invoice' as const })),
    ]),
  }
}

/** The status of each reply, for Replies and the Emails page. */
export async function replyStatuses(
  replyIds: Array<string>,
): Promise<Map<string, ReplyStatus>> {
  if (replyIds.length === 0) return new Map()
  const [lines, invoices] = await Promise.all([
    must(
      await db()
        .from('reply_lines')
        .select('inbound_email_id, status')
        .in('inbound_email_id', replyIds),
      'load line statuses',
    ) as Array<{ inbound_email_id: string; status: LineStatus }>,
    heldInvoices(replyIds),
  ])
  return new Map(
    replyIds.map((id) => [
      id,
      replyStatus([
        ...lines.filter((l) => l.inbound_email_id === id),
        ...invoices
          .filter((i) => i.inbound_email_id === id)
          .map((i) => ({ ...i, kind: 'invoice' as const })),
      ]),
    ]),
  )
}

/** The overall answer of each reply, as a label ("Accepted €2.91", "Declined"). */
export async function replyOutcomes(
  replyIds: Array<string>,
): Promise<Map<string, { outcome: ReplyOutcome; label: string }>> {
  if (replyIds.length === 0) return new Map()
  const rows = must(
    await db()
      .from('request_outcomes')
      .select(
        'inbound_email_id, draft_id, request_item, outcome, pack_price, pack_size, pack_unit, units_per_case',
      )
      .in('inbound_email_id', replyIds),
    'load reply outcomes',
  ) as unknown as Array<{
    inbound_email_id: string
    request_item: number | null
    outcome: ReplyOutcome
    pack_price: number | null
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
    draft_id: string | null
  }>
  const draftIds = [
    ...new Set(rows.map((r) => r.draft_id).filter((x): x is string => !!x)),
  ]
  const drafts =
    draftIds.length > 0
      ? (must(
          await db()
            .from('email_drafts')
            .select('id, kind, items')
            .in('id', draftIds),
          'load requests',
        ) as Array<{ id: string; kind: 'match' | 'quote'; items: unknown }>)
      : []
  const out = new Map<string, { outcome: ReplyOutcome; label: string }>()
  for (const id of replyIds) {
    const mine = rows.filter((r) => r.inbound_email_id === id)
    const items = mine.filter((r) => r.request_item !== null)
    // One requested product: its own answer says most ("Accepted €2.91").
    const pick =
      items.length === 1 ? items[0] : mine.find((r) => r.request_item === null)
    if (!pick) continue
    const d = drafts.find((x) => x.id === pick.draft_id)
    const item = d
      ? requestItems(d.kind, d.items).find((i) => i.index === pick.request_item)
      : undefined
    out.set(id, {
      outcome: pick.outcome,
      label: outcomeLabel({
        ...pick,
        asked_price: item?.asked_price ?? null,
        pack_price: pick.pack_price == null ? null : Number(pick.pack_price),
        pack_size: pick.pack_size == null ? null : Number(pick.pack_size),
      }),
    })
  }
  return out
}

/** Each request's current answer, per draft id, for the Emails page. */
export async function requestAnswers(draftIds: Array<string>) {
  if (draftIds.length === 0) return new Map<string, RequestAnswer>()
  const rows = must(
    await db()
      .from('request_outcomes')
      .select(
        'inbound_email_id, draft_id, request_item, product_id, outcome, pack_price, pack_size, pack_unit, units_per_case, said, question, inbound_emails(received_at)',
      )
      .in('draft_id', draftIds),
    'load request outcomes',
  ) as unknown as Array<
    Omit<StoredOutcome, 'received_at'> & {
      draft_id: string
      inbound_emails: { received_at: string } | null
    }
  >
  const drafts = must(
    await db()
      .from('email_drafts')
      .select('id, kind, items')
      .in('id', draftIds),
    'load request items',
  ) as Array<{ id: string; kind: 'match' | 'quote'; items: unknown }>
  const out = new Map<string, RequestAnswer>()
  for (const d of drafts) {
    const mine = rows
      .filter((r) => r.draft_id === d.id)
      .map(({ inbound_emails, ...r }) => ({
        ...r,
        pack_price: r.pack_price == null ? null : Number(r.pack_price),
        pack_size: r.pack_size == null ? null : Number(r.pack_size),
        received_at: inbound_emails?.received_at ?? '',
      }))
    const current = currentOutcomes(mine)
    if (current.length === 0) continue
    const items = requestItems(d.kind, d.items)
    const perItem = current.filter((c) => c.request_item !== null)
    const shown = perItem.length > 0 ? perItem : current
    out.set(d.id, {
      reply_id: current[0].inbound_email_id,
      answers: shown.map((c) => {
        const item = items.find((i) => i.index === c.request_item)
        return {
          product_name: item?.product_name ?? null,
          outcome: c.outcome,
          label: outcomeLabel({ ...c, asked_price: item?.asked_price ?? null }),
          question: c.question,
        }
      }),
    })
  }
  return out
}

export interface RequestAnswer {
  reply_id: string
  answers: Array<{
    product_name: string | null
    outcome: ReplyOutcome
    label: string
    question: string | null
  }>
}

// --- Owner actions ------------------------------------------------------------------------

async function loadLine(id: string) {
  return mustOne(
    await db()
      .from('reply_lines')
      .select(
        'id, inbound_email_id, request_item, source, origin, raw_description, pack_price, pack_size, pack_unit, units_per_case, observed_on, extraction_confidence, product_id, new_product_name, new_product_unit, status, applied_observation_id, created_product_id, created_alias',
      )
      .eq('id', id)
      .maybeSingle<{
        id: string
        inbound_email_id: string
        request_item: number | null
        source: string
        origin: 'read' | 'accepted' | 'manual'
        raw_description: string
        pack_price: number
        pack_size: number | null
        pack_unit: string | null
        units_per_case: number
        observed_on: string
        extraction_confidence: number | null
        product_id: string | null
        new_product_name: string | null
        new_product_unit: BaseUnit | null
        status: LineStatus
        applied_observation_id: string | null
        created_product_id: string | null
        created_alias: boolean
      }>(),
    'load line',
  )
}

export interface LineEdit {
  product_id?: string | null
  new_product?: { canonical_name: string; base_unit: BaseUnit } | null
  pack_price?: number
  pack_size?: number | null
  pack_unit?: RawUnit | null
  units_per_case?: number
}

/** Changes a proposed line: its product (or a new one to create), pack or price. */
export async function editReplyLine(id: string, edit: LineEdit) {
  const line = await loadLine(id)
  if (line.status !== 'proposed')
    throw new Error('Undo this line first, then change it.')
  const patch: Record<string, unknown> = {}
  if (edit.new_product) {
    patch.product_id = null
    patch.new_product_name = edit.new_product.canonical_name.trim()
    patch.new_product_unit = edit.new_product.base_unit
  } else if (edit.product_id !== undefined) {
    patch.product_id = edit.product_id
    patch.new_product_name = null
    patch.new_product_unit = null
  }
  if (edit.product_id !== undefined || edit.new_product) {
    patch.match_method = 'owner'
    patch.match_confidence = 1
    patch.match_reason = 'Chosen by you'
  }
  for (const k of [
    'pack_price',
    'pack_size',
    'pack_unit',
    'units_per_case',
  ] as const)
    if (edit[k] !== undefined) patch[k] = edit[k]
  // The owner looked at it: the reader's doubts no longer apply.
  patch.review_reasons = []
  must(await db().from('reply_lines').update(patch).eq('id', id), 'save line')
}

/**
 * Applies a proposed line: the price becomes a price_observations row ('agreed' when the
 * supplier said yes or countered, else 'quote'), the product is created if it is new, and the
 * match is remembered as confirmed. What it adds is recorded so undo can take it back.
 */
export async function applyReplyLine(id: string, edit?: LineEdit) {
  if (edit) await editReplyLine(id, edit)
  const line = await loadLine(id)
  if (line.status === 'applied') return
  const reply = mustOne(
    await db()
      .from('inbound_emails')
      .select('supplier_id')
      .eq('id', line.inbound_email_id)
      .maybeSingle<{ supplier_id: string | null }>(),
    'load reply',
  )
  if (!reply.supplier_id)
    throw new Error('Pick the supplier this reply is from first.')

  let productId = line.product_id
  let createdProduct: string | null = null
  if (!productId) {
    if (!line.new_product_name || !line.new_product_unit)
      throw new Error('Pick the product this price is for.')
    const { products } = await loadCatalogue()
    const before = new Set(products.map((p) => p.id))
    const p = await findOrCreateProduct(products, {
      canonical_name: line.new_product_name,
      brand: null,
      category: 'other',
      base_unit: line.new_product_unit,
    })
    productId = p.id
    if (!before.has(p.id)) createdProduct = p.id
  }
  const product = mustOne(
    await db()
      .from('products')
      .select('base_unit')
      .eq('id', productId)
      .maybeSingle<{ base_unit: BaseUnit }>(),
    'load product',
  )
  const c = compareLine(
    {
      pack_price: Number(line.pack_price),
      pack_size: line.pack_size == null ? null : Number(line.pack_size),
      pack_unit: line.pack_unit,
      units_per_case: line.units_per_case,
    },
    product.base_unit,
    null,
  )
  if (c.ppu == null) {
    if (createdProduct)
      await db().from('products').delete().eq('id', createdProduct)
    throw new Error(
      c.problem === PACK_UNKNOWN
        ? 'Set the pack size first, so the price can be compared.'
        : `${c.problem}. Change the pack or the product.`,
    )
  }

  const outcomes = await loadOutcomeRows(line.inbound_email_id)
  const source = isAgreed(line, outcomes) ? 'agreed' : 'quote'
  const obs = mustOne(
    await db()
      .from('price_observations')
      .insert({
        product_id: productId,
        supplier_id: reply.supplier_id,
        inbound_email_id: line.inbound_email_id,
        raw_description: line.raw_description,
        quantity: null,
        pack_price: line.pack_price,
        pack_size: line.pack_size,
        pack_unit: line.pack_unit,
        units_per_case: line.units_per_case,
        price_per_base_unit: c.ppu,
        observed_on: line.observed_on,
        source,
        extraction_confidence: line.extraction_confidence,
        match_confidence: 1,
        match_reason: 'owner: Applied from a supplier reply',
        needs_review: false,
        review_reasons: [],
      })
      .select('id')
      .single<{ id: string }>(),
    'save price',
  )

  // Remember the match for text the supplier wrote; a line made from the request needs none.
  let createdAlias = false
  if (line.origin === 'read') {
    const existing = must(
      await db()
        .from('product_aliases')
        .select('id, product_id')
        .eq('supplier_id', reply.supplier_id)
        .eq('raw_text', line.raw_description)
        .limit(1),
      'load alias',
    ) as Array<{ id: string; product_id: string }>
    if (existing.length === 0) {
      must(
        await db().from('product_aliases').insert({
          supplier_id: reply.supplier_id,
          raw_text: line.raw_description,
          product_id: productId,
          confirmed: true,
        }),
        'save alias',
      )
      createdAlias = true
    } else if (existing[0].product_id !== productId) {
      must(
        await db()
          .from('product_aliases')
          .update({ product_id: productId, confirmed: true })
          .eq('id', existing[0].id),
        'save alias',
      )
    }
  }

  must(
    await db()
      .from('reply_lines')
      .update({
        status: 'applied',
        decided_at: new Date().toISOString(),
        product_id: productId,
        new_product_name: createdProduct ? null : line.new_product_name,
        applied_observation_id: obs.id,
        created_product_id: createdProduct,
        created_alias: createdAlias,
      })
      .eq('id', id),
    'mark applied',
  )
}

export async function rejectReplyLine(id: string) {
  const line = await loadLine(id)
  if (line.status === 'applied')
    throw new Error('This price was applied. Undo it instead.')
  must(
    await db()
      .from('reply_lines')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('id', id),
    'reject line',
  )
}

/** Takes back an apply or a reject: the line is proposed again. */
export async function undoReplyLine(id: string) {
  const line = await loadLine(id)
  if (line.status === 'proposed') return
  const patch: Record<string, unknown> = {
    status: 'proposed',
    decided_at: null,
    applied_observation_id: null,
    created_product_id: null,
    created_alias: false,
  }
  if (line.status === 'applied') {
    if (line.applied_observation_id)
      must(
        await db()
          .from('price_observations')
          .delete()
          .eq('id', line.applied_observation_id),
        'remove price',
      )
    if (line.created_alias && line.product_id) {
      const reply = mustOne(
        await db()
          .from('inbound_emails')
          .select('supplier_id')
          .eq('id', line.inbound_email_id)
          .maybeSingle<{ supplier_id: string | null }>(),
        'load reply',
      )
      must(
        await db()
          .from('product_aliases')
          .delete()
          .eq('supplier_id', reply.supplier_id)
          .eq('raw_text', line.raw_description)
          .eq('product_id', line.product_id),
        'remove alias',
      )
    }
    if (line.created_product_id) {
      const p = line.created_product_id
      const used = await Promise.all(
        [
          db()
            .from('price_observations')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', p),
          db()
            .from('product_aliases')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', p),
          db()
            .from('stock_items')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', p),
          db()
            .from('price_checks')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', p),
          db()
            .from('reply_lines')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', p)
            .neq('id', id),
        ].map(async (q) => (await q).count ?? 1),
      )
      if (used.every((n) => n === 0)) {
        const made = mustOne(
          await db()
            .from('products')
            .select('canonical_name, base_unit')
            .eq('id', p)
            .maybeSingle<{ canonical_name: string; base_unit: BaseUnit }>(),
          'load product',
        )
        must(await db().from('products').delete().eq('id', p), 'remove product')
        Object.assign(patch, {
          product_id: null,
          new_product_name: made.canonical_name,
          new_product_unit: made.base_unit,
        })
      }
    }
  }
  must(await db().from('reply_lines').update(patch).eq('id', id), 'undo line')
}

/** Applies every proposed line that is cheaper than what the owner pays now. */
export async function applyBetterLines(replyId: string): Promise<number> {
  const better = (await reviewLines(replyId)).filter(
    (l) => l.status === 'proposed' && l.comparison.better,
  )
  for (const l of better) await applyReplyLine(l.id)
  return better.length
}

export async function rejectAllLines(replyId: string): Promise<void> {
  must(
    await db()
      .from('reply_lines')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('inbound_email_id', replyId)
      .eq('status', 'proposed'),
    'reject lines',
  )
  must(
    await db()
      .from('reply_invoices')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('inbound_email_id', replyId)
      .eq('status', 'proposed'),
    'reject invoices',
  )
}

/** A price the owner types in from the reply, proposed like any other. */
export async function addReplyLine(
  replyId: string,
  l: {
    raw_description: string
    product_id: string | null
    new_product: { canonical_name: string; base_unit: BaseUnit } | null
    pack_price: number
    pack_size: number | null
    pack_unit: RawUnit | null
    units_per_case: number
  },
): Promise<string> {
  const reply = mustOne(
    await db()
      .from('inbound_emails')
      .select('draft_id, received_at')
      .eq('id', replyId)
      .maybeSingle<{ draft_id: string | null; received_at: string }>(),
    'load reply',
  )
  return mustOne(
    await db()
      .from('reply_lines')
      .insert({
        inbound_email_id: replyId,
        draft_id: reply.draft_id,
        source: BY_HAND,
        origin: 'manual',
        line_index: 0,
        raw_description: l.raw_description.trim(),
        pack_price: l.pack_price,
        pack_size: l.pack_size,
        pack_unit: l.pack_unit,
        units_per_case: l.units_per_case,
        observed_on: reply.received_at.slice(0, 10),
        product_id: l.new_product ? null : l.product_id,
        new_product_name: l.new_product?.canonical_name.trim() ?? null,
        new_product_unit: l.new_product?.base_unit ?? null,
        match_method: 'owner',
        match_confidence: 1,
        match_reason: 'Chosen by you',
      })
      .select('id')
      .single<{ id: string }>(),
    'add line',
  ).id
}

/** The owner's own reading of what the supplier answered. */
export async function setOutcome(
  replyId: string,
  requestItem: number | null,
  outcome: ReplyOutcome,
) {
  const reply = mustOne(
    await db()
      .from('inbound_emails')
      .select('draft_id')
      .eq('id', replyId)
      .maybeSingle<{ draft_id: string | null }>(),
    'load reply',
  )
  const existing = (await loadOutcomeRows(replyId)).find(
    (o) => o.request_item === requestItem,
  )
  const request = await requestContext(reply.draft_id)
  const item = request?.items.find((i) => i.index === requestItem)
  const row = {
    inbound_email_id: replyId,
    draft_id: request?.id ?? reply.draft_id,
    request_item: requestItem,
    product_id: item?.product_id ?? null,
    outcome,
    set_by: 'owner',
    updated_at: new Date().toISOString(),
  }
  if (existing)
    must(
      await db().from('request_outcomes').update(row).eq('id', existing.id),
      'save outcome',
    )
  else must(await db().from('request_outcomes').insert(row), 'save outcome')
}

// --- Invoices attached to a reply ---------------------------------------------------------

async function loadHeld(id: string) {
  return mustOne(
    await db()
      .from('reply_invoices')
      .select('id, name, type, path, status, invoice_id')
      .eq('id', id)
      .maybeSingle<{
        id: string
        name: string
        type: string
        path: string
        status: LineStatus
        invoice_id: string | null
      }>(),
    'load invoice',
  )
}

/** "Add this invoice": the attachment goes through the invoice pipeline like an upload. */
export async function addHeldInvoice(
  id: string,
): Promise<{ invoice_id: string | null; error: string | null }> {
  const held = await loadHeld(id)
  if (held.status === 'applied')
    return { invoice_id: held.invoice_id, error: null }
  const bytes = new Uint8Array(
    await (await downloadFile(INVOICE_BUCKET, held.path)).arrayBuffer(),
  )
  const invoiceId = await storeInvoiceFile({
    name: held.name,
    type: held.type,
    bytes,
  })
  must(
    await db()
      .from('reply_invoices')
      .update({
        status: 'applied',
        decided_at: new Date().toISOString(),
        invoice_id: invoiceId,
      })
      .eq('id', id),
    'mark invoice added',
  )
  const r = await extractInvoice(invoiceId)
  return {
    invoice_id: invoiceId,
    error:
      r.status === 'failed'
        ? `Added, but it could not be read: ${r.error}`
        : r.status === 'duplicate'
          ? 'Added, but it is the same as an invoice you already have.'
          : null,
  }
}

export async function rejectHeldInvoice(id: string) {
  const held = await loadHeld(id)
  if (held.status === 'applied')
    throw new Error('This invoice was added. Undo it instead.')
  must(
    await db()
      .from('reply_invoices')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('id', id),
    'reject invoice',
  )
}

/** Takes an added invoice out again (its prices go with it), or un-rejects it. */
export async function undoHeldInvoice(id: string) {
  const held = await loadHeld(id)
  if (held.status === 'applied' && held.invoice_id) {
    const inv = must(
      await db()
        .from('invoices')
        .select('file_path')
        .eq('id', held.invoice_id)
        .maybeSingle<{ file_path: string }>(),
      'load invoice',
    )
    must(
      await db().from('invoices').delete().eq('id', held.invoice_id),
      'remove invoice',
    )
    if (inv) await db().storage.from(INVOICE_BUCKET).remove([inv.file_path])
  }
  must(
    await db()
      .from('reply_invoices')
      .update({ status: 'proposed', decided_at: null, invoice_id: null })
      .eq('id', id),
    'undo invoice',
  )
}

/** One attachment's bytes, for the preview on the review page. */
export async function replyAttachment(replyId: string, index: number) {
  const row = mustOne(
    await db()
      .from('inbound_emails')
      .select('attachments')
      .eq('id', replyId)
      .maybeSingle<{ attachments: Array<StoredAttachment> }>(),
    'load reply',
  )
  const a = row.attachments.at(index)
  if (!a || index < 0) throw new Error('No such attachment.')
  const blob = await downloadFile(INVOICE_BUCKET, a.path)
  return { name: a.name, type: a.type, blob }
}
