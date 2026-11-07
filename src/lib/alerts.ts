// Telegram alert texts. Fixed templates, never written by a model, so they read the same
// every time. Pure functions only: the sending lives in alerts.server.ts.
import { euro, perStandardShort } from './format'
import { daysBetween } from './savings'
import type { Observation } from './savings'
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
