import { describe, expect, it } from 'vitest'
import {
  domainOf,
  draftIdFromRecipients,
  emailOf,
  hostOf,
  inboundAddressFor,
  isOutgoingCopy,
  matchReply,
} from './inbound'
import type { DraftRef, SupplierRef } from './inbound'

const D1 = '11111111-1111-4111-8111-111111111111'
const D2 = '22222222-2222-4222-8222-222222222222'
const BASE = 'abc123@inbound.postmarkapp.com'

describe('email addresses', () => {
  it('reads an address out of a display name', () => {
    expect(emailOf('Sean Murphy <Sean@Munster-Fresh.ie>')).toBe(
      'sean@munster-fresh.ie',
    )
    expect(emailOf('  a@b.ie ')).toBe('a@b.ie')
    expect(emailOf('not an address')).toBeNull()
    expect(emailOf(null)).toBeNull()
  })

  it('finds the host of a website', () => {
    expect(hostOf('https://www.Munster-Fresh.ie/trade')).toBe(
      'munster-fresh.ie',
    )
    expect(hostOf('munster-fresh.ie')).toBe('munster-fresh.ie')
    expect(hostOf(null)).toBeNull()
  })

  it('builds a per-draft plus-address from the inbound address', () => {
    expect(inboundAddressFor(BASE, D1)).toBe(
      `abc123+${D1}@inbound.postmarkapp.com`,
    )
    // An address that already has a tag does not get a second one.
    expect(inboundAddressFor(`abc123+x@inbound.postmarkapp.com`, D1)).toBe(
      `abc123+${D1}@inbound.postmarkapp.com`,
    )
    expect(inboundAddressFor('', D1)).toBeNull()
    expect(inboundAddressFor(undefined, D1)).toBeNull()
  })
})

describe('draftIdFromRecipients', () => {
  it('finds the draft in a CC plus-address', () => {
    expect(
      draftIdFromRecipients(
        ['aoife@cornercafe.ie', `abc123+${D1}@inbound.postmarkapp.com`],
        BASE,
      ),
    ).toBe(D1)
  })

  it('is case-insensitive and reads Name <address> form', () => {
    expect(
      draftIdFromRecipients(
        [`Shelfie <ABC123+${D1.toUpperCase()}@Inbound.Postmarkapp.com>`],
        BASE,
      ),
    ).toBe(D1)
  })

  it('ignores plus-addresses at other mailboxes', () => {
    expect(draftIdFromRecipients([`someone+${D1}@gmail.com`], BASE)).toBeNull()
    expect(
      draftIdFromRecipients([`other+${D1}@inbound.postmarkapp.com`], BASE),
    ).toBeNull()
  })

  it('falls back to the provider mailbox hash', () => {
    expect(
      draftIdFromRecipients(['abc123@inbound.postmarkapp.com'], BASE, D2),
    ).toBe(D2)
    expect(draftIdFromRecipients([], BASE, 'not-a-uuid')).toBeNull()
  })

  it('has no draft without a tag', () => {
    expect(
      draftIdFromRecipients(['abc123@inbound.postmarkapp.com'], BASE),
    ).toBeNull()
  })
})

const drafts: Array<DraftRef> = [
  {
    id: D1,
    supplier_id: 's-munster',
    to_email: 'sales@munster-fresh.ie',
    created_at: '2026-11-01T10:00:00Z',
  },
  {
    id: D2,
    supplier_id: 's-munster',
    to_email: 'sales@munster-fresh.ie',
    created_at: '2026-11-05T10:00:00Z',
  },
  {
    id: 'd3',
    supplier_id: 's-lee',
    to_email: 'orders@leevalley.ie',
    created_at: '2026-11-03T10:00:00Z',
  },
  {
    id: 'd4',
    supplier_id: 's-gmail',
    to_email: 'bobsfoods@gmail.com',
    created_at: '2026-11-04T10:00:00Z',
  },
]
const suppliers: Array<SupplierRef> = [
  {
    id: 's-munster',
    name: 'Munster Fresh Foods',
    email: 'sales@munster-fresh.ie',
    website: null,
  },
  {
    id: 's-lee',
    name: 'Lee Valley Wholesale',
    email: null,
    website: 'https://www.leevalley.ie',
  },
  {
    id: 's-gmail',
    name: 'Bobs Foods',
    email: 'bobsfoods@gmail.com',
    website: null,
  },
  {
    id: 's-other',
    name: 'Harbour Catering',
    email: 'info@harbour-catering.ie',
    website: null,
  },
]

describe('matchReply', () => {
  it('uses the plus-address first, even from an unknown sender', () => {
    expect(
      matchReply({
        from: 'someone@else.com',
        plus_draft_id: D1,
        drafts,
        suppliers,
      }),
    ).toEqual({
      draft_id: D1,
      supplier_id: 's-munster',
      method: 'plus_address',
    })
  })

  it('falls back to the sender address when the draft id is unknown', () => {
    expect(
      matchReply({
        from: 'Sales <SALES@munster-fresh.ie>',
        plus_draft_id: 'nope',
        drafts,
        suppliers,
      }),
    ).toEqual({
      draft_id: D2,
      supplier_id: 's-munster',
      method: 'sender_email',
    })
  })

  it('picks the most recent draft for the supplier', () => {
    const m = matchReply({
      from: 'sales@munster-fresh.ie',
      plus_draft_id: null,
      drafts,
      suppliers,
    })
    expect(m?.draft_id).toBe(D2)
  })

  it('matches only by plus-address when matching by sender is turned off', () => {
    const off = { plus_draft_id: null, drafts, suppliers, by_sender: false }
    expect(matchReply({ ...off, from: 'sales@munster-fresh.ie' })).toBeNull()
    expect(matchReply({ ...off, from: 'anna@leevalley.ie' })).toBeNull()
    expect(
      matchReply({
        from: 'sales@munster-fresh.ie',
        plus_draft_id: D2,
        drafts,
        suppliers,
        by_sender: false,
      })?.method,
    ).toBe('plus_address')
  })

  it('matches a colleague by company domain (supplier website)', () => {
    expect(
      matchReply({
        from: 'anna@leevalley.ie',
        plus_draft_id: null,
        drafts,
        suppliers,
      }),
    ).toEqual({ draft_id: 'd3', supplier_id: 's-lee', method: 'sender_domain' })
  })

  it('matches a colleague by company domain (draft address) and by subdomain', () => {
    expect(
      matchReply({
        from: 'pat@mail.munster-fresh.ie',
        plus_draft_id: null,
        drafts,
        suppliers,
      })?.method,
    ).toBe('sender_domain')
  })

  it('matches a supplier with no draft yet, with no draft id', () => {
    expect(
      matchReply({
        from: 'info@harbour-catering.ie',
        plus_draft_id: null,
        drafts,
        suppliers,
      }),
    ).toEqual({
      draft_id: null,
      supplier_id: 's-other',
      method: 'sender_email',
    })
  })

  it('never matches on a free-mail domain, only on the exact address', () => {
    expect(
      matchReply({
        from: 'bobsfoods@gmail.com',
        plus_draft_id: null,
        drafts,
        suppliers,
      })?.method,
    ).toBe('sender_email')
    expect(
      matchReply({
        from: 'random@gmail.com',
        plus_draft_id: null,
        drafts,
        suppliers,
      }),
    ).toBeNull()
  })

  it('leaves unknown senders unmatched', () => {
    expect(
      matchReply({
        from: 'hello@stranger.example',
        plus_draft_id: null,
        drafts,
        suppliers,
      }),
    ).toBeNull()
    expect(
      matchReply({
        from: 'not an email',
        plus_draft_id: null,
        drafts,
        suppliers,
      }),
    ).toBeNull()
  })

  it('does not guess when a domain belongs to two suppliers', () => {
    const two: Array<SupplierRef> = [
      { id: 'a', name: 'A', email: 'x@group.ie', website: null },
      { id: 'b', name: 'B', email: 'y@group.ie', website: null },
    ]
    expect(
      matchReply({
        from: 'z@group.ie',
        plus_draft_id: null,
        drafts: [],
        suppliers: two,
      }),
    ).toBeNull()
  })

  it('domainOf is the part after the @', () => {
    expect(domainOf('a@b.co.uk')).toBe('b.co.uk')
  })
})

describe('isOutgoingCopy', () => {
  it("spots the owner's own request, copied to Shelfie", () => {
    expect(
      isOutgoingCopy({
        from: 'aoife@cornercafe.ie',
        to: ['sales@munster-fresh.ie'],
        draft_to_email: 'sales@munster-fresh.ie',
      }),
    ).toBe(true)
  })

  it('spots it when the owner and the supplier both use gmail', () => {
    expect(
      isOutgoingCopy({
        from: 'aoife@gmail.com',
        to: ['bobsfoods@gmail.com'],
        draft_to_email: 'bobsfoods@gmail.com',
      }),
    ).toBe(true)
  })

  it("does not treat the supplier's reply as a copy", () => {
    expect(
      isOutgoingCopy({
        from: 'sales@munster-fresh.ie',
        to: ['aoife@cornercafe.ie'],
        draft_to_email: 'sales@munster-fresh.ie',
      }),
    ).toBe(false)
    // A colleague at the supplier replying to the owner.
    expect(
      isOutgoingCopy({
        from: 'pat@munster-fresh.ie',
        to: ['aoife@cornercafe.ie'],
        draft_to_email: 'sales@munster-fresh.ie',
      }),
    ).toBe(false)
  })

  it('is false when the draft has no address', () => {
    expect(
      isOutgoingCopy({ from: 'a@b.ie', to: ['c@d.ie'], draft_to_email: null }),
    ).toBe(false)
  })
})
