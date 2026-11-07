// Reading supplier replies from the owner's Gmail. Two ways in:
// - Gmail connected in Settings: the Gmail API. Each request's thread is read with
//   users.threads.get (Gmail's thread id is kept when the request is sent).
// - Otherwise IMAP, with the same app password used to send (GMAIL_APP_PASSWORD).
// Only replies to requests Shelfie sent are opened:
// - in the same thread: In-Reply-To or References names the request's Message-ID, or
// - from the address the request went to (when "match plain replies by sender" is on).
// The rest of the mailbox is never fetched, and nothing is marked as read.
// Each reply goes through the normal reader (lib/inbound.server.ts), so quotes become
// prices, invoices are read and better quotes alert, exactly as before.
import { ImapFlow } from 'imapflow'
import type { SearchObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import {
  GmailApiError,
  getAttachment,
  getMessage,
  getThread,
  messageHeaders,
  searchMessages,
} from './gmail-api.server'
import {
  attachmentRefs,
  bodyText,
  bounceNote,
  gmailToInbound,
  isBounce,
  newReplies,
  replyKey,
} from './gmail-message.server'
import type { GmailMessage } from './gmail-message.server'
import { GmailReconnectError } from './google-auth.server'
import { emailOf } from './inbound'
import { receiveInbound } from './inbound.server'
import type { InboundMessage } from './inbound.server'
import { getSettings, sendingStatus } from './settings.server'
import type { Settings } from './settings.server'
import { db, must } from './supabase.server'

export { bounceNote, isBounce }

/** Requests older than this are no longer watched for replies. */
const WATCH_DAYS = 45
/** Automatic checks closer together than this are skipped; "Check now" always runs. */
const MIN_INTERVAL_MS = 60_000
const MAX_BODY_CHARS = 20_000

interface SentDraft {
  id: string
  to_email: string | null
  sent_at: string
  provider_message_id: string | null
  gmail_thread_id?: string | null
  send_error: string | null
}

export interface ReplyCheck {
  status: 'checked' | 'skipped' | 'failed'
  /** Why it was skipped or failed, in the owner's words. */
  reason: string | null
  checked_at: string | null
  /** Replies found that were new to Shelfie, and how many of those were read. */
  new_replies: number
  read: number
  /** "Could not deliver" notices from Gmail, noted on their requests instead. */
  bounces: number
}

/** The IMAP search for one request's replies: its thread, and optionally its recipient. */
export function replySearch(
  draft: SentDraft,
  bySender: boolean,
): SearchObject | null {
  const id = draft.provider_message_id
  const thread: Array<SearchObject> = id
    ? [{ header: { 'in-reply-to': id } }, { header: { references: id } }]
    : []
  const to = emailOf(draft.to_email)
  const terms = [...thread, ...(bySender && to ? [{ from: to }] : [])]
  if (terms.length === 0) return null
  const since = new Date(draft.sent_at)
  since.setUTCHours(0, 0, 0, 0)
  return terms.length === 1 ? { since, ...terms[0] } : { since, or: terms }
}

/** Gmail's login and connection failures, in the owner's words. */
export function imapError(err: unknown): string {
  const e = err as {
    authenticationFailed?: boolean
    responseText?: string
    code?: string
    message?: string
  }
  if (
    e.authenticationFailed ||
    /AUTHENTICATIONFAILED|Invalid credentials/i.test(
      e.responseText ?? e.message ?? '',
    )
  )
    return 'Gmail rejected the login. Check GMAIL_APP_PASSWORD in .env is an app password for the Gmail address in Settings.'
  if (
    [
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ECONNRESET',
      'EAI_AGAIN',
    ].includes(e.code ?? '')
  )
    return 'Could not reach Gmail. Check the internet connection.'
  return `Gmail error: ${e.message ?? String(err)}`
}

let running: Promise<ReplyCheck> | null = null

/**
 * Checks Gmail for new replies to sent requests and reads them. Overlapping calls share
 * one check. Automatic calls within a minute of the last check are skipped.
 */
export function checkGmailReplies(opts: { force?: boolean } = {}) {
  running ??= run(opts.force ?? false).finally(() => {
    running = null
  })
  return running
}

async function run(force: boolean): Promise<ReplyCheck> {
  const settings = await getSettings()
  const skip = (reason: string): ReplyCheck => ({
    status: 'skipped',
    reason,
    checked_at: settings.replies_checked_at,
    new_replies: 0,
    read: 0,
    bounces: 0,
  })
  if (!settings.reply_scanning) return skip('Reading replies is turned off.')
  const login = sendingStatus(settings)
  if (settings.send_via !== 'gmail' || !login.ready)
    return skip(login.problem ?? 'Set up Gmail in Settings to read replies.')
  if (
    !force &&
    settings.replies_checked_at &&
    Date.now() - Date.parse(settings.replies_checked_at) < MIN_INTERVAL_MS
  )
    return skip('Checked less than a minute ago.')

  const since = new Date(Date.now() - WATCH_DAYS * 86_400_000).toISOString()
  // Only original requests: a reminder is sent in its request's thread and names it in
  // References, so replies to it are found, and tied to the request, through the request.
  const drafts = must(
    await db()
      .from('email_drafts')
      .select(
        'id, to_email, sent_at, provider_message_id, gmail_thread_id, send_error',
      )
      .not('sent_at', 'is', null)
      .is('follow_up_of', null)
      .gte('sent_at', since),
    'load sent requests',
  ) as Array<SentDraft>

  const checkedAt = new Date().toISOString()
  try {
    const { replies: found, bounces } =
      drafts.length === 0
        ? { replies: [], bounces: 0 }
        : settings.gmail
          ? await fetchRepliesApi(
              settings.gmail.email,
              settings.match_by_sender,
              drafts,
            )
          : await fetchReplies(settings, drafts)
    let read = 0
    for (const msg of found) {
      try {
        const res = await receiveInbound(msg)
        if (!('ignored' in res) && !('duplicate' in res)) read++
      } catch (err) {
        console.error(`[gmail] could not read reply ${msg.message_id}`, err)
      }
    }
    await record(checkedAt, null)
    if (found.length || bounces)
      console.info(
        `[gmail] ${found.length} new replies, ${read} read, ${bounces} bounces`,
      )
    return {
      status: 'checked',
      reason: null,
      checked_at: checkedAt,
      new_replies: found.length,
      read,
      bounces,
    }
  } catch (err) {
    const reason =
      err instanceof GmailReconnectError || err instanceof GmailApiError
        ? err.message
        : imapError(err)
    console.error('[gmail] reply check failed', err)
    await record(checkedAt, reason)
    return {
      status: 'failed',
      reason,
      checked_at: checkedAt,
      new_replies: 0,
      read: 0,
      bounces: 0,
    }
  }
}

async function record(at: string, error: string | null) {
  await db()
    .from('settings')
    .update({ replies_checked_at: at, replies_check_error: error })
    .eq('id', true)
}

/** Finds and downloads replies Shelfie has not seen yet, each tied to its request. */
async function fetchReplies(
  settings: Settings,
  drafts: Array<SentDraft>,
): Promise<{ replies: Array<InboundMessage>; bounces: number }> {
  const own = emailOf(settings.from_email)
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: settings.from_email!,
      pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s+/g, ''),
    },
    logger: false,
  })
  await client.connect()
  try {
    // "All Mail" also holds replies the owner has archived; INBOX if it is hidden.
    const boxes = await client.list()
    const box = boxes.find((b) => b.specialUse === '\\All')?.path ?? 'INBOX'
    const lock = await client.getMailboxLock(box, { readOnly: true })
    try {
      // uid -> request it answers. A thread match beats a sender match.
      const owner = new Map<number, string>()
      for (const d of drafts) {
        const query = replySearch(d, settings.match_by_sender)
        if (!query) continue
        const uids = await client.search(query, { uid: true })
        for (const uid of uids || []) if (!owner.has(uid)) owner.set(uid, d.id)
      }
      if (owner.size === 0) return { replies: [], bounces: 0 }

      // Skip messages already stored, without downloading them again.
      const heads = await client.fetchAll(
        [...owner.keys()].join(','),
        { uid: true, envelope: true },
        { uid: true },
      )
      const ids = heads
        .map((h) => h.envelope?.messageId)
        .filter((x): x is string => Boolean(x))
      const seen = new Set(
        ids.length
          ? (
              must(
                await db()
                  .from('inbound_emails')
                  .select('message_id')
                  .in('message_id', ids),
                'check stored replies',
              ) as Array<{ message_id: string }>
            ).map((r) => r.message_id)
          : [],
      )
      const fresh = heads.filter(
        (h) =>
          h.envelope?.messageId &&
          !seen.has(h.envelope.messageId) &&
          emailOf(h.envelope.from?.[0]?.address) !== own,
      )

      const replies: Array<InboundMessage> = []
      let bounces = 0
      for (const h of fresh) {
        const draft = drafts.find((d) => d.id === owner.get(h.uid))!
        const bounce = isBounce(h.envelope?.from?.[0]?.address)
        // A bounce already noted on its request is not downloaded again.
        if (bounce && draft.send_error?.startsWith('Not delivered')) continue
        // BODY.PEEK under the hood: reading does not mark the email as read in Gmail.
        const msg = await client.fetchOne(
          String(h.uid),
          { source: true },
          { uid: true },
        )
        if (!msg || !msg.source) continue
        if (bounce) {
          // Not a reply: note on the request which address Gmail could not deliver to.
          const mail = await simpleParser(msg.source)
          await db()
            .from('email_drafts')
            .update({ send_error: bounceNote(mail.text ?? '') })
            .eq('id', draft.id)
          bounces++
          continue
        }
        const parsed = await toInbound(msg.source, draft.id)
        if (parsed) replies.push(parsed)
      }
      return { replies, bounces }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

/** A raw email as the reader expects it. Null when it has no sender. */
export async function toInbound(
  source: Buffer,
  draftId: string,
): Promise<InboundMessage | null> {
  const mail = await simpleParser(source)
  const from = mail.from?.value[0]
  const fromEmail = emailOf(from?.address)
  if (!fromEmail) return null
  const list = (a: typeof mail.to) =>
    (Array.isArray(a) ? a : a ? [a] : [])
      .flatMap((x) => x.value)
      .map((x) => x.address)
      .filter((x): x is string => Boolean(x))
  const to = list(mail.to)
  return {
    message_id:
      mail.messageId ??
      `${fromEmail}|${mail.date?.toISOString() ?? ''}|${mail.subject ?? ''}`,
    from_email: fromEmail,
    from_name: from?.name.trim() || null,
    to,
    recipients: [...to, ...list(mail.cc)],
    subject: mail.subject ?? '',
    text: (mail.text ?? '').trim().slice(0, MAX_BODY_CHARS),
    reply_text: null,
    received_at: (mail.date ?? new Date()).toISOString(),
    mailbox_hash: null,
    attachments: mail.attachments.map((a) => ({
      name: a.filename ?? 'attachment',
      type: a.contentType,
      bytes: new Uint8Array(a.content),
    })),
    draft_id: draftId,
  }
}

// --- Gmail API (connected with Google) -------------------------------------------------
// threads.get per request rather than the history API: it needs no stored historyId (which
// Gmail expires after about a week, forcing a full resync anyway), it reads exactly the
// threads Shelfie started and nothing else, and it costs one call per watched request.

/**
 * The Gmail thread of a request sent before Gmail was connected (over SMTP), found once by
 * its Message-ID and remembered. Null when it is not in this mailbox.
 */
async function threadOf(d: SentDraft): Promise<string | null> {
  if (d.gmail_thread_id) return d.gmail_thread_id
  const id = d.provider_message_id?.replace(/^<|>$/g, '')
  if (!id || !id.includes('@')) return null
  const hit = (await searchMessages(`rfc822msgid:${id}`, 1)).at(0)
  if (!hit) return null
  await db()
    .from('email_drafts')
    .update({ gmail_thread_id: hit.threadId })
    .eq('id', d.id)
  return hit.threadId
}

/** Finds and downloads replies Shelfie has not seen yet, each tied to its request. */
async function fetchRepliesApi(
  own: string,
  bySender: boolean,
  drafts: Array<SentDraft>,
): Promise<{ replies: Array<InboundMessage>; bounces: number }> {
  // Gmail message id -> the message and the request it answers. A thread match beats a
  // sender match. Sender matches only have headers until they turn out to be new.
  const found = new Map<
    string,
    { message: GmailMessage; draft: SentDraft; full: boolean }
  >()
  for (const d of drafts) {
    const thread = await threadOf(d)
    if (!thread) continue
    for (const m of (await getThread(thread)) ?? [])
      if (!found.has(m.id))
        found.set(m.id, { message: m, draft: d, full: true })
  }
  if (bySender)
    for (const d of drafts) {
      const to = emailOf(d.to_email)
      if (!to) continue
      const after = Math.floor(Date.parse(d.sent_at) / 1000)
      for (const hit of await searchMessages(`from:${to} after:${after}`))
        if (!found.has(hit.id))
          found.set(hit.id, {
            message: await messageHeaders(hit.id, ['Message-ID', 'From']),
            draft: d,
            full: false,
          })
    }
  if (found.size === 0) return { replies: [], bounces: 0 }

  // Skip messages already stored, without downloading their attachments.
  const keys = [...found.values()].map((f) => replyKey(f.message))
  const seen = new Set(
    (
      must(
        await db()
          .from('inbound_emails')
          .select('message_id')
          .in('message_id', keys),
        'check stored replies',
      ) as Array<{ message_id: string }>
    ).map((r) => r.message_id),
  )

  const replies: Array<InboundMessage> = []
  let bounces = 0
  for (const f of found.values()) {
    const pick = newReplies([f.message], {
      own,
      sentAt: f.draft.sent_at,
      seen,
    }).at(0)
    if (!pick) continue
    // A bounce already noted on its request is not downloaded again.
    if (pick.bounce && f.draft.send_error?.startsWith('Not delivered')) continue
    const message = f.full ? f.message : await getMessage(f.message.id)
    if (pick.bounce) {
      // Not a reply: note on the request which address Gmail could not deliver to.
      await db()
        .from('email_drafts')
        .update({ send_error: bounceNote(bodyText(message)) })
        .eq('id', f.draft.id)
      bounces++
      continue
    }
    const files = new Map<string, Uint8Array>()
    for (const a of attachmentRefs(message))
      if (a.attachmentId)
        files.set(a.partId, await getAttachment(message.id, a.attachmentId))
    const inbound = gmailToInbound(message, files, f.draft.id)
    if (inbound) replies.push(inbound)
  }
  return { replies, bounces }
}

/** Recent requests Gmail reported it could not deliver, for the Replies list. */
export async function deliveryProblems() {
  const since = new Date(Date.now() - WATCH_DAYS * 86_400_000).toISOString()
  return must(
    await db()
      .from('email_drafts')
      .select('id, subject, sent_at, send_error, suppliers(name)')
      .like('send_error', 'Not delivered%')
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(5),
    'load delivery problems',
  ) as unknown as Array<{
    id: string
    subject: string | null
    sent_at: string
    send_error: string
    suppliers: { name: string } | null
  }>
}
