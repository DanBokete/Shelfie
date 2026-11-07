// Telegram alert texts. Fixed templates, never written by a model, so they read the same
// every time. Pure functions only: the sending lives in alerts.server.ts.
import { euro, perStandardShort } from './format'
import { notHonouredText } from './reply-review'
import { daysBetween } from './savings'
import type { BrokenPromise, Observation } from './savings'
import type { BaseUnit } from './units'
import { perStandardUnit } from './units'

/** A web price this much below what the owner pays is worth an alert. */
export const WEB_DEAL_THRESHOLD = 0.05
/** A rise on this week's invoices this big makes the weekly summary. */
export const WEEKLY_RISE_THRESHOLD = 0.03
/** The weekly summary covers this many days, up to and including the latest invoice. */
export const WEEK_DAYS = 7

// Shares like 0.05 come out of float maths as 0.049999...: compare with a little slack.
const EPS = 1e-9

function base(appUrl: string): string {
  return appUrl.replace(/\/+$/, '')
}

export function itemLink(appUrl: string, productId: string): string {
  return `${base(appUrl)}/item/${productId}`
}

/** "€1,468": whole euros, also below €100. */
function wholeEuros(n: number): string {
  return euro(n, { cents: false })
}

function savingLine(annualSaving: number): string | null {
  return annualSaving > 0 ? `Save ${wholeEuros(annualSaving)}/yr.` : null
}

function lines(...xs: Array<string | null>): string {
  return xs.filter((x): x is string => x !== null).join('\n')
}

/** What one fractional change reads as, e.g. 0.1111 -> "11%". */
function percent(x: number): string {
  return `${Math.round(x * 100)}%`
}

export interface BetterQuoteAlert {
  supplier_name: string
  product_name: string
  your_ppu: number
  quote_ppu: number
  base_unit: BaseUnit
  annual_saving: number
  product_id: string
}

/** "Munster Fresh Foods will do Whole milk at €1.78/L (you pay €2.10/L)." */
export function betterQuoteText(q: BetterQuoteAlert, appUrl: string): string {
  return lines(
    `${q.supplier_name} will do ${q.product_name} at ${perStandardShort(q.quote_ppu, q.base_unit)} (you pay ${perStandardShort(q.your_ppu, q.base_unit)}).`,
    savingLine(q.annual_saving),
    `Tap to view: ${itemLink(appUrl, q.product_id)}`,
  )
}

export interface WebPriceAlert {
  seller: string
  product_name: string
  current_supplier: string
  your_ppu: number
  offer_ppu: number
  base_unit: BaseUnit
  annual_saving: number
  product_id: string
}

/** True when a web price is at least 5% below what the owner pays. */
export function isWebDeal(yourPpu: number, offerPpu: number): boolean {
  if (!(yourPpu > 0) || !(offerPpu > 0)) return false
  return (yourPpu - offerPpu) / yourPpu >= WEB_DEAL_THRESHOLD - EPS
}

/** "Found Whole milk online at €1.78/L at SuperValu (you pay €2.10/L at Lee Valley Wholesale, 15% less)." */
export function webPriceText(w: WebPriceAlert, appUrl: string): string {
  const less = (w.your_ppu - w.offer_ppu) / w.your_ppu
  return lines(
    `Found ${w.product_name} online at ${perStandardShort(w.offer_ppu, w.base_unit)} at ${w.seller} (you pay ${perStandardShort(w.your_ppu, w.base_unit)} at ${w.current_supplier}, ${percent(less)} less).`,
    savingLine(w.annual_saving),
    `Tap to view: ${itemLink(appUrl, w.product_id)}`,
  )
}

/**
 * The same deal must not be sent twice: product, seller and the price rounded to the
 * cent per litre, kg or item. A new, different price from the same seller is a new deal.
 */
export function dealKey(
  productId: string,
  seller: string,
  ppu: number,
  unit: BaseUnit,
): string {
  const cents = Math.round(perStandardUnit(ppu, unit) * 100)
  return `${productId}:${seller.trim().toLowerCase()}:${cents}`
}

export interface PriceRise {
  product_id: string
  product_name: string
  supplier_name: string
  base_unit: BaseUnit
  from_ppu: number
  to_ppu: number
  pct: number
}

/** The 7 days up to and including `last`, as YYYY-MM-DD. */
export function weekWindow(last: string): { from: string; to: string } {
  const d = new Date(`${last.slice(0, 10)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (WEEK_DAYS - 1))
  return { from: d.toISOString().slice(0, 10), to: last.slice(0, 10) }
}

/**
 * Prices that went up this week: for each supplier of each product, the latest invoice price
 * in the window against that supplier's last invoice price before it. 3% or more counts.
 * Biggest rise first.
 */
export function weeklyRises(
  products: Array<{
    id: string
    canonical_name: string
    base_unit: BaseUnit
    observations: Array<Observation>
  }>,
  window: { from: string; to: string },
): Array<PriceRise> {
  const out: Array<PriceRise> = []
  for (const p of products) {
    const bySupplier = new Map<string, Array<Observation>>()
    for (const o of p.observations) {
      if (o.source !== 'invoice' || o.price_per_base_unit == null) continue
      if (o.observed_on > window.to) continue
      const list = bySupplier.get(o.supplier_id) ?? []
      list.push(o)
      bySupplier.set(o.supplier_id, list)
    }
    for (const obs of bySupplier.values()) {
      const sorted = [...obs].sort((a, b) =>
        a.observed_on.localeCompare(b.observed_on),
      )
      const now = sorted.filter((o) => o.observed_on >= window.from).at(-1)
      const before = sorted.filter((o) => o.observed_on < window.from).at(-1)
      if (!now || !before) continue
      const from = before.price_per_base_unit!
      const to = now.price_per_base_unit!
      if (!(from > 0)) continue
      const pct = (to - from) / from
      if (pct < WEEKLY_RISE_THRESHOLD - EPS) continue
      out.push({
        product_id: p.id,
        product_name: p.canonical_name,
        supplier_name: now.supplier_name,
        base_unit: p.base_unit,
        from_ppu: from,
        to_ppu: to,
        pct,
      })
    }
  }
  return out.sort((a, b) => b.pct - a.pct)
}

export interface WaitingSaving {
  product_id: string
  product_name: string
  annual_saving: number
  /** Date of the invoice the owner's current price comes from. */
  current_since: string
}

export interface DraftMention {
  created_at: string
  product_names: Array<string>
}

/**
 * The biggest switch saving the owner has not acted on yet. Asking a supplier to match, or a
 * seller for a quote, counts as acting on it once the email is drafted after the current price.
 */
export function biggestWaiting(
  savings: Array<WaitingSaving>,
  drafts: Array<DraftMention>,
): WaitingSaving | null {
  const norm = (s: string) => s.trim().toLowerCase()
  const acted = (s: WaitingSaving) =>
    drafts.some(
      (d) =>
        daysBetween(s.current_since, d.created_at.slice(0, 10)) >= 0 &&
        d.product_names.some((n) => norm(n) === norm(s.product_name)),
    )
  return (
    savings
      .filter((s) => s.annual_saving > 0 && !acted(s))
      .sort((a, b) => b.annual_saving - a.annual_saving)[0] ?? null
  )
}

/**
 * Shelfie weekly: 3 price rises this week
 * Whole milk up 11% at Lee Valley Wholesale (now €2.10/L)
 * Biggest saving waiting: switch Whole milk, save €1,468/yr
 * Tap to fix: <APP_URL>/audit
 */
export function weeklyText(
  w: { rises: Array<PriceRise>; waiting: WaitingSaving | null },
  appUrl: string,
): string {
  const n = w.rises.length
  const top = w.rises.at(0)
  return lines(
    `Shelfie weekly: ${n === 0 ? 'no' : n} price ${n === 1 ? 'rise' : 'rises'} this week`,
    top
      ? `${top.product_name} up ${percent(top.pct)} at ${top.supplier_name} (now ${perStandardShort(top.to_ppu, top.base_unit)})`
      : null,
    w.waiting
      ? `Biggest saving waiting: switch ${w.waiting.product_name}, save ${wholeEuros(w.waiting.annual_saving)}/yr`
      : null,
    `Tap to fix: ${base(appUrl)}/audit`,
  )
}

export function testText(appUrl: string): string {
  return lines(
    'Shelfie test message: alerts are set up.',
    `Open Shelfie: ${base(appUrl)}/`,
  )
}

// --- One message per supplier reply ---------------------------------------------------

/** The snippet of what the supplier wrote is cut to this many characters. */
export const REPLY_SNIPPET_MAX = 160
/** Any other line of a reply message is cut to this many characters. */
export const REPLY_LINE_MAX = 220

/** Cuts text to `max` characters at a word boundary, ending with "…". */
export function clip(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  // A space right after the last kept character is a word boundary too.
  const space = t.slice(0, max).lastIndexOf(' ')
  const cut = space > max / 2 ? t.slice(0, space) : t.slice(0, max - 1)
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`
}

// Where the quoted earlier message starts. Everything from here on is history, not the reply.
const QUOTE_STARTS: Array<RegExp> = [
  // Gmail and Apple Mail: "On Sat, 7 Nov 2026 at 16:02, Aoife <a@b.ie> wrote:", often over two lines.
  /^On\b[^\n]{0,200}(\n[^\n]{0,200})?\bwrote:[ \t]*$/m,
  // Outlook: "From: ..." then "Sent:" or "Date:" a line or two later.
  /^From:[^\n]*\n([^\n]*\n)?(Sent|Date):/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{8,}\s*$/m,
  /^>/m,
]

// Where the sender's signature starts: the standard "-- " line and mail apps' taglines.
const SIGNATURE_STARTS: Array<RegExp> = [
  /^--[ \t]*$/m,
  /^(Sent from|Sent with|Get Outlook for)\b[^\n]*$/im,
]

// A line that only signs off: "Kind regards," or "Thanks". What follows is the signature.
const SIGN_OFF =
  /^(kind regards|best regards|warm regards|regards|many thanks|thanks|thank you|thanks again|best|best wishes|all the best|cheers)[,.!]?$/i

// A first line that only greets: "Hi Aoife," or "Hello,".
const GREETING =
  /^(hi|hello|hey|dear|morning|good (morning|afternoon|evening))\b[^\n]{0,40}$/i

/**
 * What the supplier wrote, cleaned for a one-line preview: no quoted earlier message, no
 * signature, no opening greeting, whitespace collapsed, at most REPLY_SNIPPET_MAX characters.
 * Null when nothing is left.
 */
export function replySnippet(body: string | null | undefined): string | null {
  let text = (body ?? '').replace(/\r\n?/g, '\n')
  for (const re of [...QUOTE_STARTS, ...SIGNATURE_STARTS]) {
    const m = re.exec(text)
    if (m) text = text.slice(0, m.index)
  }
  const kept = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (kept.length > 1 && GREETING.test(kept[0])) kept.shift()
  // A sign-off ends the message, unless it is all the message says.
  const signOff = kept.findIndex((l, i) => i > 0 && SIGN_OFF.test(l))
  if (signOff > 0) kept.length = signOff
  const flat = kept.join(' ').replace(/\s+/g, ' ').trim()
  return flat ? clip(flat, REPLY_SNIPPET_MAX) : null
}

/**
 * What the supplier said to the request, once reply review records it: accepted, made a
 * counter-offer, declined, or asked for more information. `note` is a short detail, e.g. the
 * counter-offer price or the question, already formatted.
 */
export interface RequestOutcome {
  outcome: 'accepted' | 'counter_offer' | 'declined' | 'needs_info'
  note: string | null
}

const OUTCOME_LABELS: Record<RequestOutcome['outcome'], string> = {
  accepted: 'Accepted',
  counter_offer: 'Counter-offer',
  declined: 'Declined',
  needs_info: 'Needs more information',
}

/** A quoted price below what the owner pays now. Figures from lib/savings.ts. */
export interface ReplyOffer {
  product_name: string
  quote_ppu: number
  your_ppu: number
  base_unit: BaseUnit
  annual_saving: number
}

export interface ReplyAlert {
  /** The reply's id, for the link to its review page. */
  id?: string
  /** The supplier's name, or the sender when the supplier is not known. */
  from: string
  /** The request this answers, when it is known and still exists. */
  request: {
    kind: 'match' | 'quote'
    product_names: Array<string>
  } | null
  subject: string | null
  body: string | null
  attachment_names: Array<string>
  status: 'received' | 'processed' | 'failed' | 'unmatched'
  error: string | null
  /** Null until reply review records what the supplier said to the request. */
  outcome: RequestOutcome | null
  /** Better prices in the reply, any order. */
  offers: Array<ReplyOffer>
  /** Prices read from the reply, better or not. */
  quote_lines: number
  /** Of those, how many wait for the owner to apply or reject them. */
  lines_to_check: number
  invoices_read: number
}

/** Where the owner sees the reply: its review page, or the Replies list. */
export function replyLink(appUrl: string, replyId?: string): string {
  return replyId
    ? `${base(appUrl)}/replies/${replyId}`
    : `${base(appUrl)}/invoices#replies`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "Salted butter", "Salted butter and Whole milk", "Salted butter and 2 more". */
function productList(names: Array<string>): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]} and ${names.length - 1} more`
}

function whoLine(r: ReplyAlert): string {
  if (r.request) {
    const what = productList(r.request.product_names)
    const kind = r.request.kind === 'match' ? 'match' : 'quote'
    return `${r.from} replied to your ${what ? `${what} ` : ''}${kind} request`
  }
  return r.subject?.trim()
    ? `${r.from} replied to "${clip(r.subject, 80)}"`
    : `${r.from} sent you an email`
}

function snippetLine(r: ReplyAlert): string {
  const snippet = replySnippet(r.body)
  if (snippet) return `"${snippet}"`
  const n = r.attachment_names.length
  if (n === 0) return '(No message)'
  return `(No message, ${plural(n, 'attachment')}: ${r.attachment_names.join(', ')})`
}

function outcomeLine(o: RequestOutcome | null): string | null {
  if (!o) return null
  return `Outcome: ${OUTCOME_LABELS[o.outcome]}${o.note?.trim() ? `, ${o.note.trim()}` : ''}`
}

/**
 * A read error in the owner's words: an API error that carries a JSON body is cut down to
 * its message, without the field path in front ("messages.0.content.2...: ").
 */
export function readError(error: string | null | undefined): string {
  const e = error?.trim()
  if (!e) return 'no reason given.'
  const json = /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(e)
  if (!json) return e
  const message = json[1].replace(/^[\w.[\]]+:\s+/, '').trim()
  return /[.!?]$/.test(message) ? message : `${message}.`
}

function resultLine(r: ReplyAlert): string {
  if (r.status === 'unmatched')
    return "We couldn't tell which supplier this is from. Pick one in Replies."
  if (r.status === 'failed') return `Couldn't read it: ${readError(r.error)}`
  if (r.status === 'received') return 'Not read yet.'

  const best = [...r.offers].sort(
    (a, b) =>
      b.annual_saving - a.annual_saving ||
      (b.your_ppu - b.quote_ppu) / b.your_ppu -
        (a.your_ppu - a.quote_ppu) / a.your_ppu,
  )[0] as ReplyOffer | undefined
  if (best) {
    const more = r.offers.length - 1
    return [
      `Offer: ${best.product_name} ${perStandardShort(best.quote_ppu, best.base_unit)} (you pay ${perStandardShort(best.your_ppu, best.base_unit)})`,
      best.annual_saving > 0
        ? `, could save ${wholeEuros(best.annual_saving)}/yr`
        : '',
      more > 0 ? `. ${plural(more, 'more better price')}` : '',
      '.',
    ].join('')
  }

  const parts: Array<string> = []
  if (r.invoices_read > 0)
    parts.push(`${plural(r.invoices_read, 'invoice')} to add`)
  if (r.quote_lines > 0) {
    parts.push(
      r.lines_to_check > 0
        ? `Read ${plural(r.quote_lines, 'price')}, none below what you pay now, ${r.lines_to_check} to review`
        : `Read ${plural(r.quote_lines, 'price')}, none below what you pay now`,
    )
  }
  if (parts.length > 0) return `${parts.join('. ')}.`
  return r.error?.trim()
    ? `No prices read: ${r.error.trim()}`
    : 'No prices or invoices in it.'
}

/**
 * Lee Valley Wholesale replied to your Salted butter match request
 * "Yes thats perfect"
 * Outcome: Accepted
 * No prices or invoices in it.
 * Open: <APP_URL>/replies/<reply id>
 *
 * At most 5 lines, each capped, so it reads at a glance on a phone.
 */
export function replyText(r: ReplyAlert, appUrl: string): string {
  return lines(
    ...[whoLine(r), snippetLine(r), outcomeLine(r.outcome), resultLine(r)].map(
      (l) => (l === null ? null : clip(l, REPLY_LINE_MAX)),
    ),
    `Open: ${replyLink(appUrl, r.id)}`,
  )
}

/** "Lee Valley charged €4.20 for Whole milk, but agreed €3.55 on 7 Nov." and the item link. */
export function notHonouredAlertText(
  b: Pick<
    BrokenPromise,
    'supplier_name' | 'charged_pack_price' | 'agreed_pack_price' | 'agreed_on'
  >,
  product: { id: string; name: string },
  appUrl: string,
): string {
  return lines(
    notHonouredText(b, product.name),
    'Ask them to credit the difference.',
    `Tap to view: ${itemLink(appUrl, product.id)}`,
  )
}
