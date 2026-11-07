import { describe, expect, it } from 'vitest'
import { exVat, lineChecks } from './checks'
import type { InvoiceExtraction } from './schemas'

function inv(
  lines: Array<[number, number, number]>,
  subtotal: number | null,
): InvoiceExtraction {
  return {
    supplier_name: 'Lee Valley Wholesale',
    invoice_number: '1',
    invoice_date: '2026-08-03',
    prices_include_vat: false,
    vat_rate_percent: null,
    subtotal_ex_vat: subtotal,
    adjustments: [],
    lines: lines.map(([q, p, t]) => ({
      description: 'x',
      quantity: q,
      pack_price: p,
      line_total: t,
      pack_size: 1,
      pack_unit: 'each',
      units_per_case: 1,
      barcode: null,
      confidence: 0.95,
    })),
  }
}

describe('lineChecks', () => {
  it('passes clean invoices', () => {
    expect(
      lineChecks(
        inv(
          [
            [2, 3.5, 7],
            [1, 10, 10],
          ],
          17,
        ),
      ),
    ).toEqual([[], []])
  })

  it('flags a line whose total does not match', () => {
    const r = lineChecks(
      inv(
        [
          [2, 3.5, 7],
          [4, 10, 50],
        ],
        57,
      ),
    )
    expect(r[0]).toEqual([])
    expect(r[1][0]).toMatch(/^Maths: 4 x 10.00 = 40.00/)
  })

  it('tolerates rounding within 2%', () => {
    expect(lineChecks(inv([[3, 3.33, 10]], 10))).toEqual([[]])
  })

  it('flags every line when only the subtotal is off', () => {
    const r = lineChecks(
      inv(
        [
          [1, 5, 5],
          [1, 5, 5],
        ],
        20,
      ),
    )
    expect(r.every((x) => x.length === 1 && x[0].includes('subtotal'))).toBe(
      true,
    )
  })

  it('flags low confidence', () => {
    const x = inv([[1, 5, 5]], 5)
    x.lines[0].confidence = 0.5
    expect(lineChecks(x)[0]).toEqual(['Extraction: hard to read (50%)'])
  })
})

describe('exVat', () => {
  it('strips VAT', () => {
    expect(exVat(12.3, 23)).toBe(10)
    expect(exVat(5, null)).toBe(5)
  })
})
