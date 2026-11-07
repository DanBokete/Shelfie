// "Ask for a quote": email a seller found online for their trade prices.
// Contact details come from a web search of the seller's own site, checked against what the
// search read (lib/contact.ts). The figures in the email come from our code, not the model.
import { AIError, askJSON, searchWeb } from './claude.server'
import { verifyContact } from './contact'
import type { VerifiedContact } from './contact'
import { replyByDate } from './email.server'
import {
  BUSINESS,
  P10_SELLER_CONTACT_READ,
  P11_QUOTE_REQUEST,
  P9_SELLER_CONTACT,
} from './prompts'
import { invoicePeriod, observationsByProduct } from './queries.server'
import { productInsight } from './savings'
import { EmailDraft, SellerContact } from './schemas'
import { db, mustOne } from './supabase.server'
import { baseUnitsPerPack, describePack, isRawUnit } from './units'

interface Seller {
  id: string
  name: string
  email: string | null
  phone: string | null
  website: string | null
  sells_to_trade: 'yes' | 'no' | 'unknown' | null
  contact_source_url: string | null
  contact_note: string | null
  contact_checked_at: string | null
}

const SELLER_COLS =
  'id, name, email, phone, website, sells_to_trade, contact_source_url, contact_note, contact_checked_at'

export interface QuoteContact extends VerifiedContact {
  website: string | null
  /** Why there are no details, when the lookup could not run (e.g. demo mode, no internet). */
  lookup_error: string | null
}

function stored(s: Seller, lookupError: string | null = null): QuoteContact {
  return {
    sells_to_trade: s.sells_to_trade ?? 'unknown',
    email: s.email,
    phone: s.phone,
    contact_source_url: s.contact_source_url,
    note: s.contact_note,
    website: s.website,
    lookup_error: lookupError,
  }
}

/** Looks up how to reach a seller, once. Later calls return what was saved. */
export async function sellerContact(supplierId: string): Promise<QuoteContact> {
  const seller = mustOne(
    await db()
      .from('suppliers')
      .select(SELLER_COLS)
      .eq('id', supplierId)
      .single<Seller>(),
    'load seller',
  )
  if (seller.contact_checked_at) return stored(seller)

  let research
  try {
    research = await searchWeb({
      name: 'contact',
      system: P9_SELLER_CONTACT,
      prompt: [
        `Seller: ${seller.name}`,
        seller.website ? `Website: ${seller.website}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      maxSearches: 3,
      maxFetches: 4,
      effort: 'low',
    })
  } catch (err) {
    // The email can still be drafted; the owner fills in the address.
    return stored(
      seller,
      err instanceof AIError
        ? err.message
        : 'Could not look up contact details.',
    )
  }
  const parsed = await askJSON({
    name: 'contact-read',
    system: P10_SELLER_CONTACT_READ,
    content: `Seller: ${seller.name}\n\nNotes:\n${research.text}`,
    schema: SellerContact,
    effort: 'low',
    maxTokens: 2000,
  })
  const c = verifyContact(
    parsed,
    research.text,
    research.sources.map((s) => s.url),
  )
  const updated = mustOne(
    await db()
      .from('suppliers')
      .update({
        email: c.email ?? seller.email,
        phone: c.phone ?? seller.phone,
        sells_to_trade: c.sells_to_trade,
        contact_source_url: c.contact_source_url,
        contact_note: c.note,
        contact_checked_at: new Date().toISOString(),
      })
      .eq('id', supplierId)
      .select(SELLER_COLS)
      .single<Seller>(),
    'save seller contact',
  )
  return stored(updated)
}

interface WebOfferRow {
  id: string
  product_id: string
  supplier_id: string
  raw_description: string
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  source: string
  source_url: string | null
  products: { canonical_name: string; base_unit: 'ml' | 'g' | 'each' } | null
}

/** Drafts a quote request for one web price (a price_observations row with source 'web'). */
export async function draftQuoteRequest(offerId: string) {
  const offer = mustOne(
    await db()
      .from('price_observations')
      .select(
        'id, product_id, supplier_id, raw_description, pack_price, pack_size, pack_unit, units_per_case, source, source_url, products(canonical_name, base_unit)',
      )
      .eq('id', offerId)
      .single<WebOfferRow>(),
    'load offer',
  )
  if (offer.source !== 'web' || !offer.products) {
    throw new Error('A quote can only be requested for a price found online.')
  }

  const [contact, obsMap, period] = await Promise.all([
    sellerContact(offer.supplier_id),
    observationsByProduct([offer.product_id]),
    invoicePeriod(),
  ])
  const seller = mustOne(
    await db()
      .from('suppliers')
      .select('id, name')
      .eq('id', offer.supplier_id)
      .single<{ id: string; name: string }>(),
    'load seller',
  )

  // Typical weekly use, in the pack the owner buys now (e.g. "about 40 x 2L a week").
  const insight = productInsight(obsMap.get(offer.product_id) ?? [], { period })
  const cur = insight.current
  const curUnits =
    cur && isRawUnit(cur.pack_unit)
      ? baseUnitsPerPack({
          pack_size: cur.pack_size,
          pack_unit: cur.pack_unit,
          units_per_case: cur.units_per_case,
        })
      : null
  const weekly =
    insight.annual_base_units != null && curUnits
      ? Math.round((insight.annual_base_units / 52 / curUnits.amount) * 10) / 10
      : null
  const ownerPack =
    cur && isRawUnit(cur.pack_unit)
      ? describePack({
          pack_size: cur.pack_size,
          pack_unit: cur.pack_unit,
          units_per_case: cur.units_per_case,
        })
      : null
  const offerPack = isRawUnit(offer.pack_unit)
    ? describePack({
        pack_size: offer.pack_size,
        pack_unit: offer.pack_unit,
        units_per_case: offer.units_per_case,
      })
    : 'pack'

  const item = {
    product: offer.products.canonical_name,
    their_listing: offer.raw_description,
    price_seen: `€${Number(offer.pack_price).toFixed(2)} ex VAT per ${offerPack}`,
    typical_weekly_quantity:
      weekly != null && ownerPack ? `about ${weekly} x ${ownerPack}` : null,
  }

  const system = P11_QUOTE_REQUEST.replace(
    '{owner_name}',
    BUSINESS.owner,
  ).replace('{business_name}', BUSINESS.name)
  const raw = await askJSON({
    name: 'quote',
    system,
    content: JSON.stringify({ seller: seller.name, items: [item] }),
    schema: EmailDraft,
    effort: 'low',
    maxTokens: 4000,
  })
  const date = replyByDate()
  const draft = {
    subject: raw.subject.replaceAll('{reply_by_date}', date),
    body: raw.body.replaceAll('{reply_by_date}', date),
  }
  const row = mustOne(
    await db()
      .from('email_drafts')
      .insert({
        kind: 'quote',
        supplier_id: seller.id,
        price_observation_id: offer.id,
        to_email: contact.email,
        subject: draft.subject,
        body: draft.body,
        items: [item],
        status: 'draft',
      })
      .select('id')
      .single<{ id: string }>(),
    'save draft',
  )
  return {
    id: row.id,
    supplier: { name: seller.name, email: contact.email },
    contact,
    ...draft,
  }
}
