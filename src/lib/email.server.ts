// Feature 5: negotiation email drafts. Claude writes the words; the figures come from our code.
import { askJSON } from './claude.server'
import { inboundAddressFor } from './inbound'
import { BUSINESS, P6_NEGOTIATION_EMAIL } from './prompts'
import { EmailDraft } from './schemas'
import { db, must } from './supabase.server'

export interface EmailItem {
  product_name: string
  pack_label: string
  your_price: number
  best_price: number
  weekly_quantity: number | null
}

function euro(n: number): string {
  return `€${n.toFixed(2)}`
}

/** A reply date a week out, written out in full so the email is unambiguous. */
export function replyByDate(from: Date = new Date()): string {
  const d = new Date(from.getTime() + 7 * 86_400_000)
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
  const system = P6_NEGOTIATION_EMAIL.replace(
    '{owner_name}',
    BUSINESS.owner,
  ).replace('{business_name}', BUSINESS.name)
  const facts = {
    supplier: supplier.name,
    items: items.map((i) => ({
      product: i.product_name,
      pack: i.pack_label,
      current_price: euro(i.your_price),
      price_found_elsewhere: euro(i.best_price),
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
  const date = replyByDate()
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
    reply_cc: inboundAddressFor(process.env.INBOUND_EMAIL_ADDRESS, row.id),
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
