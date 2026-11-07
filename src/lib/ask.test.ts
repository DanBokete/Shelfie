import { describe, expect, it } from 'vitest'
import { reductionPercent, targetBuyPrice } from './ask'

describe('reductionPercent', () => {
  it('is the gap as a whole percent of what the owner pays now', () => {
    expect(reductionPercent(4.2, 2.69)).toBe(36)
    expect(reductionPercent(3.95, 3.5)).toBe(11)
    expect(reductionPercent(10, 9)).toBe(10)
  })

  it('is at least 1 for a tiny gap, so the email never says 0%', () => {
    expect(reductionPercent(10, 9.99)).toBe(1)
  })

  it('is 0 when the other price is not lower, or the inputs make no sense', () => {
    expect(reductionPercent(3, 3)).toBe(0)
    expect(reductionPercent(3, 4)).toBe(0)
    expect(reductionPercent(0, 1)).toBe(0)
    expect(reductionPercent(3, -1)).toBe(0)
  })
})

describe('targetBuyPrice', () => {
  it('keeps the same profit when we sell at the competitive price', () => {
    // Case of 24 colas: buy 14.40, sell 36.00 (1.50 each), competitors sell the same 24 for 31.20.
    // Profit today 21.60, so to sell at 31.20 and still make 21.60 we must buy at 9.60.
    expect(
      targetBuyPrice({ your_price: 14.4, best_price: 31.2, selling_price: 36 }),
    ).toEqual({ target: 9.6, percent: 33, basis: 'profit' })
  })

  it('is the same as cutting the buy price by the cut in our selling price', () => {
    const t = targetBuyPrice({
      your_price: 3.95,
      best_price: 5,
      selling_price: 6,
    })!
    expect(t.target).toBe(2.95) // 3.95 - (6 - 5)
    expect(t.percent).toBe(25)
    expect(t.basis).toBe('profit')
  })

  it('falls back to the found price when there is no selling price', () => {
    expect(
      targetBuyPrice({
        your_price: 3.95,
        best_price: 3.5,
        selling_price: null,
      }),
    ).toEqual({ target: 3.5, percent: 11, basis: 'found_price' })
  })

  it('falls back to the found price when we already sell at or below the competitive price', () => {
    expect(
      targetBuyPrice({ your_price: 3.95, best_price: 3.5, selling_price: 3.5 }),
    ).toEqual({ target: 3.5, percent: 11, basis: 'found_price' })
  })

  it('falls back when the profit rule gives no sensible target', () => {
    // Profit 20 on a 3.95 buy price: 5 - 20 is below zero. Best 5 is not below what we pay.
    expect(
      targetBuyPrice({ your_price: 3.95, best_price: 5, selling_price: 23.95 }),
    ).toBeNull()
    // Selling below cost (negative profit) is not used either.
    expect(
      targetBuyPrice({ your_price: 10, best_price: 8, selling_price: 9 })
        ?.basis,
    ).toBe('found_price')
  })

  it('applies the profit rule even when the found price equals what we pay', () => {
    // Buy 3, competitors sell at 3, we sell at 5 (profit 2): to sell at 3 and keep 2 we must buy at 1.
    expect(
      targetBuyPrice({ your_price: 3, best_price: 3, selling_price: 5 }),
    ).toEqual({ target: 1, percent: 67, basis: 'profit' })
  })

  it('is null when no lower price makes sense', () => {
    expect(
      targetBuyPrice({ your_price: 3, best_price: 3, selling_price: null }),
    ).toBeNull()
    expect(
      targetBuyPrice({ your_price: 3, best_price: 4, selling_price: 3.5 }),
    ).toBeNull()
    expect(
      targetBuyPrice({ your_price: 0, best_price: 1, selling_price: null }),
    ).toBeNull()
  })
})
