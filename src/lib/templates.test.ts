import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  replyByDate,
  sampleFacts,
  templateFor,
  templateProblems,
  weeklyQuantity,
} from './templates'
import type { TemplateFacts } from './templates'

const facts: TemplateFacts = {
  supplier_name: 'Lee Valley Wholesale',
  owner_name: 'Aoife',
  business_name: 'The Corner Café',
  town: 'Cork',
  reply_by_date: 'Friday 14 November',
  items: [
    {
      product: 'Whole milk 2L',
      pack: '6 x 2L',
      your_price: 11.6,
      price_found: 10.2,
      target_price: 10.2,
      reduction_percent: 12,
      weekly_quantity: 12.04,
    },
    {
      product: 'Coffee beans',
      pack: '1kg',
      your_price: 24,
      price_found: 20.4,
      target_price: 19.5,
      reduction_percent: 19,
      weekly_quantity: null,
    },
  ],
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

describe('renderTemplate', () => {
  it('fills email placeholders in the subject and body', () => {
    const r = renderTemplate(
      'match',
      {
        subject: 'Prices for {business_name}',
        body: 'Hi {supplier_name},\n{items}\n{product}\n{/items}\nBy {reply_by_date}.\n{owner_name}, {business_name}, {town}',
      },
      facts,
    )
    expect(r.subject).toBe('Prices for The Corner Café')
    expect(r.body).toBe(
      'Hi Lee Valley Wholesale,\nWhole milk 2L\nCoffee beans\nBy Friday 14 November.\nAoife, The Corner Café, Cork',
    )
  })

  it('repeats the items block once per product, in order', () => {
    const r = renderTemplate(
      'match',
      {
        subject: 's',
        body: 'Start\n{items}\n- {product} ({pack})\n  now {your_price}, found {price_found}\n{/items}\nEnd',
      },
      facts,
    )
    expect(r.body).toBe(
      [
        'Start',
        '- Whole milk 2L (6 x 2L)',
        '  now €11.60, found €10.20',
        '- Coffee beans (1kg)',
        '  now €24.00, found €20.40',
        'End',
      ].join('\n'),
    )
  })

  it('leaves out lines whose values are missing instead of printing blanks', () => {
    const r = renderTemplate(
      'match',
      {
        subject: 's',
        body: '{items}\n- {product}\n  About {weekly_quantity} a week.\n{/items}',
      },
      facts,
    )
    expect(r.body).toBe(
      '- Whole milk 2L\n  About 12 x 6 x 2L a week.\n- Coffee beans',
    )
    expect(r.body).not.toMatch(/about\s+a week/i)
  })

  it('formats money in euro with cents, and percentages as plain numbers', () => {
    const r = renderTemplate(
      'match',
      {
        subject: 's',
        body: '{items}\n{target_price} ({reduction_percent}% lower than {your_price})\n{/items}',
      },
      { ...facts, items: [{ ...facts.items[1], target_price: 1234.5 }] },
    )
    expect(r.body).toBe('€1,234.50 (19% lower than €24.00)')
  })

  it('leaves unknown placeholders as typed, and templateProblems flags them', () => {
    const tpl = {
      subject: 'Hi {supplier}',
      body: '{items}\n{product}\n{/items}',
    }
    expect(renderTemplate('match', tpl, facts).subject).toBe('Hi {supplier}')
    expect(templateProblems('match', tpl)).toEqual([
      { field: 'subject', message: 'Unknown placeholder {supplier}.' },
    ])
  })

  it('never shows what the owner pays in a quote request', () => {
    const tpl = {
      subject: 'Quote',
      body: '{items}\n{product}: {price_found}, we pay {your_price}, want {target_price}\n{/items}',
    }
    const r = renderTemplate('quote', tpl, facts)
    expect(r.body).not.toContain('11.60')
    expect(r.body).not.toContain('24.00')
    expect(r.body).not.toContain('19.50')
    const messages = templateProblems('quote', tpl).map((p) => p.message)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatch(/\{your_price\} can't be used/)
    expect(messages[1]).toMatch(/\{target_price\} can't be used/)
  })

  it('uses the owner’s current pack for the weekly quantity in a quote', () => {
    const r = renderTemplate(
      'quote',
      {
        subject: 's',
        body: '{items}\n{product}, {pack}: about {weekly_quantity} a week\n{/items}',
      },
      {
        ...facts,
        items: [
          {
            product: 'Whole milk 2L',
            pack: '2L',
            price_found: 1.89,
            weekly_quantity: 12,
            weekly_pack: '6 x 2L',
          },
        ],
      },
    )
    expect(r.body).toBe('Whole milk 2L, 2L: about 12 x 6 x 2L a week')
  })

  it('treats an unknown pack as missing', () => {
    const r = renderTemplate(
      'match',
      { subject: 's', body: '{items}\n{product}\nPack: {pack}\n{/items}' },
      { ...facts, items: [{ ...facts.items[0], pack: 'unknown pack' }] },
    )
    expect(r.body).toBe('Whole milk 2L')
  })

  it('renders an empty products list without leaving a gap', () => {
    const r = renderTemplate('match', DEFAULT_TEMPLATES.match, {
      ...facts,
      items: [],
    })
    expect(r.body).not.toMatch(/\n{3,}/)
  })

  it('writes sensible default emails within the prompt rules', () => {
    const match = renderTemplate('match', DEFAULT_TEMPLATES.match, facts)
    expect(match.subject).toBe('Our prices with you - The Corner Café')
    expect(match.body).toContain(
      '- Whole milk 2L, 6 x 2L: we would need €10.20, about 12% lower\n  We use about 12 x 6 x 2L a week.\n- Coffee beans, 1kg: we would need €19.50, about 19% lower\n\n',
    )
    expect(match.body).toContain('by Friday 14 November')
    expect(match.body).toMatch(/Aoife\nThe Corner Café$/)
    // P6: never what the owner pays now.
    expect(match.body).not.toContain('11.60')

    const quote = renderTemplate('quote', DEFAULT_TEMPLATES.quote, {
      ...facts,
      supplier_name: 'Musgrave MarketPlace',
      items: [
        {
          product: 'Whole milk 2L',
          pack: '6 x 2L',
          price_found: 10.2,
          weekly_quantity: 12,
        },
      ],
    })
    expect(quote.subject).toBe('Trade price enquiry - The Corner Café, Cork')
    expect(quote.body).toContain(
      '- Whole milk 2L, 6 x 2L: I saw it listed at €10.20 ex VAT\n  We use about 12 x 6 x 2L a week.',
    )
    expect(quote.body).not.toContain('Lee Valley')

    for (const r of [match, quote]) {
      expect(words(r.body)).toBeLessThan(150)
      expect(r.body + r.subject).not.toContain('—')
    }
  })
})

describe('templateProblems', () => {
  it('passes the defaults', () => {
    expect(templateProblems('match', DEFAULT_TEMPLATES.match)).toEqual([])
    expect(templateProblems('quote', DEFAULT_TEMPLATES.quote)).toEqual([])
  })

  it('flags product placeholders outside the items block', () => {
    expect(
      templateProblems('match', {
        subject: '{product}',
        body: 'About {product}\n{items}\n{product}\n{/items}',
      }),
    ).toEqual([
      {
        field: 'subject',
        message: '{product} only works between the {items} and {/items} lines.',
      },
      {
        field: 'body',
        message: '{product} only works between the {items} and {/items} lines.',
      },
    ])
  })

  it('flags a missing, unclosed or inline items block', () => {
    const msg = (body: string) =>
      templateProblems('match', { subject: 's', body }).map((p) => p.message)
    expect(msg('Hello')).toEqual([
      'Add the products list: an {items} line, the product lines, then an {/items} line.',
    ])
    expect(msg('{items}\n{product}')).toEqual([
      'Add an {/items} line to end the products list.',
    ])
    expect(msg('{/items}\n{items}\n{product}\n{/items}')).toEqual([
      'There is an {/items} line with no {items}.',
    ])
    expect(msg('{items} {product} {/items}')).toEqual([
      'Put {items} on a line of its own.',
      '{product} only works between the {items} and {/items} lines.',
      'Put {/items} on a line of its own.',
      'Add the products list: an {items} line, the product lines, then an {/items} line.',
    ])
  })

  it('flags a stray curly bracket', () => {
    expect(
      templateProblems('match', {
        subject: 'Prices {business_name',
        body: '{items}\n{product}: we would need {\ntarget_price}\n{/items}',
      }).map((p) => `${p.field}: ${p.message}`),
    ).toEqual([
      'subject: A { or } is not part of a placeholder. Placeholders look like {supplier_name}.',
      'body: A { or } is not part of a placeholder. Placeholders look like {supplier_name}.',
    ])
  })

  it('flags an empty subject or message', () => {
    expect(
      templateProblems('quote', { subject: ' ', body: '' }).map(
        (p) => p.message,
      ),
    ).toEqual([
      'The subject is empty.',
      'The message is empty.',
      'Add the products list: an {items} line, the product lines, then an {/items} line.',
    ])
  })
})

describe('helpers', () => {
  it('describes weekly quantities in the pack bought', () => {
    expect(weeklyQuantity(12, '6 x 2L')).toBe('12 x 6 x 2L')
    expect(weeklyQuantity(43.4, '2L')).toBe('43 x 2L')
    expect(weeklyQuantity(2.46, '1kg')).toBe('2.5 x 1kg')
    expect(weeklyQuantity(3, 'pack of 30')).toBe('3 packs of 30')
    expect(weeklyQuantity(1, 'pack of 30')).toBe('1 pack of 30')
    expect(weeklyQuantity(40, 'single')).toBe('40')
    expect(weeklyQuantity(5, null)).toBe('5')
  })

  it('falls back to the default for each part not saved', () => {
    expect(templateFor('quote', { subject: 'Mine', body: null })).toEqual({
      subject: 'Mine',
      body: DEFAULT_TEMPLATES.quote.body,
    })
  })

  it('gives preview samples that pass their own kind', () => {
    const biz = { business_name: 'B', owner_name: 'O', town: 'T' }
    const q = renderTemplate(
      'quote',
      DEFAULT_TEMPLATES.quote,
      sampleFacts('quote', biz, 7),
    )
    expect(q.body).toContain('€10.20 ex VAT')
    const m = renderTemplate(
      'match',
      DEFAULT_TEMPLATES.match,
      sampleFacts('match', biz, 7),
    )
    expect(m.body).toContain(
      '- Coffee beans, 1kg: we would need €20.40, about 15% lower',
    )
  })

  it('writes the reply date out in full', () => {
    expect(replyByDate(7, new Date('2026-11-07T12:00:00Z'))).toBe(
      'Saturday, 14 November',
    )
  })
})
