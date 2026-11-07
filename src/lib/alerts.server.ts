// Alerts to the owner on Telegram, so they hear about better deals without opening the app.
// Texts are fixed templates (lib/alerts.ts) and every number comes from lib/savings.ts.
// Sending never throws: a failed or unconfigured send is recorded in alerts_sent and logged,
// and whatever called it (reply scanning, a price check) carries on.
import {
  betterQuoteText,
  biggestWaiting,
  dealKey,
  isWebDeal,
  testText,
  webPriceText,
  weekWindow,
  weeklyRises,
  weeklyText,
} from './alerts'
import type { DraftMention, WaitingSaving } from './alerts'
import {
  allOpportunities,
  invoicePeriod,
  observationsByProduct,
} from './queries.server'
import type { Product } from './queries.server'
import { quoteSaving } from './quote-lines'
import { annualBaseUnits } from './savings'
import type { Observation, SupplierPrice } from './savings'
import { db, must } from './supabase.server'

export interface BetterQuote {
  supplier_name: string
  product_name: string
  your_ppu: number // EUR per base unit the owner pays now
  quote_ppu: number // EUR per base unit quoted
  base_unit: 'ml' | 'g' | 'each'
  annual_saving: number // EUR a year, from lib/savings
  product_id: string
}

type AlertKind = 'better_quote' | 'web_price' | 'weekly' | 'test'

export interface AlertResult {
  ok: boolean
  /** True when this exact deal was already sent, so nothing went out. */
  duplicate: boolean
  text: string
  error: string | null
}

const SEND_TIMEOUT_MS = 8_000

const ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'APP_URL'] as const

/** Which Telegram settings are missing from .env. Empty when alerts can be sent. */
export function telegramStatus(): {
  configured: boolean
  missing: Array<string>
} {
  const missing = ENV_VARS.filter((k) => !process.env[k]?.trim())
  return { configured: missing.length === 0, missing }
}

function appUrl(): string {
  return process.env.APP_URL?.trim() ?? ''
}

/** Removes the bot token from anything that might end up in a log or the database. */
function scrub(message: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  return token ? message.replaceAll(token, '<token>') : message
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError')
      return `Telegram did not answer within ${SEND_TIMEOUT_MS / 1000} seconds.`
    const cause = (err as { cause?: unknown }).cause
    const detail =
      cause instanceof Error && cause.message ? ` (${cause.message})` : ''
    return scrub(`${err.message}${detail}`)
  }
  return scrub(String(err))
}

/** One sendMessage call. Returns the error in words, or null when Telegram took it. */
async function sendTelegram(text: string): Promise<string | null> {
  const status = telegramStatus()
  if (!status.configured)
    return `Telegram is not set up: ${status.missing.join(', ')} missing in .env.`
  const token = process.env.TELEGRAM_BOT_TOKEN!.trim()
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID!.trim(),
          text,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    )
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean
      description?: string
    } | null
    if (res.ok && body?.ok) return null
    return scrub(`Telegram said: ${body?.description ?? `HTTP ${res.status}`}`)
  } catch (err) {
    return `Could not reach Telegram: ${errorText(err)}`
  }
}

/**
 * Records and sends one alert. With `once`, an alert with the same kind and key that was
 * sent (or is being sent) already is skipped: the row is claimed before sending, so two
 * calls at the same moment cannot both send it. A failed send frees the key again.
 */
async function deliver(
  kind: AlertKind,
  key: string,
  text: string,
  once: boolean,
): Promise<AlertResult> {
  let rowId: string | null = null
  try {
    const res = await db()
      .from('alerts_sent')
      .insert({ kind, key, text, ok: null })
      .select('id')
      .single<{ id: string }>()
    if (res.error?.code === '23505' && once) {
      console.info(`[alerts] ${kind} ${key} already sent, skipping`)
      return { ok: true, duplicate: true, text, error: null }
    }
    rowId = must(res, 'record alert')!.id
  } catch (err) {
    // Without the record there is no protection against sending twice: don't send.
    const error = `Could not record the alert: ${errorText(err)}`
    console.error(`[alerts] ${kind} ${key}: ${error}`)
    return { ok: false, duplicate: false, text, error }
  }

  const error = await sendTelegram(text)
  if (error) console.warn(`[alerts] ${kind} ${key} not sent: ${error}`)
  else console.info(`[alerts] ${kind} ${key} sent`)
  try {
    must(
      await db()
        .from('alerts_sent')
        .update({
          ok: error === null,
          error,
          sent_at: new Date().toISOString(),
        })
        .eq('id', rowId),
      'record alert result',
    )
  } catch (err) {
    console.error(`[alerts] ${kind} ${key}: ${errorText(err)}`)
  }
  return { ok: error === null, duplicate: false, text, error }
}

/** A supplier's emailed quote beats what the owner pays. Called by reply scanning. */
export async function notifyBetterQuote(q: BetterQuote): Promise<void> {
  try {
    await deliver(
      'better_quote',
      dealKey(q.product_id, q.supplier_name, q.quote_ppu, q.base_unit),
      betterQuoteText(q, appUrl()),
      true,
    )
  } catch (err) {
    console.error('[alerts] better quote alert failed', err)
  }
}

/**
 * After a web price check: alerts when the cheapest offer that counts towards savings is
 * 5% or more below what the owner pays. Offers must already be filtered to trusted, fresh ones.
 */
export async function notifyWebDeal(args: {
  product: Pick<Product, 'id' | 'canonical_name' | 'base_unit'>
  current: SupplierPrice
  offers: Array<{ seller: string; ppu: number }>
  observations: Array<Observation>
}): Promise<void> {
  try {
    const best = args.offers.reduce<{ seller: string; ppu: number } | null>(
      (a, b) => (a && a.ppu <= b.ppu ? a : b),
      null,
    )
    if (!best || !isWebDeal(args.current.ppu, best.ppu)) return
    const volume = annualBaseUnits(args.observations, await invoicePeriod())
    await deliver(
      'web_price',
      dealKey(args.product.id, best.seller, best.ppu, args.product.base_unit),
      webPriceText(
        {
          seller: best.seller,
          product_name: args.product.canonical_name,
          current_supplier: args.current.supplier_name,
          your_ppu: args.current.ppu,
          offer_ppu: best.ppu,
          base_unit: args.product.base_unit,
          annual_saving: quoteSaving(args.current.ppu, best.ppu, volume),
          product_id: args.product.id,
        },
        appUrl(),
      ),
      true,
    )
  } catch (err) {
    console.error('[alerts] web price alert failed', err)
  }
}

/** The text of this week's summary, from the invoices up to the latest invoice date. */
export async function weeklySummary(): Promise<{
  text: string
  week: { from: string; to: string } | null
}> {
  const [period, opps, obs, drafts] = await Promise.all([
    invoicePeriod(),
    allOpportunities(),
    observationsByProduct(),
    db().from('email_drafts').select('created_at, items'),
  ])
  // With mock data "this week" is the 7 days up to the latest invoice, not up to today.
  const week = period ? weekWindow(period.last) : null
  const rises = week
    ? weeklyRises(
        opps.map((o) => ({
          ...o.product,
          observations: obs.get(o.product.id) ?? [],
        })),
        week,
      )
    : []
  const savings: Array<WaitingSaving> = opps
    .filter((o) => o.group === 'switch' && o.insight.current)
    .map((o) => ({
      product_id: o.product.id,
      product_name: o.product.canonical_name,
      annual_saving: o.insight.annual_saving ?? 0,
      current_since: o.insight.current!.observed_on,
    }))
  const mentions: Array<DraftMention> = (
    must(drafts, 'load email drafts') as Array<{
      created_at: string
      items: unknown
    }>
  ).map((d) => ({
    created_at: d.created_at,
    product_names: (Array.isArray(d.items) ? d.items : [])
      .map((i: { product_name?: unknown; product?: unknown }) =>
        typeof i.product_name === 'string' ? i.product_name : i.product,
      )
      .filter((n): n is string => typeof n === 'string'),
  }))
  return {
    text: weeklyText(
      { rises, waiting: biggestWaiting(savings, mentions) },
      appUrl(),
    ),
    week,
  }
}

/** Sends this week's summary. It can be sent again on purpose, so it is never skipped. */
export async function sendWeekly(): Promise<AlertResult> {
  let summary: Awaited<ReturnType<typeof weeklySummary>>
  try {
    summary = await weeklySummary()
  } catch (err) {
    const error = `Could not work out this week's summary: ${errorText(err)}`
    console.error(`[alerts] ${error}`)
    return { ok: false, duplicate: false, text: '', error }
  }
  return deliver(
    'weekly',
    `week:${summary.week?.to ?? 'none'}`,
    summary.text,
    false,
  )
}

export async function sendTest(): Promise<AlertResult> {
  return deliver('test', 'test', testText(appUrl()), false)
}

/** The most recent alert, for the admin page. */
export async function lastAlert(): Promise<{
  kind: AlertKind
  sent_at: string
  ok: boolean | null
  error: string | null
} | null> {
  const rows = must(
    await db()
      .from('alerts_sent')
      .select('kind, sent_at, ok, error')
      .order('sent_at', { ascending: false })
      .limit(1),
    'load last alert',
  ) as Array<{
    kind: AlertKind
    sent_at: string
    ok: boolean | null
    error: string | null
  }>
  return rows[0] ?? null
}
