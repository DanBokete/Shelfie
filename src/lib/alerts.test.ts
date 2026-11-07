import { describe, expect, it } from 'vitest'
import {
  betterQuoteText,
  biggestWaiting,
  dealKey,
  isWebDeal,
  itemLink,
  testText,
  webPriceText,
  weekWindow,
  weeklyRises,
  weeklyText,
} from './alerts'
import type { Observation } from './savings'

const APP = 'https://shelfie.example/'
const MILK = '11111111-1111-4111-8111-111111111111'

describe('betterQuoteText', () => {
  const q = {
    supplier_name: 'Munster Fresh Foods',
    product_name: 'Whole milk',
    your_ppu: 0.0021,
    quote_ppu: 0.00178,
    base_unit: 'ml' as const,
    annual_saving: 1468,
    product_id: MILK,
  }

  it('reads per litre with the saving and a link', () => {
    expect(betterQuoteText(q, APP)).toBe(
      [
        'Munster Fresh Foods will do Whole milk at €1.78/L (you pay €2.10/L).',
        'Save €1,468/yr.',
        `Tap to view: https://shelfie.example/item/${MILK}`,
      ].join('\n'),
    )
  })

  it('leaves out the saving line when it is 0', () => {
    const text = betterQuoteText({ ...q, annual_saving: 0 }, APP)
    expect(text).not.toContain('Save')
    expect(text.split('\n')).toHaveLength(2)
  })

  it('shows small savings in whole euros', () => {
    expect(betterQuoteText({ ...q, annual_saving: 42 }, APP)).toContain(
      'Save €42/yr.',
    )
  })

  it('reads per kg and each', () => {
    expect(
      betterQuoteText(
        { ...q, base_unit: 'g', your_ppu: 0.024, quote_ppu: 0.0204 },
        APP,
      ),
    ).toContain('at €20.40/kg (you pay €24.00/kg)')
    expect(
      betterQuoteText(
        { ...q, base_unit: 'each', your_ppu: 0.3, quote_ppu: 0.25 },
        APP,
      ),
    ).toContain('at €0.25 each (you pay €0.30 each)')
  })
})

describe('webPriceText', () => {
  const w = {
    seller: 'SuperValu',
    product_name: 'Whole milk',
    current_supplier: 'Lee Valley Wholesale',
    your_ppu: 0.0021,
    offer_ppu: 0.00178,
    base_unit: 'ml' as const,
    annual_saving: 1468,
    product_id: MILK,
  }

  it('says where, how much less, and links to the item', () => {
    expect(webPriceText(w, APP)).toBe(
      [
        'Found Whole milk online at €1.78/L at SuperValu (you pay €2.10/L at Lee Valley Wholesale, 15% less).',
        'Save €1,468/yr.',
        `Tap to view: https://shelfie.example/item/${MILK}`,
      ].join('\n'),
    )
  })

  it('leaves out the saving line when it is 0', () => {
    expect(webPriceText({ ...w, annual_saving: 0 }, APP)).not.toContain('Save')
  })
})

describe('isWebDeal', () => {
  it('needs 5% or more below what the owner pays', () => {
    expect(isWebDeal(2.1, 1.995)).toBe(true) // exactly 5%
    expect(isWebDeal(2.1, 1.996)).toBe(false)
    expect(isWebDeal(2.1, 1.5)).toBe(true)
    expect(isWebDeal(2.1, 2.2)).toBe(false)
  })

  it('ignores missing prices', () => {
    expect(isWebDeal(0, 1)).toBe(false)
    expect(isWebDeal(2, 0)).toBe(false)
  })
})

describe('dealKey', () => {
  it('rounds to the cent per standard unit', () => {
    expect(dealKey(MILK, 'SuperValu', 0.001781, 'ml')).toBe(
      `${MILK}:supervalu:178`,
    )
    expect(dealKey(MILK, ' SuperValu ', 0.0017849, 'ml')).toBe(
      dealKey(MILK, 'supervalu', 0.00178, 'ml'),
    )
  })

  it('changes with the price', () => {
    expect(dealKey(MILK, 'SuperValu', 0.00178, 'ml')).not.toBe(
      dealKey(MILK, 'SuperValu', 0.00175, 'ml'),
    )
  })
})

describe('itemLink', () => {
  it('copes with or without a trailing slash', () => {
    expect(itemLink('http://localhost:3100', 'x')).toBe(
      'http://localhost:3100/item/x',
    )
    expect(itemLink('http://localhost:3100//', 'x')).toBe(
      'http://localhost:3100/item/x',
    )
  })
})

describe('weekWindow', () => {
  it('is the 7 days up to and including the last date', () => {
    expect(weekWindow('2026-10-28')).toEqual({
      from: '2026-10-22',
      to: '2026-10-28',
    })
    expect(weekWindow('2026-03-03')).toEqual({
      from: '2026-02-25',
      to: '2026-03-03',
    })
  })
})

function obs(
  supplier: string,
  date: string,
  ppu: number | null,
  source: Observation['source'] = 'invoice',
): Observation {
  return {
    supplier_id: supplier,
    supplier_name: `${supplier} Ltd`,
    pack_price: 1,
    pack_size: 1,
    pack_unit: 'l',
    units_per_case: 1,
    price_per_base_unit: ppu,
    quantity: 1,
    observed_on: date,
    source,
    raw_description: 'x',
  }
}

describe('weeklyRises', () => {
  const week = { from: '2026-10-22', to: '2026-10-28' }
  const product = (id: string, observations: Array<Observation>) => ({
    id,
    canonical_name: `Product ${id}`,
    base_unit: 'ml' as const,
    observations,
  })

  it('compares this week with the previous price from the same supplier', () => {
    const rises = weeklyRises(
      [
        product('a', [
          obs('lee', '2026-10-05', 0.002),
          obs('lee', '2026-10-12', 0.002),
          obs('lee', '2026-10-26', 0.0022),
        ]),
      ],
      week,
    )
    expect(rises).toHaveLength(1)
    expect(rises[0]).toMatchObject({
      product_id: 'a',
      supplier_name: 'lee Ltd',
      from_ppu: 0.002,
      to_ppu: 0.0022,
    })
    expect(rises[0].pct).toBeCloseTo(0.1)
  })

  it('counts exactly 3% but not less', () => {
    const at = (to: number) =>
      weeklyRises(
        [
          product('a', [
            obs('lee', '2026-10-12', 1),
            obs('lee', '2026-10-26', to),
          ]),
        ],
        week,
      )
    expect(at(1.03)).toHaveLength(1)
    expect(at(1.029)).toHaveLength(0)
  })

  it('ignores a rise from before this week, even when the price is still high', () => {
    expect(
      weeklyRises(
        [
          product('a', [
            obs('lee', '2026-08-03', 0.00189),
            obs('lee', '2026-10-12', 0.0021),
            obs('lee', '2026-10-26', 0.0021),
          ]),
        ],
        week,
      ),
    ).toHaveLength(0)
  })

  it('uses the latest price this week when there are several', () => {
    const rises = weeklyRises(
      [
        product('a', [
          obs('lee', '2026-10-19', 1),
          obs('lee', '2026-10-23', 1.02),
          obs('lee', '2026-10-27', 1.05),
        ]),
      ],
      week,
    )
    expect(rises[0].to_ppu).toBe(1.05)
    expect(rises[0].from_ppu).toBe(1)
  })

  it('needs a price before this week, ignores other sources and later dates', () => {
    expect(
      weeklyRises(
        [
          product('new', [obs('lee', '2026-10-26', 2)]),
          product('web', [
            obs('lee', '2026-10-12', 1),
            obs('lee', '2026-10-26', 2, 'web'),
          ]),
          product('later', [
            obs('lee', '2026-10-12', 1),
            obs('lee', '2026-11-02', 2),
          ]),
        ],
        week,
      ),
    ).toEqual([])
  })

  it('keeps suppliers apart and sorts biggest first', () => {
    const rises = weeklyRises(
      [
        product('a', [
          obs('lee', '2026-10-12', 1),
          obs('harbour', '2026-10-01', 1),
          obs('lee', '2026-10-26', 1.05),
          obs('harbour', '2026-10-24', 1.2),
        ]),
      ],
      week,
    )
    expect(rises.map((r) => r.supplier_name)).toEqual([
      'harbour Ltd',
      'lee Ltd',
    ])
  })
})

describe('biggestWaiting', () => {
  const s = (name: string, saving: number, since = '2026-10-26') => ({
    product_id: name,
    product_name: name,
    annual_saving: saving,
    current_since: since,
  })

  it('picks the biggest saving', () => {
    expect(
      biggestWaiting([s('Butter', 300), s('Whole milk', 1468), s('Tea', 0)], [])
        ?.product_name,
    ).toBe('Whole milk')
  })

  it('skips a product the owner already emailed about', () => {
    expect(
      biggestWaiting(
        [s('Butter', 300), s('Whole milk', 1468)],
        [
          {
            created_at: '2026-11-07T10:00:00Z',
            product_names: ['whole milk '],
          },
        ],
      )?.product_name,
    ).toBe('Butter')
  })

  it('still counts a saving when the email came before the current price', () => {
    expect(
      biggestWaiting(
        [s('Whole milk', 1468, '2026-10-26')],
        [{ created_at: '2026-10-01T10:00:00Z', product_names: ['Whole milk'] }],
      )?.product_name,
    ).toBe('Whole milk')
  })

  it('is null with nothing to save', () => {
    expect(biggestWaiting([s('Tea', 0)], [])).toBeNull()
  })
})

describe('weeklyText', () => {
  const rise = {
    product_id: MILK,
    product_name: 'Whole milk',
    supplier_name: 'Lee Valley Wholesale',
    base_unit: 'ml' as const,
    from_ppu: 0.00189,
    to_ppu: 0.0021,
    pct: 0.1111,
  }
  const waiting = {
    product_id: 'c',
    product_name: 'Coffee beans',
    annual_saving: 1468,
    current_since: '2026-10-26',
  }

  it('matches the plan in 4 lines', () => {
    expect(
      weeklyText(
        { rises: [rise, rise, rise], waiting },
        'http://localhost:3100',
      ),
    ).toBe(
      [
        'Shelfie weekly: 3 price rises this week',
        'Whole milk up 11% at Lee Valley Wholesale (now €2.10/L)',
        'Biggest saving waiting: switch Coffee beans, save €1,468/yr',
        'Tap to fix: http://localhost:3100/audit',
      ].join('\n'),
    )
  })

  it('says one rise, and no rises', () => {
    expect(weeklyText({ rises: [rise], waiting }, APP)).toMatch(
      /^Shelfie weekly: 1 price rise this week\n/,
    )
    const none = weeklyText({ rises: [], waiting: null }, APP)
    expect(none).toBe(
      [
        'Shelfie weekly: no price rises this week',
        'Tap to fix: https://shelfie.example/audit',
      ].join('\n'),
    )
  })
})

describe('testText', () => {
  it('links to the app', () => {
    expect(testText(APP)).toContain('https://shelfie.example/')
  })
})

describe('no em dashes', () => {
  it('in any template', () => {
    const all = [
      testText(APP),
      weeklyText({ rises: [], waiting: null }, APP),
    ].join('\n')
    expect(all).not.toContain('—')
  })
})
