// Feature 5: negotiation email drafts. The owner's template or Claude writes the words; the
// figures always come from our code.
import { targetBuyPrice } from './ask'
import { AIError, askJSON } from './claude.server'
import { inboundAddressFor } from './inbound'
import { P6_NEGOTIATION_EMAIL } from './prompts'
import { EmailDraft } from './schemas'
import {
  emailTemplate,
  getSettings,
  replyCc,
  sendingStatus,
  withBusiness,
} from './settings.server'
import type { Settings } from './settings.server'
import { sellingPricePerPack } from './selling.server'
import { db, must, mustOne } from './supabase.server'
import { renderTemplate, replyByDate } from './templates'
import type {
  EmailKind,
  EmailTemplate,
  TemplateItem,
  Writer,
} from './templates'

export { replyByDate }

export interface EmailItem {
  /** Lets the server look up the owner's selling price for a profit-based target. */
  product_id?: string
  product_name: string
  pack_label: string
  your_price: number
  best_price: number
  weekly_quantity: number | null
}

export interface DraftOptions {
  /** Who writes the words. Default: the owner's choice in Settings. */
  writer?: Writer
  /** Rewrite this unsent draft in place (same id, so the same reply address), not a new one. */
  redo_of?: string
}

/** Turns "no API key" and "not in the demo cache" into something the owner can act on. */
function aiWriteError(err: unknown): unknown {
  if (!(err instanceof AIError)) return err
  if (err.kind === 'config')
    return new AIError(
      'Writing with AI needs ANTHROPIC_API_KEY in .env. Use your template instead, or add the key and restart.',
      'config',
    )
  if (err.kind === 'demo_cache_miss')
    return new AIError(
      'Demo mode is offline and this email has not been written with AI before. Use your template instead.',
      'demo_cache_miss',
    )
  return err
}

/**
 * Writes the subject and body. The template fills in our figures with no model; Claude gets the
 * same figures as JSON. {reply_by_date} is filled in afterwards so cached AI drafts stay correct
 * on any day.
 */
export async function writeEmail(opts: {
  kind: EmailKind
  writer: Writer
  settings: Settings
  supplierName: string
  items: Array<TemplateItem>
  /** The prompt and the facts Claude gets. */
  ai: { name: string; system: string; facts: unknown }
}): Promise<EmailTemplate> {
  const { settings: s } = opts
  const date = replyByDate(s.reply_by_days)
  if (opts.writer === 'template')
    return renderTemplate(opts.kind, emailTemplate(s, opts.kind), {
      supplier_name: opts.supplierName,
      owner_name: s.owner_name,
      business_name: s.business_name,
      town: s.town,
      reply_by_date: date,
      items: opts.items,
    })
  let raw
  try {
    raw = await askJSON({
      name: opts.ai.name,
      system: withBusiness(opts.ai.system, s),
      content: JSON.stringify(opts.ai.facts),
      schema: EmailDraft,
      effort: 'low',
      maxTokens: 4000,
    })
  } catch (err) {
    throw aiWriteError(err)
  }
  return {
    subject: raw.subject.replaceAll('{reply_by_date}', date),
    body: raw.body.replaceAll('{reply_by_date}', date),
  }
}

/** Saves a new draft, or rewrites an unsent one in place. Returns its id. */
export async function saveDraftRow(
  row: Record<string, unknown> & {
    subject: string
    body: string
    writer: Writer
  },
  redoOf: string | undefined,
): Promise<string> {
  if (redoOf) {
    // The To address stays as the owner typed it: the email window keeps it.
    const { subject, body, writer, items } = row
    const updated = must(
      await db()
        .from('email_drafts')
        .update({ subject, body, writer, items })
        .eq('id', redoOf)
        .is('sent_at', null)
        .select('id')
        .maybeSingle<{ id: string }>(),
      'save draft',
    )
    if (!updated) throw new Error('This email was already sent.')
    return updated.id
  }
  return mustOne(
    await db()
      .from('email_drafts')
      .insert({ ...row, status: 'draft' })
      .select('id')
      .single<{ id: string }>(),
    'save draft',
  ).id
}

export async function draftEmail(
  supplierId: string,
  items: Array<EmailItem>,
  opts: DraftOptions = {},
) {
  const supplier = must(
    await db()
      .from('suppliers')
      .select('id, name, email')
      .eq('id', supplierId)
      .single(),
    'load supplier',
  ) as { id: string; name: string; email: string | null }

  const settings = await getSettings()
  const writer = opts.writer ?? settings.email_writer
  // Each product gets a target buy price and the percentage cut that is. Where the owner has
  // entered a selling price it is the price that keeps their profit when they sell at the
  // competitive price; otherwise it is the better price found. Nothing to ask means no email.
  const targets = await Promise.all(
    items.map(async (i) => {
      const selling = i.product_id
        ? await sellingPricePerPack(i.product_id)
        : null
      const t = targetBuyPrice({
        your_price: i.your_price,
        best_price: i.best_price,
        selling_price: selling,
      })
      return t
        ? {
            product_name: i.product_name,
            pack_label: i.pack_label,
            your_price: i.your_price,
            best_price: i.best_price,
            weekly_quantity: i.weekly_quantity,
            ...t,
          }
        : null
    }),
  )
  const asks = targets.filter((a): a is NonNullable<typeof a> => a != null)
  if (asks.length === 0)
    throw new Error('There is no lower price to ask this supplier to match.')
  const draft = await writeEmail({
    kind: 'match',
    writer,
    settings,
    supplierName: supplier.name,
    items: asks.map((a) => ({
      product: a.product_name,
      pack: a.pack_label,
      your_price: a.your_price,
      price_found: a.best_price,
      target_price: a.target,
      reduction_percent: a.percent,
      weekly_quantity: a.weekly_quantity,
    })),
    ai: {
      name: 'email',
      system: P6_NEGOTIATION_EMAIL,
      facts: {
        supplier: supplier.name,
        items: asks.map((a) => ({
          product: a.product_name,
          pack: a.pack_label,
          target_price_per_pack: `€${a.target.toFixed(2)}`,
          reduction_percent: a.percent,
          typical_weekly_quantity:
            a.weekly_quantity == null
              ? null
              : Math.round(a.weekly_quantity * 10) / 10,
        })),
      },
    },
  })
  const id = await saveDraftRow(
    {
      kind: 'match',
      supplier_id: supplier.id,
      to_email: supplier.email,
      subject: draft.subject,
      body: draft.body,
      // The price each item asks for, so a "yes" in the reply can be read as that price.
      items: items.map((i, k) => ({
        ...i,
        asked_price: targets[k]?.target ?? null,
      })),
      writer,
    },
    opts.redo_of,
  )
  return {
    id,
    writer,
    supplier,
    reply_cc: replyCc(settings, inboundAddressFor, id),
    reply_bcc: settings.bcc_email,
    sending: sendingStatus(settings),
    asks: asks.map(
      ({ weekly_quantity: _w, your_price: _y, best_price: _b, ...a }) => a,
    ),
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
