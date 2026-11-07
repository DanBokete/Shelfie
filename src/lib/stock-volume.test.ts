import { describe, expect, it } from 'vitest'
import { stockAnnualUnits } from './stock-volume'

const twoLitre = { pack_size: 2, pack_unit: 'l' as const, units_per_case: 1 }

describe('yearly use from the stock list', () => {
  it('is packs a week x 52 x what a pack holds', () => {
    // 40 x 2L a week = 4,160 litres a year
    expect(
      stockAnnualUnits(
        [{ weekly_quantity: 40, pack_spec: twoLitre }],
        'ml',
        null,
      ),
    ).toBe(40 * 52 * 2000)
  })

  it('counts a line with no pack size in the pack bought now', () => {
    expect(
      stockAnnualUnits([{ weekly_quantity: 10, pack_spec: null }], 'ml', {
        pack_size: 6,
        pack_unit: 'l',
        units_per_case: 2,
      }),
    ).toBe(10 * 52 * 12000)
  })

  it('adds up a product listed more than once', () => {
    expect(
      stockAnnualUnits(
        [
          { weekly_quantity: 40, pack_spec: twoLitre },
          { weekly_quantity: 5, pack_spec: null },
        ],
        'ml',
        { pack_size: 1, pack_unit: 'l', units_per_case: 1 },
      ),
    ).toBe(40 * 52 * 2000 + 5 * 52 * 1000)
  })

  it('ignores a pack in the wrong unit and falls back to the current pack', () => {
    expect(
      stockAnnualUnits(
        [
          {
            weekly_quantity: 2,
            pack_spec: { pack_size: 1, pack_unit: 'kg', units_per_case: 1 },
          },
        ],
        'ml',
        twoLitre,
      ),
    ).toBe(2 * 52 * 2000)
  })

  it('is null when nothing can be counted, so invoice history is used', () => {
    expect(
      stockAnnualUnits(
        [{ weekly_quantity: null, pack_spec: twoLitre }],
        'ml',
        null,
      ),
    ).toBeNull()
    expect(
      stockAnnualUnits(
        [{ weekly_quantity: 0, pack_spec: twoLitre }],
        'ml',
        null,
      ),
    ).toBeNull()
    expect(
      stockAnnualUnits([{ weekly_quantity: 3, pack_spec: null }], 'ml', null),
    ).toBeNull()
    expect(stockAnnualUnits([], 'ml', twoLitre)).toBeNull()
  })
})
