// Which emails still need something from the owner, for the Emails page, the nav badge and
// the Home card. Pure: rows in, sections out, so it is tested without a database.

const DAY_MS = 86_400_000

/** A request as stored in email_drafts, with its supplier's name. */
export interface DraftRow {
  id: string
  kind: 'match' | 'quote'
  supplier_name: string | null
  to_email: string | null
  subject: string | null
  body: string | null
  items: unknown
  created_at: string
  sent_at: string | null
  send_error: string | null
  /** A reminder: the request it follows up. */
  follow_up_of: string | null
}

/** A reply as stored in inbound_emails. */
export interface ReplyRow {
  id: string
  draft_id: string | null
  status: 'received' | 'processed' | 'failed' | 'unmatched'
  error: string | null
  from_email: string
  from_name: string | null
  subject: string | null
  received_at: string
  supplier_name: string | null
}

export interface PendingDraft {
  id: string
  kind: 'match' | 'quote'
  supplier_name: string | null
  to_email: string | null
  subject: string | null
  body: string | null
  /** Product names the email is about. */
  products: Array<string>
  created_at: string
  sent_at: string | null
  /** A reminder: the request it follows up. */
  follow_up_of: string | null
}

export interface WaitingEmail extends PendingDraft {
  sent_at: string
  /** Whole days since it was sent. */
  days: number
  /** Reminders sent for it, and when the latest went. */
  reminders: number
  last_reminder_at: string | null
  /**
   * No reply after the reply-by days in Settings, counted from the latest email sent: a
   * reminder gives the supplier that long again.
   */
  overdue: boolean
}

export interface FailedEmail extends PendingDraft {
  /** What went wrong, in the owner's words. */
  reason: string
  /** Sent, but Gmail said it could not deliver it (as opposed to never sent). */
  bounced: boolean
}

export interface ReviewReply {
  id: string
  status: 'failed' | 'unmatched'
  /** What the owner has to do, in their words. */
  reason: string
  from: string
  subject: string | null
  received_at: string
  supplier_name: string | null
}

export interface PendingEmails {
  waiting: Array<WaitingEmail>
  drafts: Array<PendingDraft>
  failed: Array<FailedEmail>
  review: Array<ReviewReply>
  counts: PendingCounts
}

export interface PendingCounts {
  waiting: number
  overdue: number
  drafts: number
  failed: number
  review: number
  /** What the nav badge shows: everything the owner has to act on now. */
  action: number
}

/** Product names in a draft's items: "Ask to match" has product_name, a quote has product. */
export function productNames(items: unknown): Array<string> {
  if (!Array.isArray(items)) return []
  const names: Array<string> = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const o = it as { product_name?: unknown; product?: unknown }
    const name = typeof o.product_name === 'string' ? o.product_name : o.product
    if (typeof name === 'string' && name.trim() && !names.includes(name))
      names.push(name)
  }
  return names
}

/** Whole days between two instants, never negative. */
export function daysSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS))
}

/** The note Gmail's "could not deliver" notice leaves on a sent request (see bounceNote). */
export function isDeliveryProblem(sendError: string | null): boolean {
  return Boolean(sendError?.startsWith('Not delivered'))
}

/**
 * Replies the owner has to deal with. Today: replies Shelfie could not tie to a request
 * (unmatched) or could not read (failed). When reviewing prices from a reply lands, its
 * waiting reviews plug in here.
 */
export function repliesToReview(replies: Array<ReplyRow>): Array<ReviewReply> {
  const out: Array<ReviewReply> = []
  for (const r of replies) {
    if (r.status !== 'unmatched' && r.status !== 'failed') continue
    out.push({
      id: r.id,
      status: r.status,
      reason:
        r.status === 'unmatched'
          ? 'Shelfie could not tell which supplier this is from. Pick the supplier.'
          : r.error
            ? `Shelfie could not read it: ${r.error}`
            : 'Shelfie could not read it. Try again.',
      from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email,
      subject: r.subject,
      received_at: r.received_at,
      supplier_name: r.supplier_name,
    })
  }
  return out.sort(newest((r) => r.received_at))
}

function newest<T>(at: (x: T) => string) {
  return (a: T, b: T) => Date.parse(at(b)) - Date.parse(at(a))
}

function base(d: DraftRow): PendingDraft {
  return {
    id: d.id,
    kind: d.kind,
    supplier_name: d.supplier_name,
    to_email: d.to_email,
    subject: d.subject,
    body: d.body,
    products: productNames(d.items),
    created_at: d.created_at,
    sent_at: d.sent_at,
    follow_up_of: d.follow_up_of,
  }
}

/**
 * Puts every email in at most one section:
 * - failed: a send error, or sent but Gmail could not deliver it;
 * - waiting: a sent request with no reply tied to it yet (any reply counts, read or not).
 *   A sent reminder is not listed on its own: it counts on the request it follows up;
 * - drafts: never sent and no send error, reminders included.
 * Replies to review come from the replies alone. Each section is newest first.
 */
export function groupPendingEmails(
  drafts: Array<DraftRow>,
  replies: Array<ReplyRow>,
  opts: { replyByDays: number; now: number },
): PendingEmails {
  // A reply tied to a reminder answers the request too.
  const rootOf = new Map(
    drafts.map((d) => [d.id, d.follow_up_of ?? d.id] as const),
  )
  const answered = new Set(
    replies
      .map((r) => r.draft_id && (rootOf.get(r.draft_id) ?? r.draft_id))
      .filter((x): x is string => Boolean(x)),
  )
  const sentReminders = new Map<string, Array<string>>()
  for (const d of drafts)
    if (d.follow_up_of && d.sent_at && !d.send_error)
      sentReminders.set(d.follow_up_of, [
        ...(sentReminders.get(d.follow_up_of) ?? []),
        d.sent_at,
      ])

  const waiting: Array<WaitingEmail> = []
  const unsent: Array<PendingDraft> = []
  const failed: Array<FailedEmail> = []

  for (const d of drafts) {
    if (d.send_error) {
      failed.push({
        ...base(d),
        reason: d.send_error,
        bounced: Boolean(d.sent_at) && isDeliveryProblem(d.send_error),
      })
    } else if (d.sent_at) {
      if (d.follow_up_of || answered.has(d.id)) continue
      const reminders = (sentReminders.get(d.id) ?? []).sort(
        (a, b) => Date.parse(a) - Date.parse(b),
      )
      const last = reminders.at(-1) ?? null
      waiting.push({
        ...base(d),
        sent_at: d.sent_at,
        days: daysSince(d.sent_at, opts.now),
        reminders: reminders.length,
        last_reminder_at: last,
        overdue: daysSince(last ?? d.sent_at, opts.now) >= opts.replyByDays,
      })
    } else {
      unsent.push(base(d))
    }
  }

  waiting.sort(newest((w) => w.sent_at))
  unsent.sort(newest((d) => d.created_at))
  failed.sort(newest((f) => f.sent_at ?? f.created_at))
  const review = repliesToReview(replies)
  return {
    waiting,
    drafts: unsent,
    failed,
    review,
    counts: countPending({ waiting, drafts: unsent, failed, review }),
  }
}

/** Waiting requests only need action once they are overdue; everything else does. */
export function countPending(p: {
  waiting: Array<WaitingEmail>
  drafts: Array<unknown>
  failed: Array<unknown>
  review: Array<unknown>
}): PendingCounts {
  const overdue = p.waiting.filter((w) => w.overdue).length
  return {
    waiting: p.waiting.length,
    overdue,
    drafts: p.drafts.length,
    failed: p.failed.length,
    review: p.review.length,
    action: overdue + p.drafts.length + p.failed.length + p.review.length,
  }
}
