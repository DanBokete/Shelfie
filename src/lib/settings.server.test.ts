import { afterEach, describe, expect, it, vi } from 'vitest'
import { replyByDate } from './email.server'
import { inboundAddressFor } from './inbound'
import { P11_QUOTE_REQUEST } from './prompts'
import { fromHeader, gmailError } from './send.server'
import {
  inboundAddress,
  replyCc,
  sendingStatus,
  webhookSecret,
  withBusiness,
} from './settings.server'
import type { Settings } from './settings.server'

const DRAFT = '11111111-1111-4111-8111-111111111111'

const base: Settings = {
  business_name: 'The Corner Café',
  owner_name: 'Aoife',
  town: 'Cork',
  reply_by_days: 7,
  cc_shelfie: true,
  bcc_email: null,
  send_via: 'gmail',
  from_email: null,
  reply_scanning: true,
  inbound_address: 'abc123@inbound.postmarkapp.com',
  webhook_secret: null,
  match_by_sender: true,
  alerts_enabled: true,
  alert_min_saving: 0,
  replies_checked_at: null,
  replies_check_error: null,
  updated_at: '2026-11-07T12:00:00Z',
}

afterEach(() => vi.unstubAllEnvs())

describe('reply address and secret', () => {
  it('prefers the saved value, then .env', () => {
    vi.stubEnv('INBOUND_EMAIL_ADDRESS', 'env@inbound.postmarkapp.com')
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', 'env-secret')
    expect(inboundAddress(base)).toBe('abc123@inbound.postmarkapp.com')
    expect(inboundAddress({ ...base, inbound_address: null })).toBe(
      'env@inbound.postmarkapp.com',
    )
    expect(webhookSecret({ ...base, webhook_secret: 'saved' })).toBe('saved')
    expect(webhookSecret(base)).toBe('env-secret')
  })

  it('is null when neither is set', () => {
    vi.stubEnv('INBOUND_EMAIL_ADDRESS', '')
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', '')
    expect(inboundAddress({ ...base, inbound_address: null })).toBeNull()
    expect(webhookSecret(base)).toBeNull()
  })
})

describe('CC on requests', () => {
  it('CCs the per-draft plus-address', () => {
    expect(replyCc(base, inboundAddressFor, DRAFT)).toBe(
      `abc123+${DRAFT}@inbound.postmarkapp.com`,
    )
  })

  it('does not CC when turned off, when scanning is off, or with no address', () => {
    vi.stubEnv('INBOUND_EMAIL_ADDRESS', '')
    expect(
      replyCc({ ...base, cc_shelfie: false }, inboundAddressFor, DRAFT),
    ).toBeNull()
    expect(
      replyCc({ ...base, reply_scanning: false }, inboundAddressFor, DRAFT),
    ).toBeNull()
    expect(
      replyCc({ ...base, inbound_address: null }, inboundAddressFor, DRAFT),
    ).toBeNull()
  })
})

describe('business details in prompts', () => {
  it('fills owner, business and every mention of the town', () => {
    const p = withBusiness(P11_QUOTE_REQUEST, {
      ...base,
      business_name: 'Bean There',
      owner_name: 'Niamh',
      town: 'Galway',
    })
    expect(p).toContain('Sign off as Niamh, Bean There, Galway.')
    expect(p).toContain('delivery to Galway')
    expect(p).not.toMatch(/\{(owner_name|business_name|town)\}/)
    expect(p).not.toContain('Cork')
  })
})

describe('reply-by date', () => {
  it('is the given number of days out', () => {
    const from = new Date('2026-11-07T12:00:00Z')
    expect(replyByDate(7, from)).toBe('Saturday, 14 November')
    expect(replyByDate(10, from)).toBe('Tuesday, 17 November')
  })
})

describe('sending', () => {
  it('through Gmail needs an app password and the Gmail address', () => {
    vi.stubEnv('GMAIL_APP_PASSWORD', '')
    const gmail = { ...base, from_email: 'aoife@gmail.com' }
    expect(sendingStatus(gmail).problem).toMatch(/GMAIL_APP_PASSWORD/)
    vi.stubEnv('GMAIL_APP_PASSWORD', 'abcd efgh ijkl mnop')
    expect(sendingStatus(base).problem).toMatch(/Gmail address/)
    expect(sendingStatus(gmail)).toEqual({ ready: true, problem: null })
  })

  it('through Postmark needs a token and a non-Gmail From address', () => {
    const pm = { ...base, send_via: 'postmark' as const }
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    expect(sendingStatus({ ...pm, from_email: 'a@b.ie' }).problem).toMatch(
      /POSTMARK_SERVER_TOKEN/,
    )
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'token')
    expect(sendingStatus(pm).problem).toMatch(/Settings/)
    expect(
      sendingStatus({ ...pm, from_email: 'aoife@gmail.com' }).problem,
    ).toMatch(/cannot send from a Gmail address/)
    expect(sendingStatus({ ...pm, from_email: 'a@b.ie' })).toEqual({
      ready: true,
      problem: null,
    })
  })

  it('explains Gmail failures the owner can fix', () => {
    expect(gmailError({ code: 'EAUTH', responseCode: 535 })).toMatch(
      /app password/,
    )
    expect(
      gmailError({
        responseCode: 550,
        response: '550 5.4.5 Daily user sending limit exceeded.',
      }),
    ).toMatch(/daily sending limit/)
    expect(gmailError({ code: 'ETIMEDOUT' })).toMatch(/Could not reach Gmail/)
    expect(gmailError({ code: 'EOTHER' })).toBeNull()
  })

  it('writes the From line with the owner and business, quoted', () => {
    expect(
      fromHeader({
        ...base,
        owner_name: 'Aoife',
        business_name: 'Café "Corner", Cork',
        from_email: 'orders@corner.ie',
      }),
    ).toBe('"Aoife at Café Corner, Cork" <orders@corner.ie>')
  })
})
