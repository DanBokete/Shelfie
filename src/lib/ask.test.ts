import { describe, expect, it } from 'vitest'
import { reductionPercent } from './ask'

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
