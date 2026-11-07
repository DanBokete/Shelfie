// Reading supplier replies. A reply posted by the inbound-email webhook is kept, tied to the
// request it answers (lib/inbound.ts), read by Claude, and its quote lines become
// price_observations with source 'quote' that feed savings like any other price.
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { notifyBetterQuote } from './alerts.server'
import { AIError, askJSON } from './claude.server'
import {
  draftIdFromRecipients,
  emailOf,
  isOutgoingCopy,
  matchReply,
} from './inbound'
import type { DraftRef, SupplierRef } from './inbound'
import { extractInvoice, storeInvoiceFile } from './invoices.server'
import { applyOutcomes, matchLines } from './match.server'
import { mediaTypeFor, toContentBlock } from './media.server'
import { P12_REPLY_READ } from './prompts'
import { quoteRows, quoteSaving } from './quote-lines'
import { invoicePeriod, observationsByProduct } from './queries.server'
import { productInsight } from './savings'
import { ReplyRead } from './schemas'
import {
  INVOICE_BUCKET,
  db,
  downloadFile,
  must,
  mustOne,
} from './supabase.server'

const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_BODY_CHARS = 20_000
const READABLE = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export interface InboundMessage {
  message_id: string
  from_email: string
  from_name: string | null
  /** The To header addresses. */
  to: Array<string>
  /** Every address the message went to (To, Cc, original recipient): where plus-addresses hide. */
  recipients: Array<string>
  subject: string
  text: string
  /** Quoted history removed, when the provider supplies it. */
  reply_text: string | null
  received_at: string
  mailbox_hash: string | null
  attachments: Array<{ name: string; type: string; bytes: Uint8Array }>
}

// --- Postmark inbound webhook payload -------------------------------------------------

const Person = z.object({
  Email: z.string(),
  Name: z.string().nullish(),
  MailboxHash: z.string().nullish(),
})
const PostmarkPayload = z.object({
  MessageID: z.string().nullish(),
  From: z.string().nullish(),
  FromFull: Person.nullish(),
  ToFull: z.array(Person).nullish(),
  CcFull: z.array(Person).nullish(),
  OriginalRecipient: z.string().nullish(),
  MailboxHash: z.string().nullish(),
  Subject: z.string().nullish(),
  Date: z.string().nullish(),
  TextBody: z.string().nullish(),
  HtmlBody: z.string().nullish(),
  StrippedTextReply: z.string().nullish(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).nullish(),
  Attachments: z
    .array(
      z.object({
        Name: z.string(),
        Content: z.string(),
        ContentType: z.string(),
      }),
    )
    .nullish(),
})

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&euro;/g, '€')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

/** Validates a Postmark inbound payload. Throws a ZodError on anything else. */
export function parsePostmark(payload: unknown): InboundMessage {
  const p = PostmarkPayload.parse(payload)
  const from = emailOf(p.FromFull?.Email) ?? emailOf(p.From)
  if (!from)
    throw new z.ZodError([
      { code: 'custom', path: ['From'], message: 'no sender', input: null },
    ])
  const to = (p.ToFull ?? []).map((x) => x.Email)
  const recipients = [
    ...to,
    ...(p.CcFull ?? []).map((x) => x.Email),
    ...(p.OriginalRecipient ? [p.OriginalRecipient] : []),
  ]
  const headerId = p.Headers?.find(
    (h) => h.Name.toLowerCase() === 'message-id',
  )?.Value
  const text = (p.TextBody?.trim() || htmlToText(p.HtmlBody ?? '')).slice(
    0,
    MAX_BODY_CHARS,
  )
  const date = p.Date ? new Date(p.Date) : null
  return {
    message_id:
      p.MessageID ||
      headerId ||
      createHash('sha256')
        .update(`${from}|${p.Subject ?? ''}|${p.Date ?? ''}|${text}`)
        .digest('hex')
        .slice(0, 32),
    from_email: from,
    from_name: p.FromFull?.Name?.trim() || null,
    to,
    recipients,
    subject: p.Subject ?? '',
    text,
    reply_text: p.StrippedTextReply?.trim() || null,
    received_at:
      date && !Number.isNaN(date.getTime())
        ? date.toISOString()
        : new Date().toISOString(),
    mailbox_hash: p.MailboxHash ?? p.ToFull?.[0]?.MailboxHash ?? null,
    attachments: (p.Attachments ?? []).map((a) => ({
      name: a.Name,
      type: a.ContentType,
      bytes: new Uint8Array(Buffer.from(a.Content, 'base64')),
    })),
  }
}

// --- Receiving ------------------------------------------------------------------------

export type ReceiveResult =
  | {
      id: string
      status: 'received' | 'processed' | 'failed' | 'unmatched'
      duplicate?: boolean
    }
  | { ignored: 'own request' }

interface StoredAttachment {
  name: string
  type: string
  size: number
  path: string
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file'
}

/** Keeps the reply, ties it to a request, and reads it when the supplier is known. */
export async function receiveInbound(
  msg: InboundMessage,
): Promise<ReceiveResult> {
  const dup = must(
    await db()
      .from('inbound_emails')
      .select('id, status')
      .eq('message_id', msg.message_id)
      .limit(1),
    'duplicate check',
  ) as Array<{
    id: string
    status: 'received' | 'processed' | 'failed' | 'unmatched'
  }>
  // The provider retries a webhook it thinks failed: the same message is never read twice.
  if (dup.length > 0) return { ...dup[0], duplicate: true }

  const drafts = must(
    await db()
      .from('email_drafts')
      .select('id, supplier_id, to_email, created_at'),
    'load drafts',
  ) as Array<DraftRef>
  const suppliers = must(
    await db().from('suppliers').select('id, name, email, website'),
    'load suppliers',
  ) as Array<SupplierRef>

  const plusDraftId = draftIdFromRecipients(
    msg.recipients,
    process.env.INBOUND_EMAIL_ADDRESS,
    msg.mailbox_hash,
  )
  const plusDraft = drafts.find((d) => d.id === plusDraftId)
  if (
    plusDraft &&
    isOutgoingCopy({
      from: msg.from_email,
      to: msg.to,
      draft_to_email: plusDraft.to_email,
    })
  ) {
    console.info(`[inbound] ignored the owner's own request ${msg.message_id}`)
    return { ignored: 'own request' }
  }

  const match = matchReply({
    from: msg.from_email,
    plus_draft_id: plusDraftId,
    drafts,
    suppliers,
  })

  const id = randomUUID()
  const stored: Array<StoredAttachment> = []
  let index = 0
  for (const a of msg.attachments.slice(0, MAX_ATTACHMENTS)) {
    const type = mediaTypeFor(a.name, a.type)
    if (!READABLE.has(type) || a.bytes.length > MAX_ATTACHMENT_BYTES) continue
    const filePath = `inbound/${id}/${index++}-${safeName(a.name)}`
    must(
      await db()
        .storage.from(INVOICE_BUCKET)
        .upload(filePath, a.bytes, { contentType: type, upsert: false }),
      'store attachment',
    )
    stored.push({ name: a.name, type, size: a.bytes.length, path: filePath })
  }

  const { error } = await db()
    .from('inbound_emails')
    .insert({
      id,
      message_id: msg.message_id,
      from_email: msg.from_email,
      from_name: msg.from_name,
      subject: msg.subject,
      body_text: (msg.reply_text ?? msg.text) || null,
      received_at: msg.received_at,
      draft_id: match?.draft_id ?? null,
      supplier_id: match?.supplier_id ?? null,
      match_method: match?.method ?? null,
      status: match ? 'received' : 'unmatched',
      attachments: stored,
    })
  if (error) {
    // Two deliveries of the same message raced: the other one wins.
    if (error.code === '23505') {
      const row = mustOne(
        await db()
          .from('inbound_emails')
          .select('id, status')
          .eq('message_id', msg.message_id)
          .single<{ id: string; status: 'received' }>(),
        'load duplicate',
      )
      return { ...row, duplicate: true }
    }
    throw new Error(`save reply: ${error.message}`)
  }

  if (!match) return { id, status: 'unmatched' }
  const status = await processInbound(id)
  return { id, status }
}

// --- Reading --------------------------------------------------------------------------

interface InboundRow {
  id: string
  from_email: string
  from_name: string | null
  subject: string | null
  body_text: string | null
  received_at: string
  supplier_id: string | null
  attachments: Array<StoredAttachment>
}

/**
 * Reads a stored reply: invoices go through the invoice pipeline, quotes and price lists
 * become 'quote' prices and are matched to products. Safe to run again: earlier prices from
 * the same reply are replaced.
 */
export async function processInbound(
  id: string,
): Promise<'processed' | 'failed' | 'unmatched'> {
  const row = mustOne(
    await db()
      .from('inbound_emails')
      .select(
        'id, from_email, from_name, subject, body_text, received_at, supplier_id, attachments',
      )
      .eq('id', id)
      .single<InboundRow>(),
    'load reply',
  )
  if (!row.supplier_id) {
    await db()
      .from('inbound_emails')
      .update({ status: 'unmatched' })
      .eq('id', id)
    return 'unmatched'
  }
  await db()
    .from('inbound_emails')
    .update({ status: 'received', error: null })
    .eq('id', id)
  await db().from('price_observations').delete().eq('inbound_email_id', id)

  try {
    const result = await readReply(row, row.supplier_id)
    await db()
      .from('inbound_emails')
      .update({
        status: result.nothingRead ? 'failed' : 'processed',
        error: result.errors.length > 0 ? result.errors.join(' ') : null,
        invoices_read: result.invoices,
        quote_lines: result.quoteLines,
        better_quotes: result.betterQuotes,
      })
      .eq('id', id)
    return result.nothingRead ? 'failed' : 'processed'
  } catch (err) {
    const message =
      err instanceof AIError
        ? err.message
        : `Couldn't read this reply: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[inbound] ${id}:`, err)
    await db().from('price_observations').delete().eq('inbound_email_id', id)
    await db()
      .from('inbound_emails')
      .update({ status: 'failed', error: message })
      .eq('id', id)
    return 'failed'
  }
}

async function readReply(row: InboundRow, supplierId: string) {
  const errors: Array<string> = []
  const body = (row.body_text ?? '').trim()
  const attachments = row.attachments

  // Nothing to read: an empty reply or a bare "thanks".
  if (attachments.length === 0 && body.length < 15)
    return {
      invoices: 0,
      quoteLines: 0,
      betterQuotes: 0,
      errors,
      nothingRead: false,
    }

  const content: Array<
    Awaited<ReturnType<typeof toContentBlock>> | { type: 'text'; text: string }
  > = [
    {
      type: 'text',
      text: `From: ${row.from_name ?? ''} <${row.from_email}>\nSubject: ${row.subject ?? ''}\n\nEmail body:\n${body || '(empty)'}`,
    },
  ]
  const readable: Array<StoredAttachment & { bytes: Uint8Array }> = []
  for (const a of attachments) {
    try {
      const bytes = new Uint8Array(
        await (await downloadFile(INVOICE_BUCKET, a.path)).arrayBuffer(),
      )
      const block = await toContentBlock(bytes, a.type)
      content.push(
        { type: 'text', text: `Attachment file name: ${a.name}` },
        block,
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

  const supplier = mustOne(
    await db()
      .from('suppliers')
      .select('id, name')
      .eq('id', supplierId)
      .single<{ id: string; name: string }>(),
    'load supplier',
  )
  const receivedOn = row.received_at.slice(0, 10)

  let invoices = 0
  const rows: Array<ReturnType<typeof quoteRows>[number] & { id: string }> = []
  for (const doc of read.documents) {
    if (doc.kind === 'invoice') {
      const file =
        readable.find(
          (a) => a.name.toLowerCase() === doc.source.toLowerCase(),
        ) ?? (readable.length === 1 ? readable[0] : undefined)
      if (!file) {
        errors.push(
          'An invoice was mentioned but no readable file came with it.',
        )
        continue
      }
      const invoiceId = await storeInvoiceFile({
        name: file.name,
        type: file.type,
        bytes: file.bytes,
      })
      const r = await extractInvoice(invoiceId)
      if (r.status === 'failed') errors.push(`${file.name}: ${r.error}`)
      else invoices++
    } else if (doc.kind === 'quote' || doc.kind === 'price_list') {
      for (const r of quoteRows(doc, receivedOn))
        rows.push({ ...r, id: randomUUID() })
    }
  }

  let betterQuotes = 0
  if (rows.length > 0) {
    must(
      await db()
        .from('price_observations')
        .insert(
          rows.map((r) => ({
            id: r.id,
            supplier_id: supplierId,
            inbound_email_id: row.id,
            line_index: r.line_index,
            raw_description: r.raw_description,
            quantity: null,
            pack_price: r.pack_price,
            pack_size: r.pack_size,
            pack_unit: r.pack_unit,
            units_per_case: r.units_per_case,
            price_per_base_unit: r.price_per_base_unit,
            observed_on: r.observed_on,
            source: 'quote',
            extraction_confidence: r.extraction_confidence,
            needs_review: r.needs_review,
            review_reasons: r.review_reasons,
          })),
        ),
      'store quote lines',
    )
    const outcomes = await matchLines(
      rows.map((r) => ({
        id: r.id,
        description: r.raw_description,
        supplier_id: supplierId,
        supplier_name: supplier.name,
        barcode: null,
      })),
    )
    await applyOutcomes(outcomes)
    betterQuotes = await alertBetterQuotes(
      rows.map((r) => r.id),
      supplier.name,
    )
  }

  const nothingRead = errors.length > 0 && invoices === 0 && rows.length === 0
  return {
    invoices,
    quoteLines: rows.length,
    betterQuotes,
    errors,
    nothingRead,
  }
}

/** Calls notifyBetterQuote for each product where a new quote is below what the owner pays. */
async function alertBetterQuotes(
  observationIds: Array<string>,
  supplierName: string,
): Promise<number> {
  const quoted = must(
    await db()
      .from('price_observations')
      .select(
        'product_id, price_per_base_unit, needs_review, review_reasons, products(canonical_name, base_unit)',
      )
      .in('id', observationIds)
      .not('product_id', 'is', null)
      .not('price_per_base_unit', 'is', null),
    'load quote prices',
  ) as unknown as Array<{
    product_id: string
    price_per_base_unit: number
    review_reasons: Array<string>
    products: { canonical_name: string; base_unit: 'ml' | 'g' | 'each' } | null
  }>
  // Only trusted lines: one still waiting for the owner to check it is not a deal yet.
  const cheapest = new Map<string, (typeof quoted)[number]>()
  for (const q of quoted) {
    if (q.review_reasons.some((x) => !x.startsWith('Match:'))) continue
    const have = cheapest.get(q.product_id)
    if (
      !have ||
      Number(q.price_per_base_unit) < Number(have.price_per_base_unit)
    )
      cheapest.set(q.product_id, q)
  }
  if (cheapest.size === 0) return 0

  const [obsMap, period] = await Promise.all([
    observationsByProduct([...cheapest.keys()]),
    invoicePeriod(),
  ])
  let count = 0
  for (const [productId, q] of cheapest) {
    if (!q.products) continue
    const insight = productInsight(obsMap.get(productId) ?? [], { period })
    const current = insight.current
    const quotePpu = Number(q.price_per_base_unit)
    if (!current || !(quotePpu < current.ppu)) continue
    count++
    try {
      await notifyBetterQuote({
        supplier_name: supplierName,
        product_name: q.products.canonical_name,
        your_ppu: current.ppu,
        quote_ppu: quotePpu,
        base_unit: q.products.base_unit,
        annual_saving: quoteSaving(
          current.ppu,
          quotePpu,
          insight.annual_base_units,
        ),
        product_id: productId,
      })
    } catch (err) {
      console.error('[inbound] alert failed', err)
    }
  }
  return count
}

/** Retry a failed reply, or read an unmatched one once the owner says which supplier it is. */
export async function reprocessInbound(id: string, supplierId?: string) {
  if (supplierId) {
    const draft = (
      must(
        await db()
          .from('email_drafts')
          .select('id')
          .eq('supplier_id', supplierId)
          .order('created_at', { ascending: false })
          .limit(1),
        'find draft',
      ) as Array<{ id: string }>
    )[0] as { id: string } | undefined
    must(
      await db()
        .from('inbound_emails')
        .update({
          supplier_id: supplierId,
          draft_id: draft?.id ?? null,
          match_method: 'manual',
        })
        .eq('id', id),
      'assign supplier',
    )
  }
  return processInbound(id)
}

// --- Showing --------------------------------------------------------------------------

export interface ReplySummary {
  id: string
  from_email: string
  from_name: string | null
  subject: string | null
  received_at: string
  status: 'received' | 'processed' | 'failed' | 'unmatched'
  error: string | null
  match_method: string | null
  supplier_id: string | null
  supplier_name: string | null
  request_subject: string | null
  request_kind: 'match' | 'quote' | null
  attachment_names: Array<string>
  invoices_read: number
  quote_lines: number
  better_quotes: number
}

export async function inboundOverview(): Promise<{
  replies: Array<ReplySummary>
  suppliers: Array<{ id: string; name: string }>
}> {
  const rows = must(
    await db()
      .from('inbound_emails')
      .select(
        'id, from_email, from_name, subject, received_at, status, error, match_method, supplier_id, draft_id, attachments, invoices_read, quote_lines, better_quotes, suppliers(name)',
      )
      .order('received_at', { ascending: false })
      .limit(50),
    'load replies',
  ) as unknown as Array<
    Omit<
      ReplySummary,
      'supplier_name' | 'request_subject' | 'request_kind' | 'attachment_names'
    > & {
      draft_id: string | null
      attachments: Array<{ name: string }>
      suppliers: { name: string } | null
    }
  >
  const draftIds = [
    ...new Set(rows.map((r) => r.draft_id).filter(Boolean)),
  ] as Array<string>
  const drafts =
    draftIds.length > 0
      ? (must(
          await db()
            .from('email_drafts')
            .select('id, subject, kind')
            .in('id', draftIds),
          'load requests',
        ) as Array<{
          id: string
          subject: string | null
          kind: 'match' | 'quote'
        }>)
      : []
  const suppliers = must(
    await db().from('suppliers').select('id, name').order('name'),
    'load suppliers',
  ) as Array<{ id: string; name: string }>
  return {
    replies: rows.map(({ draft_id, attachments, suppliers: s, ...r }) => {
      const d = drafts.find((x) => x.id === draft_id)
      return {
        ...r,
        supplier_name: s?.name ?? null,
        request_subject: d?.subject ?? null,
        request_kind: d?.kind ?? null,
        attachment_names: attachments.map((a) => a.name),
      }
    }),
    suppliers,
  }
}
