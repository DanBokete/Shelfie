import { describe, expect, it } from 'vitest'
import {
  annualBaseUnits,
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
