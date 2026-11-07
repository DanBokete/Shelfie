// Sending request emails from Shelfie, so the owner never leaves the app. Three ways out:
// - Gmail, connected in Settings ("Connect Gmail"): the Gmail API with the owner's Google
//   sign-in (lib/google-auth.server.ts). Replies are then read from the request's thread.
// - Gmail with an app password (GMAIL_APP_PASSWORD) over SMTP, when Gmail is not connected.
//   Either way the email comes from their real address and lands in their Gmail Sent folder.
// - Postmark: for an address on the owner's own domain (POSTMARK_SERVER_TOKEN).
// Passwords and tokens live in .env; the choice and the From address are in Settings.
import nodemailer from 'nodemailer'
import { GmailApiError, messageHeaders, sendMessage } from './gmail-api.server'
import { header, rawMessage } from './gmail-message.server'
import type { Outgoing, Thread } from './gmail-message.server'
import { GmailReconnectError } from './google-auth.server'
import { inboundAddressFor } from './inbound'
import { isDeliveryProblem } from './pending-emails'
import { threadHeaders } from './reminders'
import type { SentInThread } from './reminders'
import {
  getSettings,
  replyCc,
  senderEmail,
  sendingStatus,
} from './settings.server'
import type { Settings } from './settings.server'
import { db, must, mustOne } from './supabase.server'

/** '"Aoife at The Corner Café" <orders@example.ie>', quoted so commas in names are safe. */
export function fromHeader(s: Settings): string {
  const name = `${s.owner_name} at ${s.business_name}`.replace(/["\\]/g, '')
  return `"${name}" <${senderEmail(s)}>`
}

/**
 * The email for a draft: the owner's edits, plus the CC (Shelfie's reply address) and BCC
 * (the owner's copy) from Settings, never from the browser. `replyTo` is the request replies
 * belong to: the draft itself, or for a reminder the request it follows up, which also puts
 * the reminder in that request's thread.
 */
export function composeOutgoing(
  s: Settings,
  replyTo: string,
  edits: { to: string; subject: string; body: string },
  thread?: Thread | null,
): Outgoing {
  return {
    from: fromHeader(s),
    to: edits.to,
    cc: replyCc(s, inboundAddressFor, replyTo),
    bcc: s.bcc_email,
    subject: edits.subject,
    text: edits.body,
    ...(thread ? { thread } : {}),
  }
}

/**
 * The thread a reminder replies in: the request it follows up and the reminders already
 * sent for it. Null when there are no Message-IDs to reply to (then it goes as a new email).
 */
async function reminderThread(requestId: string): Promise<Thread | null> {
  const cols = 'sent_at, provider_message_id, gmail_thread_id'
  const request = mustOne(
    await db()
      .from('email_drafts')
      .select(`id, ${cols}`)
      .eq('id', requestId)
      .maybeSingle<SentInThread & { id: string; sent_at: string | null }>(),
    'load the request this reminder follows up',
  )
  if (!request.sent_at)
    throw new SendError(
      'The request this reminder follows up was never sent. Send that one instead.',
    )
  const reminders = must(
    await db()
      .from('email_drafts')
      .select(cols)
      .eq('follow_up_of', requestId)
      .not('sent_at', 'is', null),
    'load sent reminders',
  ) as Array<SentInThread>
  return threadHeaders([{ ...request, sent_at: request.sent_at }, ...reminders])
}

/** What a provider tells us about a sent email. */
interface Sent {
  /** The RFC Message-ID (Gmail), or Postmark's id. */
  messageId: string | null
  gmailMessageId?: string
  gmailThreadId?: string
}

// --- Gmail API (connected with Google) -------------------------------------------------

async function sendWithGmailApi(m: Outgoing): Promise<Sent> {
  let sent: { id: string; threadId: string }
  try {
    sent = await sendMessage(await rawMessage(m), m.thread?.gmailThreadId)
  } catch (err) {
    if (err instanceof GmailReconnectError || err instanceof GmailApiError)
      throw new SendError(err.message)
    throw err
  }
  // Sent: from here nothing may fail the send. Gmail's message and thread ids find the
  // replies; the Message-ID is kept too, so the app-password path can find them as well.
  const head = await messageHeaders(sent.id, ['Message-ID']).catch(
    (err: unknown) => {
      console.warn('[gmail] sent, but could not read its Message-ID', err)
      return null
    },
  )
  return {
    messageId: header(head?.payload, 'Message-ID'),
    gmailMessageId: sent.id,
    gmailThreadId: sent.threadId,
  }
}

// --- Gmail app password (SMTP) ---------------------------------------------------------

/** Gmail's failures the owner can fix, in their words. Null for anything else. */
export function gmailError(err: {
  code?: string
  responseCode?: number
  response?: string
}): string | null {
  if (
    err.code === 'EAUTH' ||
    err.responseCode === 535 ||
    err.responseCode === 534
  )
    return 'Gmail rejected the login. Check GMAIL_APP_PASSWORD in .env is an app password for the Gmail address in Settings.'
  if (err.response && /daily user sending limit/i.test(err.response))
    return 'Gmail’s daily sending limit is reached. Try again tomorrow.'
  if (err.code === 'EENVELOPE')
    return 'Gmail would not accept the To address. Check it is correct.'
  if (
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNECTION' ||
    err.code === 'ESOCKET' ||
    err.code === 'EDNS'
  )
    return 'Could not reach Gmail. Check the internet connection and try again.'
  return null
}

async function sendWithGmail(s: Settings, m: Outgoing): Promise<Sent> {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: s.from_email!,
      // Google shows app passwords in groups of four: 'abcd efgh ijkl mnop'.
      pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s+/g, ''),
    },
  })
  try {
    const info = await transport.sendMail({
      from: m.from,
      to: m.to,
      cc: m.cc ?? undefined,
      bcc: m.bcc ?? undefined,
      subject: m.subject,
      text: m.text,
      inReplyTo: m.thread?.inReplyTo,
      references: m.thread?.references,
    })
    return { messageId: info.messageId }
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; response?: string }
    throw new SendError(
      gmailError(e) ??
        `Gmail error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// --- Postmark --------------------------------------------------------------------------

const POSTMARK_URL = 'https://api.postmarkapp.com/email'

// Postmark's error codes that the owner can fix, in their words.
// https://postmarkapp.com/developer/api/overview#error-codes
const POSTMARK_ERRORS: Record<number, string> = {
  10: 'Postmark rejected the server token. Check POSTMARK_SERVER_TOKEN in .env.',
  300: 'Postmark could not send this email. Check the To address.',
  400: 'The From address in Settings is not a sender in Postmark. Add it under Sender Signatures.',
  401: 'The From address in Settings is not confirmed in Postmark yet. Click the link Postmark emailed to it.',
  406: 'This address has bounced or unsubscribed before, so Postmark will not send to it.',
  412: 'Your Postmark account is waiting for approval, so it can only send to your own domain. Request approval in Postmark.',
}

interface PostmarkResponse {
  ErrorCode: number
  Message: string
  MessageID?: string
}

async function sendWithPostmark(m: Outgoing): Promise<Sent> {
  const res = await fetch(POSTMARK_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN!,
    },
    body: JSON.stringify({
      From: m.from,
      To: m.to,
      Cc: m.cc ?? undefined,
      Bcc: m.bcc ?? undefined,
      Subject: m.subject,
      TextBody: m.text,
      Headers: m.thread
        ? [
            { Name: 'In-Reply-To', Value: m.thread.inReplyTo },
            { Name: 'References', Value: m.thread.references.join(' ') },
          ]
        : undefined,
      MessageStream: 'outbound',
      Tag: 'supplier-request',
    }),
  }).catch((err: unknown) => {
    throw new SendError(
      `Could not reach Postmark: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  const out = (await res.json().catch(() => null)) as PostmarkResponse | null
  if (!res.ok || !out || out.ErrorCode !== 0)
    throw new SendError(
      (out && POSTMARK_ERRORS[out.ErrorCode]) ??
        `Postmark error: ${out?.Message ?? `HTTP ${res.status}`}`,
    )
  return { messageId: out.MessageID ?? null }
}

// --- Sending a draft -------------------------------------------------------------------

/** Sends a drafted request and records it. */
export async function sendDraft(
  id: string,
  edits: { to: string; subject: string; body: string },
): Promise<{ sent_at: string; to: string }> {
  const draft = mustOne(
    await db()
      .from('email_drafts')
      .select('id, sent_at, send_error, follow_up_of')
      .eq('id', id)
      .maybeSingle<{
        id: string
        sent_at: string | null
        send_error: string | null
        follow_up_of: string | null
      }>(),
    'load draft',
  )
  // A request Gmail could not deliver can go again, to a corrected address.
  if (draft.sent_at && !isDeliveryProblem(draft.send_error))
    throw new SendError('This email was already sent.')

  const settings = await getSettings()
  const status = sendingStatus(settings)
  if (!status.ready) throw new SendError(status.problem!)

  const replyTo = draft.follow_up_of ?? id
  const thread = draft.follow_up_of
    ? await reminderThread(draft.follow_up_of)
    : null
  const message = composeOutgoing(settings, replyTo, edits, thread)

  let sent: Sent
  try {
    sent =
      settings.send_via !== 'gmail'
        ? await sendWithPostmark(message)
        : settings.gmail
          ? await sendWithGmailApi(message)
          : await sendWithGmail(settings, message)
  } catch (err) {
    if (err instanceof SendError)
      await db()
        .from('email_drafts')
        .update({ send_error: err.message })
        .eq('id', id)
    throw err
  }

  const sentAt = new Date().toISOString()
  mustOne(
    await db()
      .from('email_drafts')
      .update({
        status: 'sent',
        sent_at: sentAt,
        provider_message_id: sent.messageId,
        gmail_message_id: sent.gmailMessageId ?? null,
        gmail_thread_id: sent.gmailThreadId ?? null,
        send_error: null,
        to_email: edits.to,
        subject: edits.subject,
        body: edits.body,
      })
      .eq('id', id)
      .select('id')
      .maybeSingle(),
    'record sent email',
  )
  return { sent_at: sentAt, to: edits.to }
}

/** A sending problem the owner can act on; shown as is. */
export class SendError extends Error {}
