import { describe, expect, it } from 'vitest'
import {
  bounceNote,
  imapError,
  isBounce,
  replySearch,
  toInbound,
} from './gmail-replies.server'

const DRAFT = '11111111-1111-4111-8111-111111111111'
const SENT = {
  id: DRAFT,
  to_email: 'Sales <Sales@LeeValley.ie>',
  sent_at: '2026-11-07T13:40:00Z',
  provider_message_id: '<abc123@gmail.com>',
  send_error: null,
}

describe('which emails count as replies', () => {
  it('searches the thread and, when allowed, the address written to', () => {
    expect(replySearch(SENT, true)).toEqual({
      since: new Date('2026-11-07T00:00:00Z'),
      or: [
        { header: { 'in-reply-to': '<abc123@gmail.com>' } },
        { header: { references: '<abc123@gmail.com>' } },
        { from: 'sales@leevalley.ie' },
      ],
    })
  })

  it('searches only the thread when matching by sender is off', () => {
    expect(replySearch(SENT, false)).toEqual({
      since: new Date('2026-11-07T00:00:00Z'),
      or: [
        { header: { 'in-reply-to': '<abc123@gmail.com>' } },
        { header: { references: '<abc123@gmail.com>' } },
      ],
    })
  })

  it('falls back to the sender alone, or nothing, without a message id', () => {
    const noId = { ...SENT, provider_message_id: null }
    expect(replySearch(noId, true)).toEqual({
      since: new Date('2026-11-07T00:00:00Z'),
      from: 'sales@leevalley.ie',
    })
    expect(replySearch(noId, false)).toBeNull()
  })
})

describe('reading a raw Gmail message', () => {
  const raw = Buffer.from(
    [
      'From: Sean Murphy <sean@leevalley.ie>',
      'To: Aoife <aoife@gmail.com>',
      'Cc: accounts@leevalley.ie',
      'Subject: Re: Whole milk price',
      'Date: Sat, 07 Nov 2026 15:02:00 +0000',
      'Message-ID: <reply-1@leevalley.ie>',
      'In-Reply-To: <abc123@gmail.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hi Aoife, we can do 2L whole milk at €3.60 ex VAT.',
      '--b',
      'Content-Type: application/pdf; name="quote.pdf"',
      'Content-Disposition: attachment; filename="quote.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 test').toString('base64'),
      '--b--',
      '',
    ].join('\r\n'),
  )

  it('turns it into a reply tied to its request', async () => {
    const m = await toInbound(raw, DRAFT)
    expect(m).toMatchObject({
      message_id: '<reply-1@leevalley.ie>',
      from_email: 'sean@leevalley.ie',
      from_name: 'Sean Murphy',
      to: ['aoife@gmail.com'],
      recipients: ['aoife@gmail.com', 'accounts@leevalley.ie'],
      subject: 'Re: Whole milk price',
      text: 'Hi Aoife, we can do 2L whole milk at €3.60 ex VAT.',
      received_at: '2026-11-07T15:02:00.000Z',
      draft_id: DRAFT,
    })
    expect(m?.attachments).toHaveLength(1)
    expect(m?.attachments[0]).toMatchObject({
      name: 'quote.pdf',
      type: 'application/pdf',
    })
    expect(Buffer.from(m!.attachments[0].bytes).toString()).toBe(
      '%PDF-1.4 test',
    )
  })

  it('ignores a message with no sender', async () => {
    expect(
      await toInbound(Buffer.from('Subject: hi\r\n\r\nbody'), DRAFT),
    ).toBeNull()
  })
})

describe('Gmail errors', () => {
  it('explains a rejected login and a lost connection', () => {
    expect(imapError({ authenticationFailed: true })).toMatch(/app password/)
    expect(
      imapError({ responseText: '[AUTHENTICATIONFAILED] Invalid credentials' }),
    ).toMatch(/app password/)
    expect(imapError({ code: 'ENOTFOUND' })).toMatch(/Could not reach Gmail/)
    expect(imapError(new Error('boom'))).toBe('Gmail error: boom')
  })
})

describe('bounces', () => {
  it('knows Gmail delivery notices are not replies', () => {
    expect(
      isBounce('Mail Delivery Subsystem <mailer-daemon@googlemail.com>'),
    ).toBe(true)
    expect(isBounce('postmaster@leevalley.ie')).toBe(true)
    expect(isBounce('sean@leevalley.ie')).toBe(false)
    expect(isBounce(null)).toBe(false)
  })

  it('names the address that could not be reached', () => {
    // Gmail's wording, as received.
    const text = `** Address not found **

Your message wasn't delivered to test@gmail.com because the address couldn't be found, or is unable to receive mail.

Learn more here: https://support.google.com/mail/?p=NoSuchUser`
    expect(bounceNote(text)).toBe(
      'Not delivered to test@gmail.com: address not found.',
    )
    expect(bounceNote('Delivery incomplete. Retrying.')).toBe('Not delivered.')
  })
})
