import { describe, expect, it } from 'vitest'
import {
  agreedPrice,
  annualBaseUnits,
  brokenPromises,
  classify,
  daysCovered,
  hasTwoPrices,
  priceCreep,
  productInsight,
} from './savings'
import type { Observation } from './savings'

function milk(
  supplier: 'A' | 'B' | 'C',
  date: string,
  perCarton: number,
  quantity: number | null,
  source: Observation['source'] = 'invoice',
  perCase = 1,
): Observation {
  const pack_price = perCarton * perCase
  return {
    supplier_id: supplier,
    supplier_name: `Supplier ${supplier}`,
    pack_price,
    pack_size: 2,
    pack_unit: 'l',
    units_per_case: perCase,
    price_per_base_unit: pack_price / (2000 * perCase),
    quantity,
    observed_on: date,
    source,
    raw_description: 'milk',
  }
}

const period = { first: '2026-08-03', last: '2026-10-26' }

describe('daysCovered', () => {
  it('has a 30 day minimum', () => {
    expect(daysCovered('2026-08-01', '2026-08-05')).toBe(30)
    expect(daysCovered('2026-08-03', '2026-10-26')).toBe(84)
  })
})

describe('annualBaseUnits', () => {
  it('annualises invoice volume over the covered period', () => {
    const obs = [
      milk('A', '2026-08-03', 3.78, 18),
      milk('A', '2026-10-26', 4.2, 18),
    ]
    // 36 cartons x 2000 ml over 84 days
    expect(annualBaseUnits(obs, period)).toBeCloseTo((72000 / 84) * 365, 6)
  })

  it('ignores price lists and unknown pack sizes', () => {
    const obs = [milk('B', '2026-09-01', 3.55, null, 'price_list', 6)]
    expect(annualBaseUnits(obs, period)).toBeNull()
  })
})

describe('productInsight', () => {
  const obs = [
    milk('A', '2026-08-03', 3.78, 18),
    milk('A', '2026-09-07', 4.0, 18),
    milk('A', '2026-10-26', 4.2, 18),
    milk('B', '2026-08-01', 3.55, null, 'price_list', 6),
    milk('C', '2026-09-15', 3.95, 4),
  ]

  it('finds current, cheapest and the saving (hand calculation)', () => {
    const r = productInsight(obs, { period })
    expect(r.current?.supplier_id).toBe('A')
    expect(r.current?.pack_price).toBe(4.2)
    expect(r.cheapest?.supplier_id).toBe('B')
    expect(r.suppliers.map((s) => s.supplier_id)).toEqual(['B', 'C', 'A'])
    expect(r.pct_cheaper).toBeCloseTo(0.65 / 4.2, 6)
    // volume: (3 x 18 + 4) cartons x 2000 ml = 116000 ml over 84 days
    const volume = (116000 / 84) * 365
    expect(r.annual_saving).toBe(Math.round(((4.2 - 3.55) / 2000) * volume))
  })

  it('reports price creep at the current supplier', () => {
    const r = productInsight(obs, { period })
    expect(r.creep?.pct).toBeCloseTo(4.2 / 3.78 - 1, 6)
    expect(r.creep?.from_date).toBe('2026-08-03')
  })

  it('never shows a negative saving', () => {
    const r = productInsight(
      [milk('A', '2026-10-01', 3.0, 10), milk('B', '2026-10-01', 3.5, 10)],
      {
        period,
      },
    )
    expect(r.cheapest).toBeNull()
    expect(r.annual_saving).toBe(0)
    expect(classify(r)).toBe('two_prices')
  })

  it('accepts a stock-list override for volume', () => {
    const r = productInsight(obs, { period, annual_base_units: 20 * 52 * 2000 })
    expect(r.annual_saving).toBe(Math.round((0.65 / 2000) * 20 * 52 * 2000))
  })
})

describe('priceCreep', () => {
  it('ignores rises under 3%', () => {
    expect(
      priceCreep(
        [milk('A', '2026-08-01', 4.0, 1), milk('A', '2026-10-01', 4.1, 1)],
        'A',
      ),
    ).toBeNull()
  })
})

describe('hasTwoPrices', () => {
  it('only counts the last 60 days', () => {
    const obs = [
      milk('A', '2026-07-01', 3.0, 1),
      milk('C', '2026-10-01', 3.5, 1),
    ]
    expect(hasTwoPrices(obs, '2026-10-26')).toBe(false)
  })
})

describe('classify', () => {
  it('puts items in priority order', () => {
    expect(classify(null)).toBe('no_data')
    expect(
      classify(productInsight([milk('A', '2026-10-01', 3.0, 1)], { period })),
    ).toBe('best')
    expect(
      classify(
        productInsight(
          [milk('A', '2026-08-01', 3.0, 1), milk('A', '2026-10-01', 3.3, 1)],
          { period },
        ),
      ),
    ).toBe('creep')
    expect(
      classify(
        productInsight(
          [
            milk('A', '2026-10-01', 4.0, 1),
            milk('B', '2026-10-01', 3.0, null, 'price_list'),
          ],
          {
            period,
          },
        ),
      ),
    ).toBe('switch')
  })
})

describe('agreed prices', () => {
  // A buys from Supplier A at €4.20 a carton; A agreed €3.55 on 7 Nov.
  const base = [
    milk('A', '2026-08-03', 4.2, 18),
    milk('A', '2026-10-26', 4.2, 18),
    milk('B', '2026-10-20', 3.8, null, 'price_list'),
  ]
  const agreed = milk('A', '2026-11-07', 3.55, null, 'agreed')

  it('uses the agreed price as what the owner pays', () => {
    const i = productInsight([...base, agreed], { period })
    expect(i.current?.source).toBe('agreed')
    expect(i.current?.pack_price).toBe(3.55)
    expect(i.agreed?.agreed_on).toBe('2026-11-07')
    expect(i.agreed?.was.pack_price).toBe(4.2)
    expect(i.agreed?.per_unit_saving).toBeCloseTo((4.2 - 3.55) / 2000)
    // 36 cartons over 84 days, annualised, at 65c a carton less.
    expect(i.agreed?.annual_saving).toBe(Math.round(0.65 * ((36 / 84) * 365)))
  })

  it('compares other suppliers against the agreed price', () => {
    const before = productInsight(base, { period })
    expect(before.cheapest?.supplier_id).toBe('B')
    const after = productInsight([...base, agreed], { period })
    expect(after.cheapest).toBeNull()
    expect(after.per_unit_saving).toBe(0)
    expect(classify(after)).toBe('best')
  })

  it('still counts a cheaper supplier below the agreed price', () => {
    const i = productInsight(
      [...base, agreed, milk('C', '2026-11-01', 3.2, null, 'price_list')],
      { period },
    )
    expect(i.cheapest?.supplier_id).toBe('C')
    expect(i.per_unit_saving).toBeCloseTo((3.55 - 3.2) / 2000)
  })

  it('ignores a price a fraction of a cent below the agreed one', () => {
    // Asked to match €3.5480, agreed €3.55.
    const i = productInsight(
      [...base, agreed, milk('C', '2026-11-01', 3.548, null, 'price_list')],
      { period },
    )
    expect(i.cheapest).toBeNull()
    expect(classify(i)).toBe('best')
  })

  it('wins over an invoice from the same day', () => {
    const sameDay = milk('A', '2026-10-26', 3.55, null, 'agreed')
    expect(agreedPrice([...base, sameDay], 'A')?.price.pack_price).toBe(3.55)
  })

  it('ends with a newer invoice from that supplier', () => {
    const next = milk('A', '2026-11-14', 3.55, 18)
    const i = productInsight([...base, agreed, next], { period })
    expect(i.current?.source).toBe('invoice')
    expect(i.agreed).toBeNull()
  })

  it('only applies to the current supplier', () => {
    const i = productInsight(
      [...base, milk('B', '2026-11-07', 3.5, null, 'agreed')],
      { period },
    )
    expect(i.current?.supplier_id).toBe('A')
    expect(i.agreed).toBeNull()
    expect(i.cheapest?.supplier_id).toBe('B')
    expect(i.cheapest?.pack_price).toBe(3.5)
  })

  it('is ignored when the current price is given (stock list)', () => {
    const given = productInsight([...base, agreed], { period }).agreed!.was
    const i = productInsight([...base, agreed], { period, current: given })
    expect(i.agreed).toBeNull()
    expect(i.current?.pack_price).toBe(4.2)
  })
})

describe('brokenPromises', () => {
  const agreed = milk('A', '2026-11-07', 3.55, null, 'agreed')

  it('flags the next invoice that charges more than agreed', () => {
    const inv = { ...milk('A', '2026-11-14', 4.2, 18), invoice_id: 'inv-1' }
    const [b, ...rest] = brokenPromises([agreed, inv])
    expect(rest).toHaveLength(0)
    expect(b.supplier_name).toBe('Supplier A')
    expect(b.agreed_on).toBe('2026-11-07')
    expect(b.agreed_pack_price).toBe(3.55)
    expect(b.charged_pack_price).toBe(4.2)
    expect(b.invoice_id).toBe('inv-1')
    const i = productInsight([agreed, inv], { period })
    expect(i.not_honoured?.invoice_on).toBe('2026-11-14')
  })

  it('states the charge in the agreed pack', () => {
    // A case of 6 at €25.20 is €4.20 a carton.
    const inv = milk('A', '2026-11-14', 4.2, 3, 'invoice', 6)
    expect(brokenPromises([agreed, inv])[0].charged_pack_price).toBe(4.2)
  })

  it('accepts an invoice at or below the agreed price, and rounding', () => {
    expect(brokenPromises([agreed, milk('A', '2026-11-14', 3.55, 18)])).toEqual(
      [],
    )
    expect(brokenPromises([agreed, milk('A', '2026-11-14', 3.56, 18)])).toEqual(
      [],
    )
    expect(brokenPromises([agreed, milk('A', '2026-11-14', 3.4, 18)])).toEqual(
      [],
    )
  })

  it('ignores invoices from before, the same day, and other suppliers', () => {
    expect(
      brokenPromises([
        agreed,
        milk('A', '2026-11-01', 4.2, 18),
        milk('A', '2026-11-07', 4.2, 18),
        milk('B', '2026-11-14', 4.2, 18),
      ]),
    ).toEqual([])
  })

  it('checks only the first invoice after the agreement', () => {
    const obs = [
      agreed,
      milk('A', '2026-11-14', 3.55, 18),
      milk('A', '2026-11-21', 4.2, 18),
    ]
    expect(brokenPromises(obs)).toEqual([])
  })

  it('checks against the newer agreement once there is one', () => {
    const obs = [
      agreed,
      milk('A', '2026-11-10', 3.9, null, 'agreed'),
      milk('A', '2026-11-14', 3.8, 18),
    ]
    expect(brokenPromises(obs)).toEqual([])
  })
})
