// Sending request emails from Shelfie, so the owner never leaves the app. Two ways out:
// - Gmail: the owner's own account over SMTP with an app password (GMAIL_APP_PASSWORD).
//   The email comes from their real address and lands in their Gmail Sent folder.
// - Postmark: for an address on the owner's own domain (POSTMARK_SERVER_TOKEN).
// Passwords and tokens live in .env; the choice and the From address are in Settings.
import nodemailer from 'nodemailer'
import { inboundAddressFor } from './inbound'
import { getSettings, replyCc, sendingStatus } from './settings.server'
import type { Settings } from './settings.server'
import { db, mustOne } from './supabase.server'

/** '"Aoife at The Corner Café" <orders@example.ie>', quoted so commas in names are safe. */
export function fromHeader(s: Settings): string {
  const name = `${s.owner_name} at ${s.business_name}`.replace(/["\\]/g, '')
  return `"${name}" <${s.from_email}>`
}

interface Outgoing {
  from: string
  to: string
  cc: string | null
  bcc: string | null
  subject: string
  text: string
}

// --- Gmail -----------------------------------------------------------------------------

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

async function sendWithGmail(s: Settings, m: Outgoing): Promise<string | null> {
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
    })
    return info.messageId
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

async function sendWithPostmark(m: Outgoing): Promise<string | null> {
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
  return out.MessageID ?? null
}

// --- Sending a draft -------------------------------------------------------------------

/**
 * Sends a drafted request and records it. The CC (Shelfie's reply address) and BCC
 * (the owner's copy) are worked out here from Settings, never taken from the browser.
 */
export async function sendDraft(
  id: string,
  edits: { to: string; subject: string; body: string },
): Promise<{ sent_at: string; to: string }> {
  const draft = mustOne(
    await db()
      .from('email_drafts')
      .select('id, sent_at')
      .eq('id', id)
      .maybeSingle<{ id: string; sent_at: string | null }>(),
    'load draft',
  )
  if (draft.sent_at) throw new SendError('This email was already sent.')

  const settings = await getSettings()
  const status = sendingStatus(settings)
  if (!status.ready) throw new SendError(status.problem!)

  const message: Outgoing = {
    from: fromHeader(settings),
    to: edits.to,
    cc: replyCc(settings, inboundAddressFor, id),
    bcc: settings.bcc_email,
    subject: edits.subject,
    text: edits.body,
  }

  let messageId: string | null
  try {
    messageId =
      settings.send_via === 'gmail'
        ? await sendWithGmail(settings, message)
        : await sendWithPostmark(message)
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
        provider_message_id: messageId,
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
