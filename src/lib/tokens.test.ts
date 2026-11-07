import { describe, expect, it } from 'vitest'
import { shortlist, tokens } from './tokens'

describe('tokens', () => {
  it('strips sizes and expands abbreviations', () => {
    expect(tokens('AVONM WHL 2LTR')).toEqual(['avonm', 'whole'])
    expect(tokens('Whole Milk 2L x6')).toEqual(['whole', 'milk'])
    expect(tokens('EGGS FF LGE X30')).toEqual(['egg', 'free', 'range', 'large'])
  })
})

describe('shortlist', () => {
  const catalogue = [
    {
      product_id: 'milk',
      name: 'Whole milk',
      names: ['Whole milk', 'AVONM WHL 2LTR'],
    },
    {
      product_id: 'oat',
      name: 'Oat milk barista',
      names: ['Oat milk barista'],
    },
    {
      product_id: 'eggs',
      name: 'Free range eggs large',
      names: ['Free range eggs large'],
    },
    {
      product_id: 'beans',
      name: 'Espresso coffee beans',
      names: ['Espresso coffee beans'],
    },
  ]

  it('ranks the right product first across naming styles', () => {
    expect(shortlist('Milk Full Fat 2 Litre', catalogue)[0].product_id).toBe(
      'milk',
    )
    expect(shortlist('Whole Milk 2L x6', catalogue)[0].product_id).toBe('milk')
    expect(
      shortlist('free range eggs large tray 30', catalogue)[0].product_id,
    ).toBe('eggs')
    expect(shortlist('ESP BNS 1KG', catalogue)[0].product_id).toBe('beans')
  })

  it('returns nothing when no word overlaps', () => {
    expect(shortlist('Matcha powder 100g', catalogue)).toEqual([])
  })
})
