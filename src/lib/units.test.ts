import { describe, expect, it } from 'vitest'
import {
  baseUnitsPerPack,
  describePack,
  perStandardUnit,
  pricePerBaseUnit,
  toBase,
} from './units'

describe('toBase', () => {
  it('converts litres and kilos', () => {
    expect(toBase(2, 'l')).toEqual({ size: 2000, unit: 'ml' })
    expect(toBase(1.5, 'kg')).toEqual({ size: 1500, unit: 'g' })
    expect(toBase(33, 'cl')).toEqual({ size: 330, unit: 'ml' })
    expect(toBase(500, 'g')).toEqual({ size: 500, unit: 'g' })
    expect(toBase(1, 'each')).toEqual({ size: 1, unit: 'each' })
  })
})

describe('pricePerBaseUnit', () => {
  it('handles a case of 12 x 2L (the plan example)', () => {
    const r = pricePerBaseUnit(18, {
      pack_size: 2,
      pack_unit: 'l',
      units_per_case: 12,
    })
    expect(r?.unit).toBe('ml')
    expect(r?.price).toBeCloseTo(0.00075, 10)
    // displays as EUR 1.50 per 2L
    expect(r!.price * 2000).toBeCloseTo(1.5, 10)
  })

  it('handles a single 2L carton', () => {
    const r = pricePerBaseUnit(4.2, {
      pack_size: 2,
      pack_unit: 'l',
      units_per_case: 1,
    })
    expect(r?.price).toBeCloseTo(0.0021, 10)
  })

  it('handles kilos', () => {
    const r = pricePerBaseUnit(61.2, {
      pack_size: 3,
      pack_unit: 'kg',
      units_per_case: null,
    })
    expect(r?.unit).toBe('g')
    expect(perStandardUnit(r!.price, r!.unit)).toBeCloseTo(20.4, 10)
  })

  it('handles single items and packs of items', () => {
    expect(
      pricePerBaseUnit(0.5, {
        pack_size: null,
        pack_unit: 'each',
        units_per_case: null,
      }),
    ).toEqual({
      price: 0.5,
      unit: 'each',
    })
    const tray = pricePerBaseUnit(8.4, {
      pack_size: 30,
      pack_unit: 'each',
      units_per_case: 1,
    })
    expect(tray?.price).toBeCloseTo(0.28, 10)
    const cups = pricePerBaseUnit(45, {
      pack_size: 50,
      pack_unit: 'each',
      units_per_case: 20,
    })
    expect(cups?.price).toBeCloseTo(0.045, 10)
  })

  it('returns null when the pack size is unknown', () => {
    expect(
      pricePerBaseUnit(3, {
        pack_size: null,
        pack_unit: 'l',
        units_per_case: 6,
      }),
    ).toBeNull()
    expect(
      pricePerBaseUnit(3, { pack_size: 2, pack_unit: null, units_per_case: 6 }),
    ).toBeNull()
    expect(
      pricePerBaseUnit(3, { pack_size: 0, pack_unit: 'g', units_per_case: 1 }),
    ).toBeNull()
  })

  it('treats a missing units_per_case as 1', () => {
    expect(
      baseUnitsPerPack({
        pack_size: 500,
        pack_unit: 'g',
        units_per_case: null,
      }),
    ).toEqual({
      amount: 500,
      unit: 'g',
    })
  })
})

describe('describePack', () => {
  it('formats packs', () => {
    expect(
      describePack({ pack_size: 2, pack_unit: 'l', units_per_case: 6 }),
    ).toBe('6 x 2L')
    expect(
      describePack({ pack_size: 3, pack_unit: 'kg', units_per_case: 1 }),
    ).toBe('3kg')
    expect(
      describePack({ pack_size: 30, pack_unit: 'each', units_per_case: 1 }),
    ).toBe('pack of 30')
    expect(
      describePack({
        pack_size: null,
        pack_unit: 'each',
        units_per_case: null,
      }),
    ).toBe('single')
    expect(
      describePack({ pack_size: null, pack_unit: 'l', units_per_case: null }),
    ).toBe('unknown pack')
  })
})
