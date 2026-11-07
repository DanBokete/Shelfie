import { describe, expect, it } from 'vitest'
import { buildRows, cleanRows, sampleRows } from './stocklist'

const messy = cleanRows([
  ['CORNER CAFE - STOCK ORDER SHEET', '', '', '', ''],
  ['', '', '', '', ''],
  ['ITEM', 'amt/mth', 'size', '€', 'who from'],
  ['Wholemilk 2ltr', '173', '2l', '4.2', 'lee'],
  ['', '', '', '', ''],
  ['Expresso beans', '52 cases', '1kg', '€24.00', 'lee'],
  ['TOTAL', '', '', '1234', ''],
  [
    'notes: prices ex vat. ask Lee Valley about milk going up again',
    '',
    '',
    '',
    '',
  ],
])

describe('cleanRows', () => {
  it('drops empty rows and columns', () => {
    expect(messy).toHaveLength(6)
    expect(
      cleanRows([
        ['a', '', 'b'],
        ['c', '', ''],
      ]),
    ).toEqual([
      ['a', 'b'],
      ['c', ''],
    ])
  })
})

describe('buildRows', () => {
  it('applies the mapping and skips header, totals and notes', () => {
    const { items } = buildRows(messy, {
      header_row_index: 1,
      columns: { product_name: 0, quantity: 1, unit: 2, price: 3, supplier: 4 },
      quantity_period: 'month',
      skip_rows: [0],
    })
    expect(items.map((i) => i.raw_name)).toEqual([
      'Wholemilk 2ltr',
      'Expresso beans',
    ])
    expect(items[1]).toEqual({
      raw_name: 'Expresso beans',
      raw_quantity: '52 cases',
      raw_unit: '1kg',
      raw_price: '€24.00',
      raw_supplier: 'lee',
    })
  })

  it('caps at 300 rows', () => {
    const rows = Array.from({ length: 320 }, (_, i) => [`item ${i}`, '1'])
    const r = buildRows(rows, {
      header_row_index: null,
      columns: {
        product_name: 0,
        quantity: 1,
        unit: null,
        price: null,
        supplier: null,
      },
      quantity_period: 'week',
      skip_rows: [],
    })
    expect(r.items).toHaveLength(300)
    expect(r.truncated).toBe(true)
  })
})

describe('sampleRows', () => {
  it('sends the first 10 and last 5 rows with real indexes', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`r${i}`])
    const s = sampleRows(rows)
    expect(s.map((x) => x.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 25, 26, 27, 28, 29,
    ])
    expect(sampleRows(rows.slice(0, 12)).map((x) => x.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ])
  })
})
