import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import {
  attachmentRefs,
  bodyText,
  gmailToInbound,
  newReplies,
  rawMessage,
  replyKey,
} from './gmail-message.server'
import type { GmailMessage, GmailPart } from './gmail-message.server'

const DRAFT = '11111111-1111-4111-8111-111111111111'
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')

describe('the outgoing email', () => {
  it('has the same To, CC, BCC, subject and body the SMTP path sends', async () => {
    const raw = await rawMessage({
      from: '"Aoife at The Corner Café" <aoife.corner@gmail.com>',
      to: 'sales@leevalley.ie',
      cc: 'abc+11111111@inbound.postmarkapp.com',
      bcc: 'aoife@corner.ie',
      subject: 'Price match request: Whole Milk 2L',
      text: 'Hi Seán,\n\nCould you match €1.89 a litre?\n\nAoife',
    })
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    const mail = await simpleParser(Buffer.from(raw, 'base64url'))
    expect(mail.from?.value).toEqual([
      { name: 'Aoife at The Corner Café', address: 'aoife.corner@gmail.com' },
    ])
    expect(mail.to).toMatchObject({
      value: [{ address: 'sales@leevalley.ie' }],
    })
    expect(mail.cc).toMatchObject({
      value: [{ address: 'abc+11111111@inbound.postmarkapp.com' }],
    })
    // Gmail takes BCC recipients from the header, and strips it before delivery.
    expect(mail.bcc).toMatchObject({ value: [{ address: 'aoife@corner.ie' }] })
    expect(mail.subject).toBe('Price match request: Whole Milk 2L')
    expect(mail.text?.trim()).toBe(
      'Hi Seán,\n\nCould you match €1.89 a litre?\n\nAoife',
    )
    expect(mail.messageId).toMatch(/^<.+@.+>$/)
  })

  it('leaves out CC and BCC when there are none', async () => {
    const raw = await rawMessage({
      from: 'a@gmail.com',
      to: 'b@example.ie',
      cc: null,
      bcc: null,
      subject: 'Hi',
      text: 'Hello',
    })
    const head = Buffer.from(raw, 'base64url').toString().split('\r\n\r\n')[0]
    expect(head).not.toMatch(/^(Cc|Bcc):/im)
  })
})

/** A phone's plain reply with a PDF quote, as users.threads.get returns it. */
function phoneReply(over: Partial<GmailMessage> = {}): GmailMessage {
  const text: GmailPart = {
    partId: '0.0',
    mimeType: 'text/plain',
    filename: '',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
    body: { size: 40, data: b64('Hi Aoife, quote attached.\n\nSeán\n') },
  }
  const html: GmailPart = {
    partId: '0.1',
    mimeType: 'text/html',
    filename: '',
    headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
    body: { size: 60, data: b64('<div>Hi Aoife, quote attached.</div>') },
  }
  return {
    id: '18c1',
    threadId: '18c0',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: String(Date.parse('2026-11-07T14:05:00Z')),
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        { name: 'From', value: 'Seán Murphy <Sean@LeeValley.ie>' },
        {
          name: 'To',
          value: '"Aoife at The Corner Café" <aoife.corner@gmail.com>',
        },
        { name: 'Cc', value: 'abc+11111111@inbound.postmarkapp.com' },
        { name: 'Subject', value: 'Re: Price match request: Whole Milk 2L' },
        { name: 'Date', value: 'Sat, 7 Nov 2026 14:04:58 +0000' },
        { name: 'Message-ID', value: '<CAF=reply1@mail.gmail.com>' },
        { name: 'In-Reply-To', value: '<request1@gmail.com>' },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: '0',
          mimeType: 'multipart/alternative',
          filename: '',
          body: { size: 0 },
          parts: [text, html],
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'Quote 2611.pdf',
          headers: [
            {
              name: 'Content-Disposition',
              value: 'attachment; filename="Quote 2611.pdf"',
            },
          ],
          body: { size: 12000, attachmentId: 'ANGjdJ8' },
        },
      ],
    },
    ...over,
  }
}

describe('a Gmail API message as a reply', () => {
  it('becomes the InboundMessage the IMAP path builds', () => {
    const pdf = new Uint8Array([37, 80, 68, 70])
    const m = gmailToInbound(phoneReply(), new Map([['1', pdf]]), DRAFT)
    expect(m).toEqual({
      message_id: '<CAF=reply1@mail.gmail.com>',
      from_email: 'sean@leevalley.ie',
      from_name: 'Seán Murphy',
      to: ['aoife.corner@gmail.com'],
      recipients: [
        'aoife.corner@gmail.com',
        'abc+11111111@inbound.postmarkapp.com',
      ],
      subject: 'Re: Price match request: Whole Milk 2L',
      text: 'Hi Aoife, quote attached.\n\nSeán',
      reply_text: null,
      received_at: '2026-11-07T14:04:58.000Z',
      mailbox_hash: null,
      attachments: [
        { name: 'Quote 2611.pdf', type: 'application/pdf', bytes: pdf },
      ],
      draft_id: DRAFT,
    })
  })

  it('lists attachments to fetch, and keeps small inline ones', () => {
    const msg = phoneReply()
    msg.payload!.parts!.push({
      partId: '2',
      mimeType: 'image/png',
      filename: 'sig.png',
      body: { size: 3, data: b64('png') },
    })
    expect(attachmentRefs(msg)).toEqual([
      {
        partId: '1',
        attachmentId: 'ANGjdJ8',
        data: null,
        name: 'Quote 2611.pdf',
        type: 'application/pdf',
      },
      {
        partId: '2',
        attachmentId: null,
        data: b64('png'),
        name: 'sig.png',
        type: 'image/png',
      },
    ])
    const m = gmailToInbound(msg, new Map(), DRAFT)!
    expect(m.attachments.map((a) => a.name)).toEqual(['sig.png'])
  })

  it('reads an HTML-only body as text, in its own charset', () => {
    const html: GmailMessage = {
      id: 'x',
      threadId: 't',
      payload: {
        mimeType: 'text/html',
        headers: [
          { name: 'From', value: 'shop@example.ie' },
          { name: 'Content-Type', value: 'text/html; charset=ISO-8859-1' },
        ],
        body: {
          data: Buffer.from(
            '<p>Caf\xe9 price list</p><table><tr><td>Milk</td><td>1.79</td></tr></table>',
            'latin1',
          ).toString('base64url'),
        },
      },
    }
    const text = bodyText(html)
    expect(text).toContain('Café price list')
    expect(text).toContain('Milk')
    expect(text).toContain('1.79')
  })

  it('decodes encoded subjects and falls back to Gmail ids and dates', () => {
    const msg: GmailMessage = {
      id: '18c9',
      threadId: 't',
      internalDate: String(Date.parse('2026-11-07T15:00:00Z')),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: '=?UTF-8?Q?Se=C3=A1n?= <sean@leevalley.ie>' },
          { name: 'Subject', value: '=?UTF-8?B?UmU6IENhZsOp?=' },
        ],
        body: { data: b64('ok') },
      },
    }
    const m = gmailToInbound(msg, new Map(), DRAFT)!
    expect(m.from_name).toBe('Seán')
    expect(m.subject).toBe('Re: Café')
    expect(m.message_id).toBe('gmail:18c9')
    expect(m.received_at).toBe('2026-11-07T15:00:00.000Z')
  })

  it('is skipped when it has no sender', () => {
    const msg = phoneReply()
    msg.payload!.headers = msg.payload!.headers!.filter(
      (h) => h.name !== 'From',
    )
    expect(gmailToInbound(msg, new Map(), DRAFT)).toBeNull()
  })
})

describe('which thread messages are new replies', () => {
  const sentAt = '2026-11-07T13:40:00Z'
  const own = 'Aoife.Corner@gmail.com'
  const request: GmailMessage = {
    id: '18c0',
    threadId: '18c0',
    labelIds: ['SENT'],
    internalDate: String(Date.parse(sentAt)),
    payload: {
      headers: [
        { name: 'From', value: '"Aoife" <aoife.corner@gmail.com>' },
        { name: 'Message-ID', value: '<request1@gmail.com>' },
      ],
    },
  }
  const withHeaders = (
    id: string,
    from: string,
    over: Partial<GmailMessage> = {},
  ): GmailMessage => ({
    id,
    threadId: '18c0',
    labelIds: ['INBOX'],
    internalDate: String(Date.parse('2026-11-07T14:00:00Z')),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Message-ID', value: `<${id}@x>` },
      ],
    },
    ...over,
  })

  it('keeps supplier replies, flags bounces, and skips the rest', () => {
    const reply = phoneReply()
    const bounce = withHeaders(
      'b1',
      'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    )
    const ownFollowUp = withHeaders('o1', 'aoife.corner@gmail.com')
    const spam = withHeaders('s1', 'x@spam.example', { labelIds: ['SPAM'] })
    const deleted = withHeaders('d1', 'sean@leevalley.ie', {
      labelIds: ['TRASH'],
    })
    const older = withHeaders('e1', 'sean@leevalley.ie', {
      internalDate: String(Date.parse('2026-11-01T10:00:00Z')),
    })
    const picked = newReplies(
      [request, reply, bounce, ownFollowUp, spam, deleted, older],
      { own, sentAt, seen: new Set() },
    )
    expect(picked.map((p) => [p.message.id, p.bounce])).toEqual([
      ['18c1', false],
      ['b1', true],
    ])
  })

  it('skips replies Shelfie has already read', () => {
    const reply = phoneReply()
    expect(
      newReplies([reply], { own, sentAt, seen: new Set([replyKey(reply)]) }),
    ).toEqual([])
  })
})
