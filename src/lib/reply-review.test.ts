import { describe, expect, it } from 'vitest'
import {
  PACK_ASSUMED,
  PACK_UNKNOWN,
  VAT_UNKNOWN,
  answerLines,
  compareLine,
  currentOutcomes,
  describe as describeLine,
  notHonouredText,
  offerPrice,
  outcomeLabel,
  replyStatus,
  requestItems,
} from './reply-review'
import type { RequestItem, StoredOutcome } from './reply-review'
import type { ReplyAnswer, ReplyOutcome } from './schemas'

const butter: RequestItem = {
  index: 0,
  product_id: 'butter',
  product_name: 'Salted butter',
  pack: { pack_size: 454, pack_unit: 'g', units_per_case: 1 },
  asked_price: 2.91,
  your_price: 3.26,
}
const chicken: RequestItem = {
  index: 1,
  product_id: 'chicken',
  product_name: 'Chicken breast fillets',
  pack: { pack_size: 2, pack_unit: 'kg', units_per_case: 1 },
  asked_price: 17,
  your_price: 17.8,
}

function answer(over: Partial<ReplyAnswer>): ReplyAnswer {
  return {
    request_item: 'R1',
    product_hint: null,
    outcome: 'accepted',
    said: '',
    question: null,
    offer_price: null,
    offer_pack: null,
    pack_size: null,
    pack_unit: null,
    units_per_case: null,
    price_includes_vat: false,
    ...over,
  }
}

function read(
  overall: ReplyOutcome,
  answers: Array<ReplyAnswer>,
  said = 'They replied.',
) {
  return { overall, overall_said: said, answers }
}

describe('requestItems', () => {
  it('reads "Ask to match" items, with the asked price or the best price', () => {
    const items = requestItems('match', [
      {
        product_id: 'butter',
        product_name: 'Salted butter',
        pack_label: '454g',
        your_price: 3.26,
        best_price: 2.91,
      },
      {
        product_id: 'milk',
        product_name: 'Whole milk',
        your_price: 2.1,
        best_price: 1.9,
        asked_price: 1.75,
        pack_size: 2,
        pack_unit: 'l',
        units_per_case: 1,
      },
      'junk',
      { your_price: 1 },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      index: 0,
      product_id: 'butter',
      asked_price: 2.91,
      your_price: 3.26,
      pack: null,
    })
    expect(items[1]).toMatchObject({
      index: 1,
      asked_price: 1.75,
      pack: { pack_size: 2, pack_unit: 'l', units_per_case: 1 },
    })
  })

  it('reads "Ask for a quote" items by product name only', () => {
    const items = requestItems('quote', [
      { product: 'Whole milk', price_seen: '€1.78 ex VAT per 2 l' },
    ])
    expect(items).toEqual([
      {
        index: 0,
        product_id: null,
        product_name: 'Whole milk',
        pack: null,
        asked_price: null,
        your_price: null,
      },
    ])
  })
})

describe('answerLines', () => {
  it('turns a bare yes into an accepted line at the asked price', () => {
    const r = answerLines(read('accepted', [], 'Yes thats perfect'), [butter])
    expect(r.outcomes).toEqual([
      expect.objectContaining({ request_item: null, outcome: 'accepted' }),
      expect.objectContaining({
        request_item: 0,
        product_id: 'butter',
        outcome: 'accepted',
      }),
    ])
    expect(r.lines).toEqual([
      {
        request_item: 0,
        line_index: 0,
        origin: 'accepted',
        raw_description: 'Salted butter, 454g',
        pack_price: 2.91,
        pack_size: 454,
        pack_unit: 'g',
        units_per_case: 1,
        product_id: 'butter',
        review_reasons: [],
      },
    ])
  })

  it('parses "I can do 15.00 per kg" as a counter-offer per kg', () => {
    const r = answerLines(
      read('counter_offer', [
        answer({
          request_item: 'R2',
          outcome: 'counter_offer',
          said: 'I can do 15.00 per kg',
          offer_price: 15,
          offer_pack: 'stated',
          pack_size: 1,
          pack_unit: 'kg',
        }),
      ]),
      [chicken].map((c) => ({ ...c, index: 1 })),
    )
    expect(r.outcomes[1]).toMatchObject({
      request_item: 1,
      outcome: 'counter_offer',
      pack_price: 15,
      pack_size: 1,
      pack_unit: 'kg',
      units_per_case: 1,
      said: 'I can do 15.00 per kg',
    })
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({
      origin: 'read',
      raw_description: 'Chicken breast fillets, 1kg',
      pack_price: 15,
      pack_size: 1,
      pack_unit: 'kg',
      product_id: 'chicken',
      review_reasons: [],
    })
  })

  it('reads "per pack" as the pack the request was about', () => {
    const r = answerLines(
      read('counter_offer', [
        answer({
          request_item: 'R2',
          outcome: 'counter_offer',
          offer_price: 9.5,
          offer_pack: 'requested',
        }),
      ]),
      [chicken],
    )
    expect(r.lines[0]).toMatchObject({
      raw_description: 'Chicken breast fillets, 2kg',
      pack_price: 9.5,
      pack_size: 2,
      pack_unit: 'kg',
      review_reasons: [],
    })
  })

  it('assumes the requested pack when the reply names none, and says so', () => {
    const r = answerLines(
      read('counter_offer', [
        answer({
          outcome: 'counter_offer',
          offer_price: 3.5,
          offer_pack: 'unknown',
        }),
      ]),
      [butter],
    )
    expect(r.lines[0]).toMatchObject({
      pack_price: 3.5,
      pack_size: 454,
      review_reasons: [PACK_ASSUMED],
    })
  })

  it('flags a price that includes VAT', () => {
    const r = answerLines(
      read('counter_offer', [
        answer({
          outcome: 'counter_offer',
          offer_price: 3.1,
          offer_pack: 'requested',
          price_includes_vat: true,
        }),
      ]),
      [butter],
    )
    expect(r.lines[0].review_reasons).toEqual([VAT_UNKNOWN])
  })

  it('records a decline or a question without a line', () => {
    const no = answerLines(
      read('declined', [answer({ outcome: 'declined', said: 'Sorry, no' })]),
      [butter],
    )
    expect(no.lines).toEqual([])
    expect(no.outcomes[1]).toMatchObject({
      outcome: 'declined',
      said: 'Sorry, no',
    })

    const q = answerLines(
      read('needs_info', [
        answer({ outcome: 'needs_info', question: 'How many a week?' }),
      ]),
      [butter],
    )
    expect(q.lines).toEqual([])
    expect(q.outcomes[1].question).toBe('How many a week?')
  })

  it('gives unanswered items the overall answer, but never an invented counter-offer', () => {
    const yes = answerLines(read('accepted', []), [butter, chicken])
    expect(yes.lines.map((l) => l.product_id)).toEqual(['butter', 'chicken'])
    expect(yes.lines.map((l) => l.line_index)).toEqual([0, 1])

    const counter = answerLines(read('counter_offer', []), [butter])
    expect(counter.lines).toEqual([])
    expect(counter.outcomes[1].outcome).toBe('unclear')
  })

  it('does not make an accepted line without an asked price', () => {
    const r = answerLines(read('accepted', []), [
      { ...butter, asked_price: null },
    ])
    expect(r.lines).toEqual([])
    expect(r.outcomes[1].outcome).toBe('accepted')
  })

  it('keeps an offer when the request is unknown, for the owner to place', () => {
    const r = answerLines(
      read('counter_offer', [
        answer({
          request_item: null,
          product_hint: 'chicken breast fillets',
          outcome: 'counter_offer',
          offer_price: 9.5,
          offer_pack: 'requested',
        }),
      ]),
      [],
    )
    expect(r.outcomes).toHaveLength(1)
    expect(r.outcomes[0]).toMatchObject({
      request_item: null,
      outcome: 'counter_offer',
      pack_price: 9.5,
    })
    expect(r.lines).toEqual([
      expect.objectContaining({
        request_item: null,
        product_id: null,
        raw_description: 'chicken breast fillets',
        pack_price: 9.5,
        review_reasons: [PACK_UNKNOWN],
      }),
    ])
  })

  it('reads each request item once', () => {
    const r = answerLines(
      read('accepted', [
        answer({ outcome: 'accepted' }),
        answer({ outcome: 'declined' }),
      ]),
      [butter],
    )
    expect(r.outcomes.filter((o) => o.request_item === 0)).toHaveLength(1)
    expect(r.lines).toHaveLength(1)
  })
})

describe('outcomeLabel and offerPrice', () => {
  const none = {
    pack_price: null,
    pack_size: null,
    pack_unit: null,
    units_per_case: null,
  }
  it('says what was agreed', () => {
    expect(outcomeLabel(null)).toBe('Waiting')
    expect(
      outcomeLabel({ ...none, outcome: 'accepted', asked_price: 3.55 }),
    ).toBe('Accepted €3.55')
    expect(outcomeLabel({ ...none, outcome: 'accepted' })).toBe('Accepted')
    expect(
      outcomeLabel({
        outcome: 'counter_offer',
        pack_price: 15,
        pack_size: 1,
        pack_unit: 'kg',
        units_per_case: 1,
      }),
    ).toBe('Countered €15.00/kg')
    expect(outcomeLabel({ ...none, outcome: 'declined' })).toBe('Declined')
    expect(outcomeLabel({ ...none, outcome: 'needs_info' })).toBe('Needs info')
  })

  it('shows a pack price for a bigger pack', () => {
    expect(
      offerPrice({
        pack_price: 9.5,
        pack_size: 2,
        pack_unit: 'kg',
        units_per_case: 1,
      }),
    ).toBe('€9.50 per 2kg')
    expect(
      offerPrice({
        pack_price: 0.5,
        pack_size: 1,
        pack_unit: 'each',
        units_per_case: 1,
      }),
    ).toBe('€0.50 each')
    expect(
      offerPrice({
        pack_price: 4,
        pack_size: null,
        pack_unit: null,
        units_per_case: null,
      }),
    ).toBe('€4.00')
  })
})

describe('currentOutcomes', () => {
  const row = (
    reply: string,
    at: string,
    outcome: ReplyOutcome,
    item: number | null,
  ): StoredOutcome => ({
    inbound_email_id: reply,
    received_at: at,
    request_item: item,
    product_id: null,
    outcome,
    pack_price: null,
    pack_size: null,
    pack_unit: null,
    units_per_case: null,
    said: null,
    question: null,
  })
  it('takes the rows of the newest reply', () => {
    const rows = [
      row('a', '2026-11-07T10:00:00Z', 'needs_info', null),
      row('a', '2026-11-07T10:00:00Z', 'needs_info', 0),
      row('b', '2026-11-08T10:00:00Z', 'accepted', 0),
      row('b', '2026-11-08T10:00:00Z', 'accepted', null),
    ]
    expect(
      currentOutcomes(rows).map((r) => [r.inbound_email_id, r.request_item]),
    ).toEqual([
      ['b', null],
      ['b', 0],
    ])
    expect(currentOutcomes([])).toEqual([])
  })
})

describe('compareLine', () => {
  const insight = {
    current: {
      supplier_id: 'lv',
      supplier_name: 'Lee Valley',
      ppu: 3.26 / 454,
      pack_price: 3.26,
      pack_size: 454,
      pack_unit: 'g',
      units_per_case: 1,
      observed_on: '2026-10-26',
      source: 'invoice' as const,
      raw_description: 'BUTTER 454G',
      source_url: null,
    },
    annual_base_units: 454 * 1000,
  }

  it('compares a cheaper price per unit and the yearly saving', () => {
    const c = compareLine(
      { pack_price: 2.91, pack_size: 454, pack_unit: 'g', units_per_case: 1 },
      'g',
      insight,
    )
    expect(c.better).toBe(true)
    expect(c.your_supplier).toBe('Lee Valley')
    expect(c.your_pack_price).toBe(3.26)
    expect(c.diff_pct).toBeCloseTo(0.35 / 3.26)
    expect(c.annual_saving).toBe(350) // 1000 packs a year, 35c each
  })

  it('compares across pack sizes', () => {
    const c = compareLine(
      { pack_price: 6.5, pack_size: 1, pack_unit: 'kg', units_per_case: 1 },
      'g',
      insight,
    )
    expect(c.ppu).toBeCloseTo(0.0065)
    expect(c.better).toBe(true)
    expect(c.your_pack_price).toBeCloseTo(7.18, 2)
  })

  it('marks a dearer price as not better, with no saving', () => {
    const c = compareLine(
      { pack_price: 3.5, pack_size: 454, pack_unit: 'g', units_per_case: 1 },
      'g',
      insight,
    )
    expect(c.better).toBe(false)
    expect(c.annual_saving).toBe(0)
    expect(c.diff_pct).toBeLessThan(0)
  })

  it('cannot price an unknown pack or the wrong unit', () => {
    expect(
      compareLine(
        {
          pack_price: 9.5,
          pack_size: null,
          pack_unit: null,
          units_per_case: 1,
        },
        'g',
        insight,
      ).problem,
    ).toBe(PACK_UNKNOWN)
    const c = compareLine(
      { pack_price: 15, pack_size: 1, pack_unit: 'kg', units_per_case: 1 },
      'each',
      insight,
    )
    expect(c.better).toBeNull()
    expect(c.problem).toMatch(/Unit mismatch/)
  })

  it('has nothing to compare when the owner buys none', () => {
    const c = compareLine(
      { pack_price: 2.91, pack_size: 454, pack_unit: 'g', units_per_case: 1 },
      'g',
      null,
    )
    expect(c.ppu).toBeCloseTo(2.91 / 454)
    expect(c.better).toBeNull()
  })
})

describe('replyStatus', () => {
  const s = (...xs: Array<'proposed' | 'applied' | 'rejected'>) =>
    replyStatus(xs.map((status) => ({ status })))
  it('says what is left on a reply', () => {
    expect(s('proposed', 'applied').label).toBe('Waiting for review (1 line)')
    expect(s('proposed', 'proposed').label).toBe('Waiting for review (2 lines)')
    expect(s('applied', 'applied').kind).toBe('applied')
    expect(s('rejected').kind).toBe('rejected')
    expect(s('applied', 'rejected')).toMatchObject({
      kind: 'partly',
      label: 'Partly applied',
    })
    expect(s().kind).toBe('nothing')
    expect(
      replyStatus([
        { status: 'proposed', kind: 'invoice' },
        { status: 'proposed' },
        { status: 'proposed' },
      ]).label,
    ).toBe('Waiting for review (2 lines, 1 invoice)')
    expect(replyStatus([{ status: 'proposed', kind: 'invoice' }]).label).toBe(
      'Waiting for review (1 invoice)',
    )
  })
})

describe('notHonouredText', () => {
  it('says what was charged against what was agreed', () => {
    expect(
      notHonouredText(
        {
          supplier_name: 'Lee Valley',
          charged_pack_price: 4.2,
          agreed_pack_price: 3.55,
          agreed_on: '2026-11-07',
        },
        'Whole milk',
      ),
    ).toBe(
      'Lee Valley charged €4.20 for Whole milk, but agreed €3.55 on 7 Nov.',
    )
  })
})

describe('describe', () => {
  const pack = { pack_size: 2, pack_unit: 'kg' as const, units_per_case: 1 }
  it('adds the pack once', () => {
    expect(describeLine('Chicken breast fillets', pack)).toBe(
      'Chicken breast fillets, 2kg',
    )
    expect(describeLine('Chicken breast fillets, 2 KG', pack)).toBe(
      'Chicken breast fillets, 2 KG',
    )
    expect(describeLine('Chicken', null)).toBe('Chicken')
  })
})
