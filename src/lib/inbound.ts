// Tying an inbound reply to the request it answers. Pure, so it is unit-tested.
// Order of trust: the per-draft plus-address, then the sender's exact email, then the
// sender's domain. A reply nothing matches is kept as 'unmatched', never dropped.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

// A supplier writing from gmail.com says nothing about which supplier it is.
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'yahoo.com',
  'yahoo.ie',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'eircom.net',
  'protonmail.com',
  'proton.me',
])

/** 'Name <A@B.com>' or 'a@b.com' to 'a@b.com'. Null when there is no address. */
export function emailOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw)
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase()
  return /^[^\s@<>]+@[^\s@<>]+$/.test(candidate) ? candidate : null
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

export function isFreeMail(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase())
}

/** 'https://www.Shop.example.ie/trade' to 'shop.example.ie'. */
export function hostOf(website: string | null | undefined): string | null {
  if (!website) return null
  try {
    const url = new URL(
      /^[a-z]+:\/\//i.test(website) ? website : `https://${website}`,
    )
    return url.hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** Two hosts belong to the same business when one is the other or a subdomain of it. */
export function sameBusinessDomain(a: string, b: string): boolean {
  const x = a.replace(/^www\./, '')
  const y = b.replace(/^www\./, '')
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

/**
 * The address a request is CC'd to so the reply reaches Shelfie and names its draft:
 * 'abc@inbound.postmarkapp.com' becomes 'abc+<draftId>@inbound.postmarkapp.com'.
 */
export function inboundAddressFor(
  base: string | null | undefined,
  draftId: string,
): string | null {
  const email = emailOf(base)
  if (!email) return null
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at).split('+')[0]
  return `${local}+${draftId}${email.slice(at)}`
}

/**
 * The draft id carried by a plus-address among the message's recipients (or the
 * provider's mailbox hash). Only addresses at the Shelfie inbound address count.
 */
export function draftIdFromRecipients(
  recipients: Array<string>,
  base: string | null | undefined,
  mailboxHash?: string | null,
): string | null {
  const baseEmail = emailOf(base)
  const baseLocal = baseEmail
    ?.slice(0, baseEmail.lastIndexOf('@'))
    .split('+')[0]
  const baseDomain = baseEmail ? domainOf(baseEmail) : null
  for (const r of recipients) {
    const email = emailOf(r)
    if (!email) continue
    const at = email.lastIndexOf('@')
    const parts = email.slice(0, at).split('+')
    if (parts.length < 2) continue
    const [local, tag] = parts
    if (baseEmail && (local !== baseLocal || domainOf(email) !== baseDomain))
      continue
    const m = UUID.exec(tag)
    if (m) return m[0].toLowerCase()
  }
  const hash = mailboxHash ? UUID.exec(mailboxHash) : null
  return hash ? hash[0].toLowerCase() : null
}

export interface DraftRef {
  id: string
  supplier_id: string | null
  to_email: string | null
  created_at: string
}

export interface SupplierRef {
  id: string
  name: string
  email: string | null
  website: string | null
}

export type MatchMethod = 'plus_address' | 'sender_email' | 'sender_domain'

export interface ReplyMatch {
  draft_id: string | null
  supplier_id: string
  method: MatchMethod
}

function latestDraft(
  drafts: Array<DraftRef>,
  supplierId: string,
): DraftRef | null {
  return (
    drafts
      .filter((d) => d.supplier_id === supplierId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null
  )
}

/** Which draft and supplier a reply answers, or null when nothing matches. */
export function matchReply(input: {
  from: string
  plus_draft_id: string | null
  drafts: Array<DraftRef>
  suppliers: Array<SupplierRef>
  /** Fall back to the sender's email, then domain, for a plain Reply. On unless false. */
  by_sender?: boolean
}): ReplyMatch | null {
  const from = emailOf(input.from)
  const { drafts, suppliers } = input

  // 1. The plus-address names the draft, so it names the supplier and the product.
  if (input.plus_draft_id) {
    const d = drafts.find((x) => x.id === input.plus_draft_id)
    if (d?.supplier_id)
      return {
        draft_id: d.id,
        supplier_id: d.supplier_id,
        method: 'plus_address',
      }
  }
  if (!from || input.by_sender === false) return null

  // 2. The sender is exactly the address on a supplier or on a draft.
  const byDraftEmail = drafts.filter(
    (d) => d.supplier_id && emailOf(d.to_email) === from,
  )
  const bySupplierEmail = suppliers.filter((s) => emailOf(s.email) === from)
  const exact = new Set([
    ...byDraftEmail.map((d) => d.supplier_id!),
    ...bySupplierEmail.map((s) => s.id),
  ])
  if (exact.size === 1) {
    const supplierId = [...exact][0]
    return {
      draft_id: latestDraft(drafts, supplierId)?.id ?? null,
      supplier_id: supplierId,
      method: 'sender_email',
    }
  }

  // 3. The sender's company domain is the supplier's email domain or website.
  const domain = domainOf(from)
  if (isFreeMail(domain)) return null
  const byDomain = new Set<string>()
  for (const s of suppliers) {
    const emailDomain = s.email ? domainOf(emailOf(s.email) ?? '') : null
    const host = hostOf(s.website)
    if (
      (emailDomain &&
        !isFreeMail(emailDomain) &&
        sameBusinessDomain(domain, emailDomain)) ||
      (host && sameBusinessDomain(domain, host))
    )
      byDomain.add(s.id)
  }
  for (const d of drafts) {
    const e = emailOf(d.to_email)
    if (
      d.supplier_id &&
      e &&
      !isFreeMail(domainOf(e)) &&
      sameBusinessDomain(domain, domainOf(e))
    )
      byDomain.add(d.supplier_id)
  }
  if (byDomain.size === 1) {
    const supplierId = [...byDomain][0]
    return {
      draft_id: latestDraft(drafts, supplierId)?.id ?? null,
      supplier_id: supplierId,
      method: 'sender_domain',
    }
  }
  return null
}

/**
 * The CC puts Shelfie on the owner's own outgoing request too. That copy is addressed to
 * the supplier and sent by someone else, so it is not a reply.
 */
export function isOutgoingCopy(input: {
  from: string
  to: Array<string>
  draft_to_email: string | null
}): boolean {
  const from = emailOf(input.from)
  const supplier = emailOf(input.draft_to_email)
  if (!from || !supplier || from === supplier) return false
  if (!input.to.some((t) => emailOf(t) === supplier)) return false
  const free = isFreeMail(domainOf(supplier))
  return free || !sameBusinessDomain(domainOf(from), domainOf(supplier))
}
