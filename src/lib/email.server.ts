// Feature 5: negotiation email drafts. Claude writes the words; the figures come from our code.
import { reductionPercent } from './ask'
import { askJSON } from './claude.server'
import { inboundAddressFor } from './inbound'
import { P6_NEGOTIATION_EMAIL } from './prompts'
import { EmailDraft } from './schemas'
import {
  getSettings,
  replyCc,
  sendingStatus,
  withBusiness,
} from './settings.server'
import { db, must } from './supabase.server'

export interface EmailItem {
  product_name: string
  pack_label: string
  your_price: number
  best_price: number
  weekly_quantity: number | null
}

/** A reply date `days` out (a week by default), written out in full so the email is unambiguous. */
export function replyByDate(days = 7, from: Date = new Date()): string {
  const d = new Date(from.getTime() + days * 86_400_000)
  return d.toLocaleDateString('en-IE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

export async function draftEmail(supplierId: string, items: Array<EmailItem>) {
  const supplier = must(
    await db()
      .from('suppliers')
      .select('id, name, email')
      .eq('id', supplierId)
      .single(),
    'load supplier',
  ) as { id: string; name: string; email: string | null }

  // The reply date is filled in after generation so cached drafts stay correct on any day.
  const settings = await getSettings()
  const system = withBusiness(P6_NEGOTIATION_EMAIL, settings)
  // Only products where a lower price was found, each with the percentage to ask for.
  const asks = items
    .map((i) => ({
      ...i,
      percent: reductionPercent(i.your_price, i.best_price),
    }))
    .filter((i) => i.percent > 0)
  if (asks.length === 0)
    throw new Error('There is no lower price to ask this supplier to match.')
  const facts = {
    supplier: supplier.name,
    items: asks.map((i) => ({
      product: i.product_name,
      pack: i.pack_label,
      reduction_percent: i.percent,
      typical_weekly_quantity:
        i.weekly_quantity == null
          ? null
          : Math.round(i.weekly_quantity * 10) / 10,
    })),
  }
  const raw = await askJSON({
    name: 'email',
    system,
    content: JSON.stringify(facts),
    schema: EmailDraft,
    effort: 'low',
    maxTokens: 4000,
  })
  const date = replyByDate(settings.reply_by_days)
  const draft = {
    subject: raw.subject.replaceAll('{reply_by_date}', date),
    body: raw.body.replaceAll('{reply_by_date}', date),
  }
  const row = must(
    await db()
      .from('email_drafts')
      .insert({
        kind: 'match',
        supplier_id: supplier.id,
        to_email: supplier.email,
        subject: draft.subject,
        body: draft.body,
        items,
        status: 'draft',
      })
      .select('id')
      .single(),
    'save draft',
  ) as { id: string }
  return {
    id: row.id,
    supplier,
    reply_cc: replyCc(settings, inboundAddressFor, row.id),
    reply_bcc: settings.bcc_email,
    sending: sendingStatus(settings),
    ...draft,
  }
}

export async function updateDraft(
  id: string,
  fields: {
    subject: string
    body: string
    to_email: string | null
    status: 'draft' | 'approved'
  },
) {
  const { subject, body, to_email, status } = fields
  must(
    await db()
      .from('email_drafts')
      .update({ subject, body, to_email, status })
      .eq('id', id),
    'update draft',
  )
}
