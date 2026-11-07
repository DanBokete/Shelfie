// Alerts to the owner on Telegram, so they hear about better deals without opening the app.
// Texts are fixed templates (lib/alerts.ts) and every number comes from lib/savings.ts.
// Every supplier reply gets exactly one message (notifyReply); a better quote in it is part of
// that message, not a second one.
// Sending never throws: a failed or unconfigured send is recorded in alerts_sent and logged,
// and whatever called it (reply scanning, a price check) carries on.
import {
  betterQuoteText,
  biggestWaiting,
  dealKey,
  isWebDeal,
  notHonouredAlertText,
  replyText,
  testText,
  webPriceText,
  weekWindow,
  weeklyRises,
  weeklyText,
} from './alerts'
import type {
  DraftMention,
  ReplyAlert,
  ReplyOffer,
  RequestOutcome,
  WaitingSaving,
} from './alerts'
import {
  allOpportunities,
  invoicePeriod,
  notHonoured,
  observationsByProduct,
} from './queries.server'
import type { Product } from './queries.server'
import { euro } from './format'
import { quoteSaving } from './quote-lines'
import { offerPrice, requestItems } from './reply-review'
import type { ReplyOutcome } from './reply-review'
import { reviewLines } from './reply-review.server'
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

type AlertKind =
  'better_quote' | 'web_price' | 'weekly' | 'test' | 'reply' | 'not_honoured'

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

/**
 * Records a better deal from a supplier's emailed quote, keyed like before (product, seller,
 * price), without sending it: the owner hears about it in the one message for the reply
 * (notifyReply), which the reply's caller sends once reading is done. Called by reply scanning.
 */
export async function notifyBetterQuote(q: BetterQuote): Promise<void> {
  try {
    const key = dealKey(q.product_id, q.supplier_name, q.quote_ppu, q.base_unit)
    const res = await db()
      .from('alerts_sent')
      .insert({
        kind: 'better_quote',
        key,
        text: betterQuoteText(q, appUrl()),
        // Claims the deal like a sent alert, so the record stays one per deal.
        ok: true,
        error: null,
      })
    if (res.error?.code === '23505')
      console.info(`[alerts] better_quote ${key} already recorded`)
    else must(res, 'record better quote')
  } catch (err) {
    console.error('[alerts] better quote record failed', err)
  }
}

// --- One message per supplier reply ---------------------------------------------------

/**
 * What the supplier said to the request this reply answers, as reply review stored it: the
 * answer about the one product asked, or the reply's overall answer. "Unclear" leaves the
 * line out.
 */
async function requestOutcome(
  inboundEmailId: string,
): Promise<RequestOutcome | null> {
  const rows = must(
    await db()
      .from('request_outcomes')
      .select(
        'draft_id, request_item, outcome, pack_price, pack_size, pack_unit, units_per_case, said, question',
      )
      .eq('inbound_email_id', inboundEmailId),
    'load outcome',
  ) as Array<{
    draft_id: string | null
    request_item: number | null
    outcome: ReplyOutcome
    pack_price: number | null
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
    said: string | null
    question: string | null
  }>
  const items = rows.filter((r) => r.request_item !== null)
  const o =
    items.length === 1 ? items[0] : rows.find((r) => r.request_item === null)
  if (!o || o.outcome === 'unclear') return null
  let note: string | null = null
  if (o.outcome === 'counter_offer' && o.pack_price != null)
    note = offerPrice({
      ...o,
      pack_price: Number(o.pack_price),
      pack_size: o.pack_size == null ? null : Number(o.pack_size),
    })
  else if (o.outcome === 'accepted' && o.draft_id) {
    const draft = must(
      await db()
        .from('email_drafts')
        .select('kind, items')
        .eq('id', o.draft_id)
        .maybeSingle<{ kind: 'match' | 'quote'; items: unknown }>(),
      'load request',
    )
    const asked = draft
      ? requestItems(draft.kind, draft.items).find(
          (i) => i.index === o.request_item,
        )?.asked_price
      : null
    note = asked != null ? euro(asked, { cents: true }) : null
  } else if (o.outcome === 'needs_info') note = o.question
  else if (o.outcome === 'declined') note = o.said
  return { outcome: o.outcome, note }
}

interface ReplyRow {
  id: string
  from_email: string
  from_name: string | null
  subject: string | null
  body_text: string | null
  status: ReplyAlert['status']
  error: string | null
  draft_id: string | null
  attachments: Array<{ name: string }>
  invoices_read: number
  suppliers: { name: string } | null
}

/** The request a reply answers, if it still exists: its kind and the products it asked about. */
async function replyRequest(
  draftId: string | null,
): Promise<ReplyAlert['request']> {
  if (!draftId) return null
  const rows = must(
    await db().from('email_drafts').select('kind, items').eq('id', draftId),
    'load request',
  ) as Array<{ kind: 'match' | 'quote'; items: unknown }>
  const draft = rows.at(0)
  if (!draft) return null
  return {
    kind: draft.kind,
    product_names: (Array.isArray(draft.items) ? draft.items : [])
      .map((i: { product_name?: unknown; product?: unknown }) =>
        typeof i.product_name === 'string' ? i.product_name : i.product,
      )
      .filter((n): n is string => typeof n === 'string'),
  }
}

/**
 * The prices a reply proposes, from reply review: how many, how many still wait for the owner,
 * and the ones below what the owner pays now (figures from lib/savings.ts via compareLine).
 */
async function replyPrices(inboundEmailId: string): Promise<{
  quote_lines: number
  lines_to_check: number
  offers: Array<ReplyOffer>
}> {
  const lines = await reviewLines(inboundEmailId)
  const cheapest = new Map<string, (typeof lines)[number]>()
  for (const l of lines) {
    const c = l.comparison
    if (!l.product_id || !c.better || c.ppu == null) continue
    const have = cheapest.get(l.product_id)
    if (!have || c.ppu < have.comparison.ppu!) cheapest.set(l.product_id, l)
  }
  return {
    quote_lines: lines.length,
    lines_to_check: lines.filter((l) => l.status === 'proposed').length,
    offers: [...cheapest.values()].map((l) => ({
      product_name: l.product_name ?? l.raw_description,
      quote_ppu: l.comparison.ppu!,
      your_ppu: l.comparison.your_ppu!,
      base_unit: l.comparison.base_unit!,
      annual_saving: l.comparison.annual_saving ?? 0,
    })),
  }
}

/** Everything the reply message says, read from the database by the reply's id. */
export async function replyAlert(
  inboundEmailId: string,
): Promise<ReplyAlert | null> {
  const rows = must(
    await db()
      .from('inbound_emails')
      .select(
        'id, from_email, from_name, subject, body_text, status, error, draft_id, attachments, invoices_read, suppliers(name)',
      )
      .eq('id', inboundEmailId),
    'load reply',
  ) as unknown as Array<ReplyRow>
  const row = rows.at(0)
  if (!row) return null
  const [request, prices, outcome] = await Promise.all([
    replyRequest(row.draft_id),
    row.status === 'processed'
      ? replyPrices(row.id)
      : { quote_lines: 0, lines_to_check: 0, offers: [] },
    requestOutcome(row.id),
  ])
  return {
    id: row.id,
    from:
      row.suppliers?.name ??
      (row.from_name ? `${row.from_name} (${row.from_email})` : row.from_email),
    request,
    subject: row.subject,
    body: row.body_text,
    attachment_names: row.attachments.map((a) => a.name),
    status: row.status,
    error: row.error,
    outcome,
    ...prices,
    invoices_read: row.invoices_read,
  }
}

/**
 * Sends the one message for a supplier reply, once it has been read. Keyed by the reply's id,
 * so reading it again, a Gmail re-check or a webhook retry never sends it twice; a failed send
 * can go again on the next call. A reply still being read is skipped. Never throws.
 */
export async function notifyReply(
  inboundEmailId: string,
): Promise<AlertResult | null> {
  try {
    const reply = await replyAlert(inboundEmailId)
    if (!reply) {
      console.warn(`[alerts] reply ${inboundEmailId} not found`)
      return null
    }
    if (reply.status === 'received') {
      console.info(`[alerts] reply ${inboundEmailId} not read yet, skipping`)
      return null
    }
    return await deliver(
      'reply',
      inboundEmailId,
      replyText(reply, appUrl()),
      true,
    )
  } catch (err) {
    console.error(`[alerts] reply ${inboundEmailId} alert failed`, err)
    return null
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

/** The most recent alert sent, for the admin page. Better quotes are only recorded now. */
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
      .neq('kind', 'better_quote')
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

/**
 * After an invoice is read: one alert per product where it charged more than the price the
 * supplier agreed in a reply. Keyed by product, supplier, agreement and invoice, so reading
 * the same invoice again never sends it twice. Never throws.
 */
export async function notifyNotHonoured(invoiceId: string): Promise<number> {
  try {
    const products = must(
      await db()
        .from('price_observations')
        .select('product_id')
        .eq('invoice_id', invoiceId)
        .not('product_id', 'is', null),
      'load invoice products',
    ) as Array<{ product_id: string }>
    const ids = [...new Set(products.map((p) => p.product_id))]
    if (ids.length === 0) return 0
    const broken = (await notHonoured(ids)).filter(
      (b) => b.invoice_id === invoiceId,
    )
    for (const b of broken)
      await deliver(
        'not_honoured',
        `${b.product_id}:${b.supplier_id}:${b.agreed_on}:${invoiceId}`,
        notHonouredAlertText(
          b,
          { id: b.product_id, name: b.product_name },
          appUrl(),
        ),
        true,
      )
    return broken.length
  } catch (err) {
    console.error(`[alerts] not honoured check for ${invoiceId} failed`, err)
    return 0
  }
}
