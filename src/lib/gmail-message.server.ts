// Emails in and out of the Gmail API, with no network: the raw RFC 822 message
// users.messages.send takes, and a Gmail message resource (format=full) turned into the
// InboundMessage the reply reader takes, the same one the IMAP path builds.
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
import { convert as htmlToText } from 'html-to-text'
import libmime from 'libmime'
import addressparser from 'nodemailer/lib/addressparser'
import MailComposer from 'nodemailer/lib/mail-composer'
import { emailOf } from './inbound'
import type { InboundMessage } from './inbound.server'

const MAX_BODY_CHARS = 20_000

// --- Sending ---------------------------------------------------------------------------

export interface Outgoing {
  from: string
  to: string
  cc: string | null
  bcc: string | null
  subject: string
  text: string
}

/**
 * The email as users.messages.send takes it: RFC 822, base64url. Built by nodemailer, as
 * the SMTP path is. Bcc stays in the headers: Gmail reads the recipients from them and
 * removes Bcc before delivering.
 */
export async function rawMessage(m: Outgoing): Promise<string> {
  const node = new MailComposer({
    from: m.from,
    to: m.to,
    cc: m.cc ?? undefined,
    bcc: m.bcc ?? undefined,
    subject: m.subject,
    text: m.text,
  }).compile()
  node.keepBcc = true
  return (await node.build()).toString('base64url')
}

// --- Receiving -------------------------------------------------------------------------

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: Array<GmailHeader>
  body?: { attachmentId?: string; size?: number; data?: string }
  parts?: Array<GmailPart>
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: Array<string>
  /** Milliseconds since 1970, as a string. */
  internalDate?: string
  payload?: GmailPart
}

export function header(
  part: GmailPart | undefined,
  name: string,
): string | null {
  const lower = name.toLowerCase()
  const h = part?.headers?.find((x) => x.name.toLowerCase() === lower)
  return h ? h.value : null
}

function addresses(value: string | null) {
  if (!value) return []
  return addressparser(value, { flatten: true })
    .filter((a) => a.address)
    .map((a) => ({ address: a.address, name: libmime.decodeWords(a.name) }))
}

/** The id the reader stores the reply under: its Message-ID, as the IMAP path uses. */
export function replyKey(msg: GmailMessage): string {
  const id = header(msg.payload, 'Message-ID')?.trim()
  return id || `gmail:${msg.id}`
}

/** An attachment of the message: its bytes are inline (data) or fetched by attachmentId. */
export interface AttachmentRef {
  partId: string
  attachmentId: string | null
  data: string | null
  name: string
  type: string
}

function isAttachment(p: GmailPart): boolean {
  const disposition = header(p, 'Content-Disposition') ?? ''
  return Boolean(p.filename) || /^\s*attachment/i.test(disposition)
}

function walk(part: GmailPart | undefined, out: Array<GmailPart> = []) {
  if (!part) return out
  out.push(part)
  for (const p of part.parts ?? []) walk(p, out)
  return out
}

export function attachmentRefs(msg: GmailMessage): Array<AttachmentRef> {
  return walk(msg.payload)
    .filter(
      (p) =>
        !p.mimeType?.startsWith('multipart/') &&
        isAttachment(p) &&
        (p.body?.attachmentId || p.body?.data),
    )
    .map((p, i) => ({
      partId: p.partId ?? String(i),
      attachmentId: p.body?.attachmentId ?? null,
      data: p.body?.data ?? null,
      name: libmime.decodeWords(p.filename || 'attachment'),
      type: (p.mimeType || 'application/octet-stream').toLowerCase(),
    }))
}

function decodeText(p: GmailPart): string {
  const bytes = Buffer.from(p.body?.data ?? '', 'base64url')
  // The part's bytes are in its own charset, as sent.
  const charset =
    /charset="?([^";\s]+)"?/i.exec(header(p, 'Content-Type') ?? '')?.[1] ??
    'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** The body as plain text: the text/plain part, else the HTML part as text. */
export function bodyText(msg: GmailMessage): string {
  const parts = walk(msg.payload).filter(
    (p) => !isAttachment(p) && p.body?.data,
  )
  const plain = parts.find((p) => p.mimeType === 'text/plain')
  if (plain) return decodeText(plain)
  const html = parts.find((p) => p.mimeType === 'text/html')
  if (html) return htmlToText(decodeText(html), { wordwrap: false })
  return ''
}

/**
 * A Gmail message as the reader expects it, with its attachments' bytes by partId. Null
 * when it has no sender.
 */
export function gmailToInbound(
  msg: GmailMessage,
  files: Map<string, Uint8Array>,
  draftId: string,
): InboundMessage | null {
  const p = msg.payload
  const from = addresses(header(p, 'From')).at(0)
  const fromEmail = emailOf(from?.address)
  if (!from || !fromEmail) return null
  const to = addresses(header(p, 'To')).map((a) => a.address)
  const cc = addresses(header(p, 'Cc')).map((a) => a.address)
  const dated = Date.parse(header(p, 'Date') ?? '')
  const received = Number.isFinite(dated)
    ? new Date(dated)
    : msg.internalDate
      ? new Date(Number(msg.internalDate))
      : new Date()
  return {
    message_id: replyKey(msg),
    from_email: fromEmail,
    from_name: from.name.trim() || null,
    to,
    recipients: [...to, ...cc],
    subject: libmime.decodeWords(header(p, 'Subject') ?? ''),
    text: bodyText(msg).trim().slice(0, MAX_BODY_CHARS),
    reply_text: null,
    received_at: received.toISOString(),
    mailbox_hash: null,
    attachments: attachmentRefs(msg).flatMap((a) => {
      const bytes =
        files.get(a.partId) ??
        (a.data ? new Uint8Array(Buffer.from(a.data, 'base64url')) : null)
      return bytes ? [{ name: a.name, type: a.type, bytes }] : []
    }),
    draft_id: draftId,
  }
}

/** Labels of messages that are not a supplier's reply waiting to be read. */
const NOT_REPLIES = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH'])
/** Clocks differ: a reply a few minutes "before" the request is still a reply. */
const CLOCK_SLACK_MS = 5 * 60_000

/**
 * The messages in a request's thread that are new replies for Shelfie: not from the owner,
 * not sent, drafted, spam or deleted, not older than the request, and not read before.
 * Gmail's "could not deliver" notices are flagged as bounces.
 */
export function newReplies(
  messages: Array<GmailMessage>,
  ctx: { own: string; sentAt: string; seen: Set<string> },
): Array<{ message: GmailMessage; bounce: boolean }> {
  const own = emailOf(ctx.own)
  const after = Date.parse(ctx.sentAt) - CLOCK_SLACK_MS
  return messages.flatMap((m) => {
    const from = emailOf(addresses(header(m.payload, 'From')).at(0)?.address)
    if (!from || from === own) return []
    if (m.labelIds?.some((l) => NOT_REPLIES.has(l))) return []
    if (m.internalDate && Number(m.internalDate) < after) return []
    if (ctx.seen.has(replyKey(m))) return []
    return [{ message: m, bounce: isBounce(from) }]
  })
}

/** Gmail's "could not deliver" notices come from these addresses. They are not replies. */
export function isBounce(from: string | null | undefined): boolean {
  const email = emailOf(from)
  if (!email) return false
  const local = email.slice(0, email.indexOf('@'))
  return local === 'mailer-daemon' || local === 'postmaster'
}

/** "Not delivered to x@example.ie: address not found." from a bounce's text. */
export function bounceNote(text: string): string {
  const to =
    /(?:wasn't|was not) delivered to\s+([^\s@]+@[^\s]+?)(?=[\s,;]|\.(?:\s|$)|$)/i.exec(
      text,
    )?.[1]
  const why =
    /couldn't be found|could not be found|does not exist|no such user/i.test(
      text,
    )
      ? 'address not found'
      : null
  return `Not delivered${to ? ` to ${to}` : ''}${why ? `: ${why}` : ''}.`
}
