// Reading supplier replies. A reply (from Gmail or the inbound-email webhook) is kept, tied to
// the request it answers (lib/inbound.ts) and read by Claude into review: its prices and
// invoices wait for the owner (lib/reply-review.server.ts) and change nothing until applied.
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AIError } from './claude.server'
import {
  draftIdFromRecipients,
  emailOf,
  isOutgoingCopy,
  matchReply,
} from './inbound'
import type { DraftRef, SupplierRef } from './inbound'
import { mediaTypeFor } from './media.server'
import type { ReplyOutcome, ReplyStatus } from './reply-review'
import {
  readIntoReview,
  replyOutcomes,
  replyStatuses,
  reviewLines,
} from './reply-review.server'
import type { ReplyForReading } from './reply-review.server'
import { getSettings, inboundAddress } from './settings.server'
import { INVOICE_BUCKET, db, must, mustOne } from './supabase.server'

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
  /**
   * The request this answers, when the mailbox already knows it: a Gmail reply names the
   * sent request's Message-ID in In-Reply-To or References (lib/gmail-replies.server.ts).
   */
  draft_id?: string | null
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

  const settings = await getSettings()
  // A known request (from the reply's thread headers) is as certain as a plus-address.
  const plusDraftId =
    msg.draft_id ??
    draftIdFromRecipients(
      msg.recipients,
      inboundAddress(settings),
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
    by_sender: settings.match_by_sender,
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

/**
 * Reads a stored reply into review (lib/reply-review.server.ts): what it proposes waits for
 * the owner, and what it answered is recorded on the request. Nothing changes a price here.
 * Safe to run again: the reader's earlier proposals for the parts read are replaced, and
 * everything the owner decided stays. `only` reads one part again: 'email body' or an
 * attachment's file name.
 */
export async function processInbound(
  id: string,
  only?: string,
): Promise<'processed' | 'failed' | 'unmatched'> {
  const row = mustOne(
    await db()
      .from('inbound_emails')
      .select(
        'id, from_email, from_name, subject, body_text, received_at, supplier_id, draft_id, attachments',
      )
      .eq('id', id)
      .single<ReplyForReading>(),
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

  try {
    const result = await readIntoReview(row, row.supplier_id, only)
    const counts = await replyCounts(id)
    await db()
      .from('inbound_emails')
      .update({
        status: result.nothingRead ? 'failed' : 'processed',
        error: result.errors.length > 0 ? result.errors.join(' ') : null,
        invoices_read: counts.invoices,
        quote_lines: counts.lines,
        better_quotes: counts.better,
      })
      .eq('id', id)
    return result.nothingRead ? 'failed' : 'processed'
  } catch (err) {
    const message =
      err instanceof AIError
        ? err.message
        : `Couldn't read this reply: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[inbound] ${id}:`, err)
    await db()
      .from('inbound_emails')
      .update({ status: 'failed', error: message })
      .eq('id', id)
    return 'failed'
  }
}

/** The counts kept on inbound_emails: lines and invoices the reply proposed, better prices. */
async function replyCounts(id: string) {
  const [lines, invoices] = await Promise.all([
    reviewLines(id),
    db()
      .from('reply_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('inbound_email_id', id),
  ])
  return {
    lines: lines.length,
    invoices: invoices.count ?? 0,
    better: lines.filter((l) => l.status === 'proposed' && l.comparison.better)
      .length,
  }
}

/**
 * Retry a failed reply, read an unmatched one once the owner says which supplier it is, or
 * read one part of a reply again ("Read again").
 */
export async function reprocessInbound(
  id: string,
  supplierId?: string,
  only?: string,
) {
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
  return processInbound(id, only)
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
  /** What is left to review on it: waiting (n lines), applied, rejected, partly applied. */
  review: ReplyStatus | null
  /** What the supplier answered, e.g. "Accepted €2.91" or "Declined". */
  outcome: { outcome: ReplyOutcome; label: string } | null
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
      | 'supplier_name'
      | 'request_subject'
      | 'request_kind'
      | 'attachment_names'
      | 'review'
      | 'outcome'
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
  const ids = rows.map((r) => r.id)
  const [statuses, outcomes] = await Promise.all([
    replyStatuses(ids),
    replyOutcomes(ids),
  ])
  return {
    replies: rows.map(({ draft_id, attachments, suppliers: s, ...r }) => {
      const d = drafts.find((x) => x.id === draft_id)
      return {
        ...r,
        supplier_name: s?.name ?? null,
        request_subject: d?.subject ?? null,
        request_kind: d?.kind ?? null,
        attachment_names: attachments.map((a) => a.name),
        review: statuses.get(r.id) ?? null,
        outcome: outcomes.get(r.id) ?? null,
      }
    }),
    suppliers,
  }
}
