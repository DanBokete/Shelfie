import { describe, expect, it } from 'vitest'
import { parsePostmark } from './inbound.server'

const payload = {
  MessageID: 'abc-123',
  FromFull: { Email: 'Sales@Munster-Fresh.ie', Name: 'Sean' },
  ToFull: [{ Email: 'aoife@cornercafe.ie', Name: '' }],
  CcFull: [
    {
      Email:
        'abc123+11111111-1111-4111-8111-111111111111@inbound.postmarkapp.com',
      Name: '',
      MailboxHash: '11111111-1111-4111-8111-111111111111',
    },
  ],
  OriginalRecipient:
    'abc123+11111111-1111-4111-8111-111111111111@inbound.postmarkapp.com',
  MailboxHash: '11111111-1111-4111-8111-111111111111',
  Subject: 'RE: Trade quote',
  Date: 'Fri, 6 Nov 2026 10:00:00 +0000',
  TextBody: 'Hi Aoife, quote attached.',
  StrippedTextReply: 'Hi Aoife, quote attached.',
  Attachments: [
    {
      Name: 'quote.pdf',
      Content: Buffer.from('%PDF-1.4').toString('base64'),
      ContentType: 'application/pdf',
    },
  ],
}

describe('parsePostmark', () => {
  it('reads sender, recipients, text and attachments', () => {
    const m = parsePostmark(payload)
    expect(m.message_id).toBe('abc-123')
    expect(m.from_email).toBe('sales@munster-fresh.ie')
    expect(m.from_name).toBe('Sean')
    expect(m.to).toEqual(['aoife@cornercafe.ie'])
    expect(m.recipients).toHaveLength(3)
    expect(m.received_at).toBe('2026-11-06T10:00:00.000Z')
    expect(m.attachments[0].name).toBe('quote.pdf')
    expect(Buffer.from(m.attachments[0].bytes).toString()).toBe('%PDF-1.4')
  })

  it('falls back to the HTML body when there is no text part', () => {
    const m = parsePostmark({
      ...payload,
      TextBody: '',
      HtmlBody: '<p>Prices:</p><p>Milk &euro;9.90</p>',
    })
    expect(m.text).toContain('Milk €9.90')
  })

  it('rejects a payload with no sender', () => {
    expect(() => parsePostmark({ Subject: 'x' })).toThrow()
  })

  it('makes a stable id when the provider sends none', () => {
    const { MessageID: _unused, ...rest } = payload
    expect(parsePostmark(rest).message_id).toBe(parsePostmark(rest).message_id)
  })
})
