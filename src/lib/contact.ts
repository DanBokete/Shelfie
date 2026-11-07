// Checks a seller's contact details against what the web search actually read, so an
// email address the model made up (e.g. sales@<domain>) is never put in the To field.
import type { SellerContact } from './schemas'

/** Host and path without query or trailing slash, so the same page always compares equal. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase()
  } catch {
    return null
  }
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i

export interface VerifiedContact {
  sells_to_trade: 'yes' | 'no' | 'unknown'
  email: string | null
  phone: string | null
  contact_source_url: string | null
  note: string | null
}

export function verifyContact(
  c: SellerContact,
  researchText: string,
  sourceUrls: Array<string>,
): VerifiedContact {
  const text = researchText.toLowerCase()
  const digits = researchText.replace(/[^\d+]/g, '')
  const email = c.email?.trim().toLowerCase() ?? null
  // Whole address only: 'sales@x.ie' must not pass because the notes say 'tradesales@x.ie'.
  const okEmail =
    email != null &&
    EMAIL.test(email) &&
    new RegExp(
      `(^|[^a-z0-9._%+-])${escapeRegExp(email)}($|[^a-z0-9.-]|\\.(?![a-z]))`,
    ).test(text)
  const phone = c.phone?.trim() ?? null
  const phoneDigits = phone?.replace(/[^\d+]/g, '') ?? ''
  const okPhone =
    phone != null && phoneDigits.length >= 7 && digits.includes(phoneDigits)
  const seen = new Set(sourceUrls.map(pageKey))
  const page =
    c.contact_page_url && seen.has(pageKey(c.contact_page_url))
      ? c.contact_page_url
      : null
  return {
    sells_to_trade: c.sells_to_trade,
    email: okEmail ? email : null,
    phone: okPhone ? phone : null,
    contact_source_url: page,
    note: c.note.trim() || null,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
