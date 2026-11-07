import { describe, expect, it } from 'vitest'
import { reminderEmail, replySubject, threadHeaders } from './reminders'

describe('threadHeaders', () => {
  it('replies to the latest email sent and references all, oldest first', () => {
    expect(
      threadHeaders([
        {
          sent_at: '2026-11-10T00:00:00Z',
          provider_message_id: '<b@mail.gmail.com>',
          gmail_thread_id: null,
        },
        {
          sent_at: '2026-11-01T00:00:00Z',
          provider_message_id: '<a@mail.gmail.com>',
          gmail_thread_id: 'thread-1',
        },
      ]),
    ).toEqual({
      inReplyTo: '<b@mail.gmail.com>',
      references: ['<a@mail.gmail.com>', '<b@mail.gmail.com>'],
      gmailThreadId: 'thread-1',
    })
  })

  it('skips ids that are not Message-IDs, and repeats', () => {
    expect(
      threadHeaders([
        {
          sent_at: '2026-11-01T00:00:00Z',
          provider_message_id: '<a@x.example>',
          gmail_thread_id: null,
        },
        {
          sent_at: '2026-11-02T00:00:00Z',
          provider_message_id: '0a1b2c3d-postmark-id',
          gmail_thread_id: null,
        },
        {
          sent_at: '2026-11-03T00:00:00Z',
          provider_message_id: '<a@x.example>',
          gmail_thread_id: null,
        },
      ]),
    ).toEqual({
      inReplyTo: '<a@x.example>',
      references: ['<a@x.example>'],
      gmailThreadId: null,
    })
  })

  it('is null with nothing to reply to', () => {
    expect(threadHeaders([])).toBeNull()
    expect(
      threadHeaders([
        {
          sent_at: '2026-11-01T00:00:00Z',
          provider_message_id: null,
          gmail_thread_id: 't',
        },
      ]),
    ).toBeNull()
  })
})

describe('replySubject', () => {
  it('adds Re: once', () => {
    expect(replySubject('Price on milk')).toBe('Re: Price on milk')
    expect(replySubject('RE: Price on milk')).toBe('RE: Price on milk')
    expect(replySubject('  ')).toBe('Following up')
    expect(replySubject(null)).toBe('Following up')
  })
})

describe('reminderEmail', () => {
  const base = {
    supplier_name: 'Lee Valley Wholesale',
    owner_name: 'Aoife',
    business_name: 'The Corner Café',
    kind: 'match' as const,
    subject: 'Price on milk',
    body: 'Hi,\n\nCould you match €11.20?\n\nAoife',
    products: ['Whole milk', 'Butter'],
    sent_at: '2026-11-07T10:00:00Z',
  }

  it('is a short follow-up with the original quoted below', () => {
    const r = reminderEmail(base)
    expect(r.subject).toBe('Re: Price on milk')
    expect(r.body).toBe(
      [
        'Hi Lee Valley Wholesale,',
        '',
        'Just following up on my email of 7 November about Whole milk and Butter. Could you let me know if you can do it when you get a chance?',
        '',
        'Thanks,',
        'Aoife',
        'The Corner Café',
        '',
        'On 7 November, Aoife wrote:',
        '> Hi,',
        '>',
        '> Could you match €11.20?',
        '>',
        '> Aoife',
      ].join('\n'),
    )
  })

  it('asks a seller for trade prices', () => {
    expect(reminderEmail({ ...base, kind: 'quote' }).body).toContain(
      'Could you let me know your trade prices',
    )
  })

  it('reads well with no supplier, products or body', () => {
    const r = reminderEmail({
      ...base,
      supplier_name: null,
      products: [],
      body: null,
    })
    expect(r.body).toBe(
      [
        'Hi,',
        '',
        'Just following up on my email of 7 November. Could you let me know if you can do it when you get a chance?',
        '',
        'Thanks,',
        'Aoife',
        'The Corner Café',
      ].join('\n'),
    )
  })

  it('lists three products with commas', () => {
    expect(
      reminderEmail({ ...base, products: ['Milk', 'Butter', 'Eggs'] }).body,
    ).toContain('about Milk, Butter and Eggs.')
  })
})
