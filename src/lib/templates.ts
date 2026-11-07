// Email templates: the owner's own wording for "Ask to match" and "Ask for a quote", filled in
// with our figures and no model. Pure, so it runs in the browser (the Settings preview) and on
// the server (drafts), and both give the same text.
//
// Syntax
// - {name} is a placeholder. Anything else in curly brackets is flagged as unknown.
// - A line with {items} on its own starts the products block and a line with {/items} ends it.
//   The lines between are repeated once per product, and only there can product placeholders
//   ({product}, {pack}, ...) be used.
// - A line whose placeholder has no value (for example no weekly quantity) is left out, rather
//   than printed with a blank.
import { euro } from './format'

export type EmailKind = 'match' | 'quote'
export type Writer = 'template' | 'ai'

export interface EmailTemplate {
  subject: string
  body: string
}

/** Placeholders for the whole email, both kinds. */
export const EMAIL_PLACEHOLDERS = [
  'supplier_name',
  'owner_name',
  'business_name',
  'town',
  'reply_by_date',
] as const

/**
 * Placeholders inside {items} ... {/items}, per kind. A quote request goes to a seller the owner
 * has never bought from, so it can never show what they pay now or what they want to pay.
 */
export const ITEM_PLACEHOLDERS = {
  match: [
    'product',
    'pack',
    'your_price',
    'price_found',
    'target_price',
    'reduction_percent',
    'weekly_quantity',
  ],
  quote: ['product', 'pack', 'price_found', 'weekly_quantity'],
} as const satisfies Record<EmailKind, ReadonlyArray<string>>

type EmailField = (typeof EMAIL_PLACEHOLDERS)[number]
type MatchField = (typeof ITEM_PLACEHOLDERS)['match'][number]

/** What each placeholder holds, for the Settings help. */
export const PLACEHOLDER_HELP: Record<EmailField | MatchField, string> = {
  supplier_name: 'Who the email goes to',
  owner_name: 'Your name',
  business_name: 'Your business',
  town: 'Your town',
  reply_by_date: 'The reply-by date, e.g. Friday 14 November',
  product: 'Product name',
  pack: 'Pack size, e.g. 6 x 2L',
  your_price: 'What you pay now, per pack',
  price_found: 'The lower price found, per pack',
  target_price: 'The price per pack you ask for',
  reduction_percent: 'How much lower that is, a number',
  weekly_quantity: 'How many you use a week, e.g. 12 x 6 x 2L',
}

const ITEMS_OPEN = 'items'
const ITEMS_CLOSE = '/items'

export const DEFAULT_TEMPLATES: Record<EmailKind, EmailTemplate> = {
  match: {
    subject: 'Our prices with you - {business_name}',
    body: `Hi {supplier_name},

Thanks for looking after {business_name}. We value working with you and want to keep ordering from you.

We have been comparing prices, and to stay competitive we would need these prices from you:

{items}
- {product}, {pack}: we would need {target_price}, about {reduction_percent}% lower
  We use about {weekly_quantity} a week.
{/items}

Could you match these prices? Please let me know by {reply_by_date}.

Many thanks,
{owner_name}
{business_name}`,
  },
  quote: {
    subject: 'Trade price enquiry - {business_name}, {town}',
    body: `Hello {supplier_name},

I run {business_name} in {town} and I am looking for a supplier for:

{items}
- {product}, {pack}: I saw it listed at {price_found} ex VAT
  We use about {weekly_quantity} a week.
{/items}

Could you send me your trade price list or a quote? Please include delivery to {town}, any minimum order, and how to open an account.

A reply by {reply_by_date} would be great.

Many thanks,
{owner_name}
{business_name}, {town}`,
  },
}

export interface TemplateItem {
  product: string
  pack: string | null
  price_found: number | null
  /** Match only: what the owner pays now, per pack. */
  your_price?: number | null
  /** Match only: the price per pack the email asks for. */
  target_price?: number | null
  /** Match only: how much lower the target is, whole percent. */
  reduction_percent?: number | null
  /** Packs a week, in `weekly_pack` (or `pack` when that is not given). */
  weekly_quantity: number | null
  /** The pack the owner buys now, when it differs from the one in the email. */
  weekly_pack?: string | null
}

export interface TemplateFacts {
  supplier_name: string
  owner_name: string
  business_name: string
  town: string
  reply_by_date: string
  items: Array<TemplateItem>
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

/** "43", "2.5": packs a week, whole from 10 up, else to one decimal place. */
function quantity(n: number): string {
  return String(n >= 10 ? Math.round(n) : Math.round(n * 10) / 10)
}

/** "12 x 6 x 2L", "3 packs of 30", or just "12" for single items. */
export function weeklyQuantity(n: number, pack: string | null): string {
  const q = quantity(n)
  if (!pack || pack === 'single') return q
  const of = /^pack of (.+)$/.exec(pack)
  if (of) return `${q} ${n === 1 ? 'pack' : 'packs'} of ${of[1]}`
  return `${q} x ${pack}`
}

function text(v: string | null | undefined): string | null {
  const t = v?.trim()
  return t && t !== 'unknown pack' ? t : null
}

function money(v: number | null | undefined): string | null {
  return v == null || !Number.isFinite(v) ? null : euro(v, { cents: true })
}

/** The value of each item placeholder, or null when it is missing. */
function itemValues(
  kind: EmailKind,
  i: TemplateItem,
): Record<string, string | null> {
  const common = {
    product: text(i.product),
    pack: text(i.pack),
    price_found: money(i.price_found),
    weekly_quantity:
      i.weekly_quantity == null || !(i.weekly_quantity > 0)
        ? null
        : weeklyQuantity(
            i.weekly_quantity,
            text(i.weekly_pack) ?? text(i.pack),
          ),
  }
  if (kind === 'quote') return common
  return {
    ...common,
    your_price: money(i.your_price),
    target_price: money(i.target_price),
    reduction_percent:
      i.reduction_percent == null ? null : String(i.reduction_percent),
  }
}

function emailValues(f: TemplateFacts): Record<string, string | null> {
  return {
    supplier_name: text(f.supplier_name),
    owner_name: text(f.owner_name),
    business_name: text(f.business_name),
    town: text(f.town),
    reply_by_date: text(f.reply_by_date),
  }
}

// Anything in curly brackets on one line is a placeholder, known or not.
const TOKEN = /\{([^{}\n]*)\}/g

/**
 * Fills one line. Null when a known placeholder on it has no value, so the line is left out.
 * Unknown placeholders stay as typed: Settings refuses to save them, so they only reach a draft
 * from a template that was never checked.
 */
function fillLine(
  line: string,
  values: Record<string, string | null>,
): string | null {
  const known = (name: string) => Object.hasOwn(values, name)
  for (const [, name] of line.matchAll(TOKEN))
    if (known(name) && values[name] == null) return null
  return line.replace(TOKEN, (whole, name: string) =>
    known(name) ? (values[name] ?? '') : whole,
  )
}

function isTag(line: string, tag: string): boolean {
  return line.trim() === `{${tag}}`
}

/** Fills a template with the facts. Never calls a model. */
export function renderTemplate(
  kind: EmailKind,
  template: EmailTemplate,
  facts: TemplateFacts,
): EmailTemplate {
  const top = emailValues(facts)
  const rows = facts.items.map((i) => ({ ...top, ...itemValues(kind, i) }))

  const out: Array<string> = []
  let block: Array<string> | null = null
  for (const line of template.body.split(/\r?\n/)) {
    if (block == null && isTag(line, ITEMS_OPEN)) {
      block = []
    } else if (block != null && isTag(line, ITEMS_CLOSE)) {
      for (const values of rows)
        for (const l of block) {
          const filled = fillLine(l, values)
          if (filled != null) out.push(filled)
        }
      block = null
    } else if (block != null) {
      block.push(line)
    } else {
      const filled = fillLine(line, top)
      if (filled != null) out.push(filled)
    }
  }
  // An {items} with no {/items}: Settings flags it; here the lines are kept as written.
  if (block != null) out.push(`{${ITEMS_OPEN}}`, ...block)

  const body = out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const subject = (fillLine(template.subject, top) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return { subject, body }
}

export interface TemplateProblem {
  field: 'subject' | 'body'
  message: string
}

const MATCH_ONLY: ReadonlyArray<string> = ITEM_PLACEHOLDERS.match.filter(
  (p) => !(ITEM_PLACEHOLDERS.quote as ReadonlyArray<string>).includes(p),
)

function placeholderProblem(
  kind: EmailKind,
  name: string,
  inItems: boolean,
): string | null {
  if ((EMAIL_PLACEHOLDERS as ReadonlyArray<string>).includes(name)) return null
  const itemNames: ReadonlyArray<string> = ITEM_PLACEHOLDERS[kind]
  if (itemNames.includes(name))
    return inItems
      ? null
      : `{${name}} only works between the {items} and {/items} lines.`
  if (kind === 'quote' && MATCH_ONLY.includes(name))
    return `{${name}} can't be used when asking for a quote: the seller must not see what you pay or what you want to pay.`
  if (name === ITEMS_OPEN || name === ITEMS_CLOSE)
    return `Put {${name}} on a line of its own.`
  return `Unknown placeholder {${name}}.`
}

const STRAY_BRACE =
  'A { or } is not part of a placeholder. Placeholders look like {supplier_name}.'

/** A curly bracket left over once every {placeholder} is taken out: likely a typo. */
function strayBrace(line: string): boolean {
  return /[{}]/.test(line.replace(TOKEN, ''))
}

/** Everything wrong with a template, for Settings. Empty when it can be saved. */
export function templateProblems(
  kind: EmailKind,
  template: EmailTemplate,
): Array<TemplateProblem> {
  const problems: Array<TemplateProblem> = []
  const add = (field: TemplateProblem['field'], message: string) => {
    if (!problems.some((p) => p.field === field && p.message === message))
      problems.push({ field, message })
  }

  if (!template.subject.trim()) add('subject', 'The subject is empty.')
  if (/\n/.test(template.subject))
    add('subject', 'The subject must be one line.')
  if (strayBrace(template.subject)) add('subject', STRAY_BRACE)
  for (const [, name] of template.subject.matchAll(TOKEN)) {
    const p =
      name === ITEMS_OPEN || name === ITEMS_CLOSE
        ? 'The products list can only go in the message.'
        : placeholderProblem(kind, name, false)
    if (p) add('subject', p)
  }

  if (!template.body.trim()) add('body', 'The message is empty.')
  let inItems = false
  let blocks = 0
  for (const line of template.body.split(/\r?\n/)) {
    if (isTag(line, ITEMS_OPEN)) {
      if (inItems)
        add('body', 'A products list starts before the last one ended.')
      inItems = true
      blocks++
      continue
    }
    if (isTag(line, ITEMS_CLOSE)) {
      if (!inItems) add('body', 'There is an {/items} line with no {items}.')
      inItems = false
      continue
    }
    for (const [, name] of line.matchAll(TOKEN)) {
      const p = placeholderProblem(kind, name, inItems)
      if (p) add('body', p)
    }
    if (strayBrace(line)) add('body', STRAY_BRACE)
  }
  if (inItems) add('body', 'Add an {/items} line to end the products list.')
  if (blocks === 0)
    add(
      'body',
      'Add the products list: an {items} line, the product lines, then an {/items} line.',
    )
  return problems
}

/** The template to use: the owner's own when saved, else the default. */
export function templateFor(
  kind: EmailKind,
  saved: { subject: string | null; body: string | null },
): EmailTemplate {
  return {
    subject: saved.subject ?? DEFAULT_TEMPLATES[kind].subject,
    body: saved.body ?? DEFAULT_TEMPLATES[kind].body,
  }
}

/** Sample facts for the Settings preview. */
export function sampleFacts(
  kind: EmailKind,
  business: { business_name: string; owner_name: string; town: string },
  replyByDays: number,
): TemplateFacts {
  const top = {
    ...business,
    reply_by_date: replyByDate(replyByDays),
  }
  if (kind === 'quote')
    return {
      ...top,
      supplier_name: 'Brennan Catering Supplies',
      items: [
        {
          product: 'Whole milk',
          pack: '6 x 2L',
          price_found: 10.2,
          weekly_quantity: 12,
        },
      ],
    }
  return {
    ...top,
    supplier_name: 'Lee Valley Wholesale',
    items: [
      {
        product: 'Whole milk',
        pack: '6 x 2L',
        your_price: 11.6,
        price_found: 10.2,
        target_price: 10.2,
        reduction_percent: 12,
        weekly_quantity: 12,
      },
      {
        product: 'Coffee beans',
        pack: '1kg',
        your_price: 24,
        price_found: 20.4,
        target_price: 20.4,
        reduction_percent: 15,
        weekly_quantity: null,
      },
    ],
  }
}
