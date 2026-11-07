import { describe, expect, it } from 'vitest'
import { pageKey, verifyContact } from './contact'

const notes = `Musgrave MarketPlace sells to trade customers. Trade enquiries: tradesales@example-cash.ie,
phone 021 450 1234 (from https://www.example-cash.ie/contact-us/). Open an account in branch.`
const sources = [
  'https://www.example-cash.ie/contact-us',
  'https://www.example-cash.ie/',
]

describe('verifyContact', () => {
  it('keeps details that appear in the notes', () => {
    const r = verifyContact(
      {
        sells_to_trade: 'yes',
        email: 'TradeSales@example-cash.ie',
        phone: '021 450 1234',
        contact_page_url: 'https://example-cash.ie/contact-us/?ref=x',
        note: 'Open an account in branch.',
      },
      notes,
      sources,
    )
    expect(r).toEqual({
      sells_to_trade: 'yes',
      email: 'tradesales@example-cash.ie',
      phone: '021 450 1234',
      contact_source_url: 'https://example-cash.ie/contact-us/?ref=x',
      note: 'Open an account in branch.',
    })
  })

  it('drops an email or phone the notes never mention, and pages the search never opened', () => {
    const r = verifyContact(
      {
        sells_to_trade: 'unknown',
        email: 'sales@example-cash.ie',
        phone: '01 999 8888',
        contact_page_url: 'https://example-cash.ie/trade',
        note: ' ',
      },
      notes,
      sources,
    )
    expect(r).toEqual({
      sells_to_trade: 'unknown',
      email: null,
      phone: null,
      contact_source_url: null,
      note: null,
    })
  })

  it('rejects something that is not an email address', () => {
    const r = verifyContact(
      {
        sells_to_trade: 'yes',
        email: 'tradesales at example-cash',
        phone: null,
        contact_page_url: null,
        note: '',
      },
      'write to tradesales at example-cash',
      [],
    )
    expect(r.email).toBeNull()
  })
})

describe('pageKey', () => {
  it('ignores www, query and trailing slash', () => {
    expect(pageKey('https://www.Shop.ie/a/b/?x=1')).toBe('shop.ie/a/b')
    expect(pageKey('not a url')).toBeNull()
  })
})
