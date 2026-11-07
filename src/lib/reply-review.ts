// Reviewing a supplier's reply. Pure: the reader's answer and the request in, the lines and
// outcomes to store out, plus how each line compares with what the owner pays. Every price
// comes from here or lib/savings.ts, never from the model: the model only says which answer
// it read and quotes the numbers the supplier wrote.
import { euro, pack as packLabel, perStandardShort, shortDate } from './format'
import type { BrokenPromise, ProductInsight } from './savings'
import type { ReplyAnswer, ReplyOutcome } from './schemas'
import { baseUnitsPerPack, isRawUnit, pricePerBaseUnit, toBase } from './units'
import type { BaseUnit, RawUnit } from './units'

export type { ReplyOutcome }
export type LineStatus = 'proposed' | 'applied' | 'rejected'

export interface Pack {
  pack_size: number | null
  pack_unit: RawUnit | null
  units_per_case: number
}

/** One product a request asked about, as the reader and the review page see it. */
export interface RequestItem {
  /** Position in email_drafts.items. */
  index: number
  product_id: string | null
  product_name: string
  /** The pack the request was about, when known. */
  pack: Pack | null
  /** The price the request asked for (match) or saw (quote), ex VAT, per that pack. */
  asked_price: number | null
  /** What the owner pays now for that pack (match requests). */
  your_price: number | null
}

/** "R1", "R2": how the reader refers to request items. */
export function itemKey(index: number): string {
  return `R${index + 1}`
}

function num(x: unknown): number | null {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN
  return Number.isFinite(n) ? n : null
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x.trim() ? x.trim() : null
}

/** Reads a pack stored as pack_size / pack_unit / units_per_case fields. */
export function packOf(x: {
  pack_size?: unknown
  pack_unit?: unknown
  units_per_case?: unknown
}): Pack | null {
  if (!isRawUnit(x.pack_unit)) return null
  const size = num(x.pack_size)
  const perCase = num(x.units_per_case)
  const pack: Pack = {
    pack_size: size != null && size > 0 ? size : null,
    pack_unit: x.pack_unit,
    units_per_case: perCase != null && perCase > 0 ? Math.round(perCase) : 1,
  }
  return baseUnitsPerPack(pack) ? pack : null
}

/**
 * The items of a request as stored in email_drafts.items. "Ask to match" items carry
 * product_id, product_name, your_price, best_price and (since review) asked_price, the target
 * the email asked for. Older ones have no asked_price: the email asked for best_price unless a
 * selling price moved the target, so best_price is the best guess. "Ask for a quote" items name
 * the product only: the caller fills in the rest from the web price the request was about.
 */
export function requestItems(
  kind: 'match' | 'quote',
  items: unknown,
): Array<RequestItem> {
  if (!Array.isArray(items)) return []
  return items.flatMap((raw: unknown, index): Array<RequestItem> => {
    if (!raw || typeof raw !== 'object') return []
    const it = raw as Record<string, unknown>
    const name = str(it.product_name) ?? str(it.product)
    if (!name) return []
    return [
      {
        index,
        product_id: str(it.product_id),
        product_name: name,
        pack: packOf(it),
        asked_price:
          kind === 'match' ? (num(it.asked_price) ?? num(it.best_price)) : null,
        your_price: num(it.your_price),
      },
    ]
  })
}

/** A price the reply proposes, before it is matched and stored as a reply_lines row. */
export interface ProposedLine {
  request_item: number | null
  line_index: number
  origin: 'accepted' | 'read'
  raw_description: string
  pack_price: number
  pack_size: number | null
  pack_unit: RawUnit | null
  units_per_case: number
  /** Known from the request; otherwise matched from raw_description. */
  product_id: string | null
  review_reasons: Array<string>
}

/** What the supplier answered about one requested product, or about the reply as a whole. */
export interface OutcomeRow {
  request_item: number | null
  product_id: string | null
  outcome: ReplyOutcome
  pack_price: number | null
  pack_size: number | null
  pack_unit: RawUnit | null
  units_per_case: number | null
  said: string | null
  question: string | null
}

export const PACK_UNKNOWN = 'Pack size unknown'
export const PACK_ASSUMED =
  'Pack: the reply did not say, so it is the pack you asked about'
export const VAT_UNKNOWN = 'VAT: the price includes VAT but no rate is shown'
export const PRICE_UNKNOWN =
  'Price: the request did not say what price it asked'

/** "Salted butter, 454g". A name that already says its pack is left as it is. */
export function describe(name: string, pack: Pack | null): string {
  if (!pack) return name
  const label = packLabel(pack)
  const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '')
  return squash(name).includes(squash(label)) ? name : `${name}, ${label}`
}

/** The offer in an answer: its price ex VAT and the pack it is for. */
function offerOf(
  a: ReplyAnswer,
  item: RequestItem | null,
): { price: number; pack: Pack | null; reasons: Array<string> } | null {
  if (a.offer_price == null || !(a.offer_price > 0)) return null
  const reasons: Array<string> = []
  if (a.price_includes_vat) reasons.push(VAT_UNKNOWN)
  let pack: Pack | null = null
  if (a.offer_pack === 'stated') {
    pack = packOf(a)
  } else if (a.offer_pack === 'requested') {
    pack = item?.pack ?? null
  } else if (item?.pack) {
    // "I can do 3.50" to a request about one pack: that pack, but the owner should check.
    pack = item.pack
    reasons.push(PACK_ASSUMED)
  }
  if (!pack) reasons.push(PACK_UNKNOWN)
  // Rounded to the cent: the supplier wrote a price, not a fraction of one.
  return { price: Math.round(a.offer_price * 100) / 100, pack, reasons }
}

/**
 * Turns the reader's answers into outcomes and proposed lines.
 * - accepted: a line at the price the request asked, for the requested product and pack;
 * - counter_offer: a line at the price the supplier named, for the pack they named (or the
 *   requested pack);
 * - declined, needs_info, unclear: an outcome only.
 * A requested product the reader said nothing about takes the reply's overall answer, except
 * a counter-offer (it needs a price): that is unclear.
 */
export function answerLines(
  read: {
    overall: ReplyOutcome
    overall_said: string
    answers: Array<ReplyAnswer>
  },
  items: Array<RequestItem>,
): { outcomes: Array<OutcomeRow>; lines: Array<ProposedLine> } {
  type Draft = Omit<ProposedLine, 'line_index'>
  const outcomes: Array<OutcomeRow> = [
    {
      request_item: null,
      product_id: null,
      outcome: read.overall,
      pack_price: null,
      pack_size: null,
      pack_unit: null,
      units_per_case: null,
      said: str(read.overall_said),
      question: null,
    },
  ]
  const lines: Array<Draft> = []
  const byKey = new Map(items.map((i) => [itemKey(i.index), i]))
  const answered = new Set<number>()

  const add = (a: ReplyAnswer, item: RequestItem | null) => {
    const outcome: OutcomeRow = {
      request_item: item?.index ?? null,
      product_id: item?.product_id ?? null,
      outcome: a.outcome,
      pack_price: null,
      pack_size: null,
      pack_unit: null,
      units_per_case: null,
      said: str(a.said),
      question: a.outcome === 'needs_info' ? str(a.question) : null,
    }
    const name = item?.product_name ?? str(a.product_hint)
    if (a.outcome === 'accepted' && item) {
      if (item.asked_price != null && item.asked_price > 0)
        lines.push({
          request_item: item.index,
          origin: 'accepted',
          raw_description: describe(item.product_name, item.pack),
          pack_price: item.asked_price,
          pack_size: item.pack?.pack_size ?? null,
          pack_unit: item.pack?.pack_unit ?? null,
          units_per_case: item.pack?.units_per_case ?? 1,
          product_id: item.product_id,
          review_reasons: item.pack ? [] : [PACK_UNKNOWN],
        })
    } else if (a.outcome === 'counter_offer') {
      const offer = offerOf(a, item)
      if (offer) {
        outcome.pack_price = offer.price
        outcome.pack_size = offer.pack?.pack_size ?? null
        outcome.pack_unit = offer.pack?.pack_unit ?? null
        outcome.units_per_case = offer.pack?.units_per_case ?? null
        if (name)
          lines.push({
            request_item: item?.index ?? null,
            origin: 'read',
            raw_description: describe(name, offer.pack),
            pack_price: offer.price,
            pack_size: offer.pack?.pack_size ?? null,
            pack_unit: offer.pack?.pack_unit ?? null,
            units_per_case: offer.pack?.units_per_case ?? 1,
            product_id: item?.product_id ?? null,
            review_reasons: offer.reasons,
          })
      }
    }
    if (item) {
      answered.add(item.index)
      outcomes.push(outcome)
      return
    }
    // Not about a known request item: the overall row carries its price and question.
    const overall = outcomes[0]
    outcomes[0] = {
      ...overall,
      ...(overall.pack_price == null && outcome.pack_price != null
        ? {
            pack_price: outcome.pack_price,
            pack_size: outcome.pack_size,
            pack_unit: outcome.pack_unit,
            units_per_case: outcome.units_per_case,
          }
        : {}),
      question: overall.question ?? outcome.question,
    }
  }

  for (const a of read.answers) {
    const item = a.request_item ? (byKey.get(a.request_item) ?? null) : null
    if (item && answered.has(item.index)) continue
    add(a, item)
  }
  for (const item of items) {
    if (answered.has(item.index)) continue
    const outcome = read.overall === 'counter_offer' ? 'unclear' : read.overall
    add(
      {
        request_item: itemKey(item.index),
        product_hint: null,
        outcome,
        said: read.overall_said,
        question: null,
        offer_price: null,
        offer_pack: null,
        pack_size: null,
        pack_unit: null,
        units_per_case: null,
        price_includes_vat: false,
      },
      item,
    )
  }
  return { outcomes, lines: lines.map((l, i) => ({ ...l, line_index: i })) }
}

// --- Showing outcomes -----------------------------------------------------------------

export const OUTCOME_LABEL: Record<ReplyOutcome | 'waiting', string> = {
  accepted: 'Accepted',
  counter_offer: 'Countered',
  declined: 'Declined',
  needs_info: 'Needs info',
  unclear: 'Unclear',
  waiting: 'Waiting',
}

/** "€15.00/kg" for a price per 1 kg / 1 l / 1 item, else "€9.50 per 2kg". */
export function offerPrice(o: {
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
}): string {
  if (
    isRawUnit(o.pack_unit) &&
    (o.units_per_case ?? 1) === 1 &&
    (o.pack_size ?? 1) === 1
  ) {
    const short: Record<RawUnit, string> = {
      ml: 'ml',
      cl: 'cl',
      l: 'L',
      g: 'g',
      kg: 'kg',
      each: 'each',
    }
    const u = short[o.pack_unit]
    return u === 'each'
      ? `${euro(o.pack_price, { cents: true })} each`
      : `${euro(o.pack_price, { cents: true })}/${u}`
  }
  if (!isRawUnit(o.pack_unit)) return euro(o.pack_price, { cents: true })
  return `${euro(o.pack_price, { cents: true })} per ${packLabel(o)}`
}

/** "Accepted €2.91", "Countered €15.00/kg", "Declined", "Needs info", "Waiting". */
export function outcomeLabel(
  o: {
    outcome: ReplyOutcome
    pack_price: number | null
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
    asked_price?: number | null
  } | null,
): string {
  if (!o) return OUTCOME_LABEL.waiting
  if (o.outcome === 'accepted' && o.asked_price != null)
    return `Accepted ${euro(o.asked_price, { cents: true })}`
  if (o.outcome === 'counter_offer' && o.pack_price != null)
    return `Countered ${offerPrice({ ...o, pack_price: o.pack_price })}`
  return OUTCOME_LABEL[o.outcome]
}

export interface StoredOutcome extends OutcomeRow {
  inbound_email_id: string
  received_at: string
}

/**
 * A request's current answer per requested product, plus the overall one: the rows from its
 * newest reply that says anything (the owner's own choice on that reply included).
 */
export function currentOutcomes(
  rows: Array<StoredOutcome>,
): Array<StoredOutcome> {
  const newest = [...rows]
    .sort((a, b) =>
      a.received_at < b.received_at
        ? 1
        : a.received_at > b.received_at
          ? -1
          : 0,
    )
    .at(0)
  if (!newest) return []
  return rows
    .filter((r) => r.inbound_email_id === newest.inbound_email_id)
    .sort((a, b) => (a.request_item ?? -1) - (b.request_item ?? -1))
}

// --- Comparing a line with what the owner pays ----------------------------------------

export interface LineComparison {
  /** Price per 1 ml / 1 g / 1 item of the line, against the product. */
  ppu: number | null
  base_unit: BaseUnit | null
  your_ppu: number | null
  your_supplier: string | null
  /** What the owner pays per pack, for the line's pack. */
  your_pack_price: number | null
  /** your_ppu - ppu: positive when the line is cheaper. */
  diff_ppu: number | null
  diff_pct: number | null
  annual_saving: number | null
  /** Null when there is nothing to compare with. */
  better: boolean | null
  /** Why it can't be priced against the product. */
  problem: string | null
}

/**
 * How a proposed price compares with what the owner pays now (insight.current, which is the
 * agreed price when there is one). The yearly saving uses the yearly volume from invoices.
 */
export function compareLine(
  line: {
    pack_price: number
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
  },
  productUnit: BaseUnit | null,
  insight: Pick<ProductInsight, 'current' | 'annual_base_units'> | null,
): LineComparison {
  const empty: LineComparison = {
    ppu: null,
    base_unit: productUnit,
    your_ppu: null,
    your_supplier: null,
    your_pack_price: null,
    diff_ppu: null,
    diff_pct: null,
    annual_saving: null,
    better: null,
    problem: null,
  }
  if (!isRawUnit(line.pack_unit)) return { ...empty, problem: PACK_UNKNOWN }
  const spec = {
    pack_size: line.pack_size,
    pack_unit: line.pack_unit,
    units_per_case: line.units_per_case,
  }
  const r = pricePerBaseUnit(line.pack_price, spec)
  if (!r) return { ...empty, problem: PACK_UNKNOWN }
  if (productUnit && toBase(1, line.pack_unit).unit !== productUnit)
    return {
      ...empty,
      problem: `Unit mismatch: the price is per ${r.unit}, the product is in ${productUnit}`,
    }
  const out: LineComparison = { ...empty, ppu: r.price, base_unit: r.unit }
  const cur = insight?.current
  if (!cur) return out
  const units = baseUnitsPerPack(spec)
  const diff = cur.ppu - r.price
  return {
    ...out,
    your_ppu: cur.ppu,
    your_supplier: cur.supplier_name,
    your_pack_price: units
      ? Math.round(cur.ppu * units.amount * 100) / 100
      : null,
    diff_ppu: diff,
    diff_pct: cur.ppu > 0 ? diff / cur.ppu : null,
    annual_saving:
      insight.annual_base_units != null
        ? Math.max(0, Math.round(diff * insight.annual_base_units))
        : null,
    better: diff > 0,
  }
}

/** "€4.75/kg" for a compared line, in the units an owner thinks in. */
export function lineUnitPrice(c: LineComparison): string {
  return perStandardShort(c.ppu, c.base_unit)
}

// --- Status of a reply ----------------------------------------------------------------

export type ReplyStatusKind =
  'waiting' | 'applied' | 'rejected' | 'partly' | 'nothing'

export interface ReplyStatus {
  kind: ReplyStatusKind
  proposed: number
  applied: number
  rejected: number
  label: string
}

/** What is left to do on a reply, from its lines and held invoices. */
export function replyStatus(
  items: Array<{ status: LineStatus; kind?: 'line' | 'invoice' }>,
): ReplyStatus {
  const count = (s: LineStatus) => items.filter((i) => i.status === s).length
  const proposed = count('proposed')
  const applied = count('applied')
  const rejected = count('rejected')
  const base = { proposed, applied, rejected }
  if (proposed > 0) {
    const waiting = items.filter((i) => i.status === 'proposed')
    const invoices = waiting.filter((i) => i.kind === 'invoice').length
    const lines = waiting.length - invoices
    const what = [
      lines > 0 ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : null,
      invoices > 0
        ? `${invoices} ${invoices === 1 ? 'invoice' : 'invoices'}`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    return { ...base, kind: 'waiting', label: `Waiting for review (${what})` }
  }
  if (applied > 0 && rejected > 0)
    return { ...base, kind: 'partly', label: 'Partly applied' }
  if (applied > 0) return { ...base, kind: 'applied', label: 'Applied' }
  if (rejected > 0) return { ...base, kind: 'rejected', label: 'Rejected' }
  return { ...base, kind: 'nothing', label: 'Nothing to apply' }
}

// --- Agreed prices not honoured -----------------------------------------------------------

/** "Lee Valley charged €4.20 for Whole milk, but agreed €3.55 on 7 Nov." */
export function notHonouredText(
  b: Pick<
    BrokenPromise,
    'supplier_name' | 'charged_pack_price' | 'agreed_pack_price' | 'agreed_on'
  >,
  productName: string,
): string {
  return `${b.supplier_name} charged ${euro(b.charged_pack_price, { cents: true })} for ${productName}, but agreed ${euro(b.agreed_pack_price, { cents: true })} on ${shortDate(b.agreed_on)}.`
}
