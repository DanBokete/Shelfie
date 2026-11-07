// Loads the emails that still need something (lib/pending-emails.ts sorts them), and the
// small writes the Emails page makes. Reading only: no Claude calls here.
import { inboundAddressFor } from './inbound'
import {
  groupPendingEmails,
  isDeliveryProblem,
  productNames,
} from './pending-emails'
import type { DraftRow, PendingEmails, ReplyRow } from './pending-emails'
import { reminderEmail } from './reminders'
import { getSettings, replyCc, sendingStatus } from './settings.server'
import { db, must, mustOne } from './supabase.server'

type Joined<T> = T & { suppliers: { name: string } | null }

async function load(): Promise<{
  drafts: Array<DraftRow>
  replies: Array<ReplyRow>
  replyByDays: number
}> {
  const [drafts, replies, settings] = await Promise.all([
    db()
      .from('email_drafts')
      .select(
        'id, kind, to_email, subject, body, items, created_at, sent_at, send_error, follow_up_of, suppliers(name)',
      )
      .order('created_at', { ascending: false }),
    db()
      .from('inbound_emails')
      .select(
        'id, draft_id, status, error, from_email, from_name, subject, received_at, suppliers(name)',
      )
      .order('received_at', { ascending: false }),
    getSettings(),
  ])
  const flat = <T>({ suppliers, ...r }: Joined<T>) => ({
    ...(r as T),
    supplier_name: suppliers?.name ?? null,
  })
  return {
    drafts: (
      must(drafts, 'load emails') as unknown as Array<
        Joined<Omit<DraftRow, 'supplier_name'>>
      >
    ).map(flat),
    replies: (
      must(replies, 'load replies') as unknown as Array<
        Joined<Omit<ReplyRow, 'supplier_name'>>
      >
    ).map(flat),
    replyByDays: settings.reply_by_days,
  }
}

export async function pendingEmails(): Promise<
  PendingEmails & { reply_by_days: number }
> {
  const { drafts, replies, replyByDays } = await load()
  return {
    ...groupPendingEmails(drafts, replies, { replyByDays, now: Date.now() }),
    reply_by_days: replyByDays,
  }
}

/** For the nav badge and the Home card. */
export async function pendingCounts() {
  return (await pendingEmails()).counts
}

/**
 * A saved request, ready for the email window: what it says, and how it will be sent.
 * A request Gmail could not deliver opens too, so the owner can fix the address and send it
 * again.
 */
export async function savedDraft(id: string) {
  const row = mustOne(
    await db()
      .from('email_drafts')
      .select('id, to_email, subject, body, sent_at, send_error, follow_up_of')
      .eq('id', id)
      .maybeSingle<{
        id: string
        to_email: string | null
        subject: string | null
        body: string | null
        sent_at: string | null
        send_error: string | null
        follow_up_of: string | null
      }>(),
    'load email',
  )
  if (row.sent_at && !isDeliveryProblem(row.send_error))
    throw new Error('This email was already sent.')
  const settings = await getSettings()
  return {
    id: row.id,
    subject: row.subject ?? '',
    body: row.body ?? '',
    to: row.to_email ?? '',
    follow_up: Boolean(row.follow_up_of),
    // A reminder's reply belongs to the request it follows up.
    reply_cc: replyCc(settings, inboundAddressFor, row.follow_up_of ?? row.id),
    reply_bcc: settings.bcc_email,
    sending: sendingStatus(settings),
  }
}

/**
 * Deletes a draft, a request that failed to send, or one Gmail could not deliver. A request
 * that went out is kept: replies are tied to it.
 */
export async function discardEmail(id: string) {
  const gone = must(
    await db()
      .from('email_drafts')
      .delete()
      .eq('id', id)
      .or('sent_at.is.null,send_error.like."Not delivered*"')
      .select('id'),
    'discard email',
  ) as Array<{ id: string }>
  if (gone.length === 0)
    throw new Error('This email was sent, so it is kept with its replies.')
}

/**
 * The reminder draft for a sent request with no reply: a short follow-up from a fixed
 * template, sent later as a reply in the request's thread. An unsent reminder already
 * drafted for it is reused, so pressing the button twice does not make two.
 */
export async function draftReminder(
  requestId: string,
): Promise<{ id: string }> {
  const request = mustOne(
    await db()
      .from('email_drafts')
      .select(
        'id, kind, supplier_id, price_observation_id, to_email, subject, body, items, sent_at, send_error, follow_up_of, suppliers(name)',
      )
      .eq('id', requestId)
      .maybeSingle<
        Joined<{
          id: string
          kind: 'match' | 'quote'
          supplier_id: string | null
          price_observation_id: string | null
          to_email: string | null
          subject: string | null
          body: string | null
          items: unknown
          sent_at: string | null
          send_error: string | null
          follow_up_of: string | null
        }>
      >(),
    'load request',
  )
  if (request.follow_up_of)
    throw new Error('This is a reminder. Send a reminder from the request.')
  if (!request.sent_at || request.send_error)
    throw new Error('Only a sent request can have a reminder.')

  const existing = must(
    await db()
      .from('email_drafts')
      .select('id')
      .eq('follow_up_of', requestId)
      .is('sent_at', null)
      .is('send_error', null)
      .order('created_at', { ascending: false })
      .limit(1),
    'find reminder',
  ) as Array<{ id: string }>
  if (existing[0]) return existing[0]

  const settings = await getSettings()
  const email = reminderEmail({
    supplier_name: request.suppliers?.name ?? null,
    owner_name: settings.owner_name,
    business_name: settings.business_name,
    kind: request.kind,
    subject: request.subject,
    body: request.body,
    products: productNames(request.items),
    sent_at: request.sent_at,
  })
  return mustOne(
    await db()
      .from('email_drafts')
      .insert({
        kind: request.kind,
        supplier_id: request.supplier_id,
        price_observation_id: request.price_observation_id,
        to_email: request.to_email,
        subject: email.subject,
        body: email.body,
        items: request.items,
        status: 'draft',
        writer: 'template',
        follow_up_of: request.id,
      })
      .select('id')
      .maybeSingle<{ id: string }>(),
    'save reminder',
  )
}
