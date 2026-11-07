// Reminders: a short follow-up to a request with no reply, sent as a reply in its thread.
// Pure: the wording and the thread headers, tested without a database or Gmail.

/** A sent email in a request's thread: the request itself, or a reminder already sent. */
export interface SentInThread {
  sent_at: string
  /** The RFC Message-ID, "<...@...>". Postmark's own ids are not Message-IDs. */
  provider_message_id: string | null
  gmail_thread_id: string | null
}

export interface ThreadHeaders {
  inReplyTo: string
  references: Array<string>
  gmailThreadId: string | null
}

const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/

/**
 * Where a reminder goes: In-Reply-To the latest email sent in the thread, References all of
 * them, oldest first, and Gmail's thread. Null when nothing sent has a Message-ID, so the
 * reminder can only go as a new email.
 */
export function threadHeaders(sent: Array<SentInThread>): ThreadHeaders | null {
  const ordered = [...sent].sort(
    (a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at),
  )
  const ids = ordered
    .map((s) => s.provider_message_id?.trim() ?? '')
    .filter((id, i, all) => MESSAGE_ID.test(id) && all.indexOf(id) === i)
  if (ids.length === 0) return null
  return {
    inReplyTo: ids[ids.length - 1],
    references: ids,
    gmailThreadId:
      ordered.find((s) => s.gmail_thread_id)?.gmail_thread_id ?? null,
  }
}

/** "Re: Price on milk", without stacking "Re: Re:". */
export function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim()
  if (!s) return 'Following up'
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

/** "7 November", in Irish time. */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Dublin',
  })
}

/** "milk", "milk and butter", "milk, butter and eggs". */
function listOf(names: Array<string>): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The reminder: a few friendly lines, then the original quoted below, as mail apps do.
 * No figures of its own: the original already has them.
 */
export function reminderEmail(r: {
  supplier_name: string | null
  owner_name: string
  business_name: string
  kind: 'match' | 'quote'
  subject: string | null
  body: string | null
  products: Array<string>
  sent_at: string
}): { subject: string; body: string } {
  const about = r.products.length > 0 ? ` about ${listOf(r.products)}` : ''
  const ask =
    r.kind === 'quote'
      ? 'Could you let me know your trade prices when you get a chance?'
      : 'Could you let me know if you can do it when you get a chance?'
  const original = (r.body ?? '').trimEnd()
  const quoted = original
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
  const lines = [
    r.supplier_name ? `Hi ${r.supplier_name},` : 'Hi,',
    '',
    `Just following up on my email of ${longDate(r.sent_at)}${about}. ${ask}`,
    '',
    'Thanks,',
    r.owner_name,
    r.business_name,
  ]
  if (original.trim())
    lines.push('', `On ${longDate(r.sent_at)}, ${r.owner_name} wrote:`, quoted)
  return { subject: replySubject(r.subject), body: lines.join('\n') }
}
