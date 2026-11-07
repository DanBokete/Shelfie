import { describe, expect, it } from 'vitest'
import {
  countPending,
  daysSince,
  groupPendingEmails,
  productNames,
  repliesToReview,
} from './pending-emails'
import type { DraftRow, ReplyRow } from './pending-emails'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const OPTS = { replyByDays: 7, now: NOW }

function draft(over: Partial<DraftRow> & { id: string }): DraftRow {
  return {
    kind: 'match',
    supplier_name: 'Lee Valley Wholesale',
    to_email: 'orders@leevalley.example',
    subject: 'Price on milk',
    body: 'Hi',
    items: [{ product_name: 'Whole milk', pack_label: '2L' }],
    created_at: '2026-11-01T09:00:00Z',
    sent_at: null,
    send_error: null,
    follow_up_of: null,
    ...over,
  }
}

function reply(over: Partial<ReplyRow> & { id: string }): ReplyRow {
  return {
    draft_id: null,
    status: 'processed',
    error: null,
    from_email: 'sales@munster.example',
    from_name: null,
    subject: 'Re: Price on milk',
    received_at: '2026-11-10T09:00:00Z',
    supplier_name: null,
    ...over,
  }
}

describe('groupPendingEmails', () => {
  it('puts a sent request with no reply in waiting', () => {
    const p = groupPendingEmails(
      [draft({ id: 'a', sent_at: '2026-11-18T12:00:00Z' })],
      [],
      OPTS,
    )
    expect(p.waiting.map((w) => w.id)).toEqual(['a'])
    expect(p.waiting[0]).toMatchObject({ days: 2, overdue: false })
    expect(p.drafts).toEqual([])
    expect(p.failed).toEqual([])
  })

  it('marks a request overdue on the reply-by day, not before', () => {
    const p = groupPendingEmails(
      [
        draft({ id: 'day6', sent_at: '2026-11-13T12:00:01Z' }),
        draft({ id: 'day7', sent_at: '2026-11-13T12:00:00Z' }),
      ],
      [],
      OPTS,
    )
    const by = Object.fromEntries(p.waiting.map((w) => [w.id, w]))
    expect(by.day6).toMatchObject({ days: 6, overdue: false })
    expect(by.day7).toMatchObject({ days: 7, overdue: true })
  })

  it('follows the reply-by days from Settings', () => {
    const d = [draft({ id: 'a', sent_at: '2026-11-17T12:00:00Z' })]
    expect(
      groupPendingEmails(d, [], { replyByDays: 3, now: NOW }).waiting[0]
        .overdue,
    ).toBe(true)
    expect(
      groupPendingEmails(d, [], { replyByDays: 4, now: NOW }).waiting[0]
        .overdue,
    ).toBe(false)
  })

  it('drops a sent request once any reply is tied to it', () => {
    for (const status of [
      'received',
      'processed',
      'failed',
      'unmatched',
    ] as const) {
      const p = groupPendingEmails(
        [draft({ id: 'a', sent_at: '2026-11-01T12:00:00Z' })],
        [reply({ id: 'r', draft_id: 'a', status })],
        OPTS,
      )
      expect(p.waiting).toEqual([])
    }
  })

  it('a reply to another request does not count', () => {
    const p = groupPendingEmails(
      [draft({ id: 'a', sent_at: '2026-11-01T12:00:00Z' })],
      [reply({ id: 'r', draft_id: 'b' })],
      OPTS,
    )
    expect(p.waiting.map((w) => w.id)).toEqual(['a'])
  })

  it('puts never-sent drafts in drafts, whatever their status', () => {
    const p = groupPendingEmails(
      [draft({ id: 'a' }), draft({ id: 'b', created_at: '2026-11-02T00:00Z' })],
      [],
      OPTS,
    )
    expect(p.drafts.map((d) => d.id)).toEqual(['b', 'a'])
    expect(p.waiting).toEqual([])
  })

  it('puts a send error in failed, never in drafts', () => {
    const p = groupPendingEmails(
      [draft({ id: 'a', send_error: 'Gmail rejected the login.' })],
      [],
      OPTS,
    )
    expect(p.failed).toMatchObject([
      { id: 'a', reason: 'Gmail rejected the login.', bounced: false },
    ])
    expect(p.drafts).toEqual([])
  })

  it('puts a bounced request in failed, not waiting', () => {
    const p = groupPendingEmails(
      [
        draft({
          id: 'a',
          sent_at: '2026-11-10T12:00:00Z',
          send_error: 'Not delivered to x@y.example: address not found.',
        }),
      ],
      [],
      OPTS,
    )
    expect(p.waiting).toEqual([])
    expect(p.failed).toMatchObject([{ id: 'a', bounced: true }])
  })

  it('sorts each section newest first', () => {
    const p = groupPendingEmails(
      [
        draft({ id: 'old', sent_at: '2026-11-02T00:00:00Z' }),
        draft({ id: 'new', sent_at: '2026-11-19T00:00:00Z' }),
        draft({ id: 'mid', sent_at: '2026-11-10T00:00:00Z' }),
        draft({
          id: 'f-old',
          created_at: '2026-11-01T00:00:00Z',
          send_error: 'x',
        }),
        draft({
          id: 'f-new',
          sent_at: '2026-11-15T00:00:00Z',
          send_error: 'Not delivered.',
        }),
      ],
      [],
      OPTS,
    )
    expect(p.waiting.map((w) => w.id)).toEqual(['new', 'mid', 'old'])
    expect(p.failed.map((w) => w.id)).toEqual(['f-new', 'f-old'])
  })

  it('counts what needs action: overdue, drafts, failed and replies', () => {
    const p = groupPendingEmails(
      [
        draft({ id: 'fresh', sent_at: '2026-11-19T00:00:00Z' }),
        draft({ id: 'late', sent_at: '2026-11-01T00:00:00Z' }),
        draft({ id: 'unsent' }),
        draft({ id: 'broken', send_error: 'x' }),
      ],
      [reply({ id: 'r', status: 'unmatched' })],
      OPTS,
    )
    expect(p.counts).toEqual({
      waiting: 2,
      overdue: 1,
      drafts: 1,
      failed: 1,
      review: 1,
      action: 4,
    })
  })

  it('is empty with no emails', () => {
    const p = groupPendingEmails([], [], OPTS)
    expect(p.counts.action).toBe(0)
    expect([p.waiting, p.drafts, p.failed, p.review]).toEqual([[], [], [], []])
  })
})

describe('reminders', () => {
  const request = draft({ id: 'req', sent_at: '2026-11-05T12:00:00Z' })

  it('counts a sent reminder on its request, not as its own row', () => {
    const p = groupPendingEmails(
      [
        request,
        draft({
          id: 'rem',
          follow_up_of: 'req',
          sent_at: '2026-11-15T12:00:00Z',
        }),
      ],
      [],
      OPTS,
    )
    expect(p.waiting.map((w) => w.id)).toEqual(['req'])
    expect(p.waiting[0]).toMatchObject({
      days: 15,
      reminders: 1,
      last_reminder_at: '2026-11-15T12:00:00Z',
    })
  })

  it('gives the supplier the reply-by days again after a reminder', () => {
    const at = (sent: string) =>
      groupPendingEmails(
        [request, draft({ id: 'rem', follow_up_of: 'req', sent_at: sent })],
        [],
        OPTS,
      ).waiting[0].overdue
    expect(at('2026-11-15T12:00:00Z')).toBe(false)
    expect(at('2026-11-13T12:00:00Z')).toBe(true)
  })

  it('uses the latest of several reminders', () => {
    const p = groupPendingEmails(
      [
        request,
        draft({ id: 'r2', follow_up_of: 'req', sent_at: '2026-11-18T00:00Z' }),
        draft({ id: 'r1', follow_up_of: 'req', sent_at: '2026-11-12T00:00Z' }),
      ],
      [],
      OPTS,
    )
    expect(p.waiting[0]).toMatchObject({
      reminders: 2,
      last_reminder_at: '2026-11-18T00:00Z',
    })
  })

  it('a reply tied to a reminder answers the request', () => {
    const p = groupPendingEmails(
      [
        request,
        draft({ id: 'rem', follow_up_of: 'req', sent_at: '2026-11-15T00:00Z' }),
      ],
      [reply({ id: 'r', draft_id: 'rem' })],
      OPTS,
    )
    expect(p.waiting).toEqual([])
  })

  it('lists an unsent reminder in drafts and a failed one in failed', () => {
    const p = groupPendingEmails(
      [
        request,
        draft({ id: 'unsent', follow_up_of: 'req' }),
        draft({ id: 'broken', follow_up_of: 'req', send_error: 'x' }),
      ],
      [],
      OPTS,
    )
    expect(p.drafts).toMatchObject([{ id: 'unsent', follow_up_of: 'req' }])
    expect(p.failed).toMatchObject([{ id: 'broken', follow_up_of: 'req' }])
    expect(p.waiting[0]).toMatchObject({ id: 'req', reminders: 0 })
  })
})

describe('repliesToReview', () => {
  it('keeps unmatched and failed replies, newest first', () => {
    const r = repliesToReview([
      reply({ id: 'ok', status: 'processed' }),
      reply({ id: 'busy', status: 'received' }),
      reply({
        id: 'u',
        status: 'unmatched',
        from_name: 'Sam',
        received_at: '2026-11-12T00:00:00Z',
      }),
      reply({ id: 'f', status: 'failed', error: 'the PDF is empty' }),
    ])
    expect(r.map((x) => x.id)).toEqual(['u', 'f'])
    expect(r[0].from).toBe('Sam <sales@munster.example>')
    expect(r[0].reason).toMatch(/Pick the supplier/)
    expect(r[1].reason).toBe('Shelfie could not read it: the PDF is empty')
  })
})

describe('productNames', () => {
  it('reads match and quote items, once each', () => {
    expect(
      productNames([
        { product_name: 'Whole milk' },
        { product: 'Coffee beans' },
        { product_name: 'Whole milk' },
        { product_name: '  ' },
        null,
        'x',
      ]),
    ).toEqual(['Whole milk', 'Coffee beans'])
  })

  it('is empty for missing items', () => {
    expect(productNames(null)).toEqual([])
    expect(productNames({})).toEqual([])
  })
})

describe('daysSince', () => {
  it('counts whole days and never goes negative', () => {
    expect(daysSince('2026-11-19T12:00:01Z', NOW)).toBe(0)
    expect(daysSince('2026-11-19T12:00:00Z', NOW)).toBe(1)
    expect(daysSince('2026-11-21T00:00:00Z', NOW)).toBe(0)
  })
})

describe('countPending', () => {
  it('does not count waiting requests that are not overdue', () => {
    expect(
      countPending({
        waiting: [
          {
            id: 'a',
            kind: 'match',
            supplier_name: null,
            to_email: null,
            subject: null,
            body: null,
            products: [],
            created_at: '',
            sent_at: '',
            follow_up_of: null,
            days: 1,
            reminders: 0,
            last_reminder_at: null,
            overdue: false,
          },
        ],
        drafts: [],
        failed: [],
        review: [],
      }).action,
    ).toBe(0)
  })
})
