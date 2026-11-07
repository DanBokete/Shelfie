import { describe, expect, it } from 'vitest'
import { beatsCurrent, isIsoDate, quoteRows, quoteSaving } from './quote-lines'

const line = (
  over: Partial<Parameters<typeof quoteRows>[0]['lines'][number]> = {},
) => ({
  description: 'Whole Milk 2L x6',
  pack_price: 9.9,
  pack_size: 2,
  pack_unit: 'l' as const,
  units_per_case: 6,
  confidence: 0.95,
  ...over,
})
const doc = (lines: Array<ReturnType<typeof line>>, over = {}) => ({
  lines,
  prices_include_vat: false,
  vat_rate_percent: null,
  document_date: '2026-11-06',
  ...over,
})

describe('quoteRows', () => {
  it('works out the price per ml for a case of 6 x 2L', () => {
    const [r] = quoteRows(doc([line()]), '2026-11-07')
    expect(r.price_per_base_unit).toBeCloseTo(9.9 / 12000, 8)
    expect(r.needs_review).toBe(false)
    expect(r.review_reasons).toEqual([])
    expect(r.observed_on).toBe('2026-11-06')
    expect(r.units_per_case).toBe(6)
  })

  it('reads a per-kg quote as a 1 kg pack', () => {
    const [r] = quoteRows(
      doc([
        line({
          description: 'Coffee beans per kg',
          pack_price: 18,
          pack_size: 1,
          pack_unit: 'kg',
          units_per_case: null,
        }),
      ]),
      '2026-11-07',
    )
    expect(r.price_per_base_unit).toBeCloseTo(0.018, 6)
    expect(r.units_per_case).toBe(1)
  })

  it('takes VAT off when prices include it', () => {
    const [r] = quoteRows(
      doc([line({ pack_price: 12.3, units_per_case: 1, pack_size: 1 })], {
        prices_include_vat: true,
        vat_rate_percent: 23,
      }),
      '2026-11-07',
    )
    expect(r.pack_price).toBeCloseTo(10, 4)
  })

  it('flags VAT-inclusive prices with no rate', () => {
    const [r] = quoteRows(
      doc([line()], { prices_include_vat: true }),
      '2026-11-07',
    )
    expect(r.needs_review).toBe(true)
    expect(r.review_reasons[0]).toMatch(/^VAT:/)
  })

  it('does no maths checks: there are no quantities or totals', () => {
    const [r] = quoteRows(doc([line()]), '2026-11-07')
    expect(r.review_reasons.some((x) => x.startsWith('Maths'))).toBe(false)
  })

  it('flags a line it cannot read well', () => {
    const [r] = quoteRows(doc([line({ confidence: 0.5 })]), '2026-11-07')
    expect(r.needs_review).toBe(true)
    expect(r.review_reasons[0]).toBe('Extraction: hard to read (50%)')
  })

  it('keeps a line with no pack size but flags it and gives no unit price', () => {
    const [r] = quoteRows(
      doc([line({ pack_size: null, pack_unit: null })]),
      '2026-11-07',
    )
    expect(r.price_per_base_unit).toBeNull()
    expect(r.review_reasons).toContain('Pack size unknown')
  })

  it('drops lines with no price and renumbers the rest', () => {
    const rows = quoteRows(
      doc([
        line({ description: 'Butter 250g', pack_price: null }),
        line({ description: 'Eggs x30', pack_price: 0 }),
        line({ description: '  ' }),
        line({
          description: 'Flour 16kg',
          pack_price: 14,
          pack_size: 16,
          pack_unit: 'kg',
          units_per_case: 1,
        }),
      ]),
      '2026-11-07',
    )
    expect(rows.map((r) => [r.line_index, r.raw_description])).toEqual([
      [0, 'Flour 16kg'],
    ])
  })

  it('uses the received date when the document has none or a bad one', () => {
    expect(
      quoteRows(doc([line()], { document_date: null }), '2026-11-07')[0]
        .observed_on,
    ).toBe('2026-11-07')
    expect(
      quoteRows(doc([line()], { document_date: '07/11/2026' }), '2026-11-07')[0]
        .observed_on,
    ).toBe('2026-11-07')
  })
})

describe('helpers', () => {
  it('isIsoDate', () => {
    expect(isIsoDate('2026-11-07')).toBe(true)
    expect(isIsoDate('2026-13-45')).toBe(false)
    expect(isIsoDate(null)).toBe(false)
  })

  it('quoteSaving is rounded and never negative', () => {
    expect(quoteSaving(0.0012, 0.001, 1_000_000)).toBe(200)
    expect(quoteSaving(0.001, 0.0012, 1_000_000)).toBe(0)
    expect(quoteSaving(0.001, 0.0008, null)).toBe(0)
  })

  it('beatsCurrent is strictly below', () => {
    expect(beatsCurrent(0.002, 0.0019)).toBe(true)
    expect(beatsCurrent(0.002, 0.002)).toBe(false)
  })
})
