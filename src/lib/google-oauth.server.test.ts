import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GMAIL_READ,
  GMAIL_SEND,
  SIGN_IN_COOKIE,
  checkCallback,
  missingScopes,
  readCookie,
  redirectUriFor,
  sealSignIn,
  signInCookie,
} from './google-oauth.server'

const key = randomBytes(32)
const NOW = 1_794_000_000
const cookie = sealSignIn(
  { state: 'state-abc', verifier: 'verifier-xyz', at: NOW },
  key,
)
const params = (q: string) => new URLSearchParams(q)

describe('the Google callback', () => {
  it('accepts the sign-in this browser started, with its verifier', () => {
    expect(
      checkCallback({
        params: params('state=state-abc&code=4/0abc'),
        cookie,
        now: NOW + 30,
        key,
      }),
    ).toEqual({ ok: true, code: '4/0abc', verifier: 'verifier-xyz' })
  })

  it('refuses a different state, a forged or missing cookie, and a stale sign-in', () => {
    const check = (q: string, c: string | null, now = NOW + 30) =>
      checkCallback({ params: params(q), cookie: c, now, key })
    expect(check('state=other&code=x', cookie)).toEqual({
      ok: false,
      problem: 'state',
    })
    expect(check('code=x', cookie)).toEqual({ ok: false, problem: 'state' })
    expect(check('state=state-abc&code=x', null)).toEqual({
      ok: false,
      problem: 'expired',
    })
    const forged = sealSignIn(
      { state: 'state-abc', verifier: 'v', at: NOW },
      randomBytes(32),
    )
    expect(check('state=state-abc&code=x', forged)).toEqual({
      ok: false,
      problem: 'state',
    })
    expect(check('state=state-abc&code=x', cookie, NOW + 11 * 60)).toEqual({
      ok: false,
      problem: 'expired',
    })
    expect(check('state=state-abc', cookie)).toEqual({
      ok: false,
      problem: 'failed',
    })
  })

  it('tells a cancelled sign-in apart from other errors', () => {
    const check = (q: string) =>
      checkCallback({ params: params(q), cookie, now: NOW, key })
    expect(check('error=access_denied&state=state-abc')).toEqual({
      ok: false,
      problem: 'denied',
    })
    expect(check('error=server_error')).toEqual({
      ok: false,
      problem: 'failed',
    })
  })
})

describe('the sign-in cookie', () => {
  it('is httpOnly, Lax, short-lived and only sent to the auth routes', () => {
    const c = signInCookie('v1.abc', true)
    expect(c).toContain(`${SIGN_IN_COOKIE}=v1.abc`)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/api/auth/google')
    expect(c).toContain('Max-Age=600')
    expect(c).toContain('Secure')
    expect(signInCookie('', false, 0)).not.toContain('Secure')
  })

  it('is read back from the Cookie header', () => {
    expect(
      readCookie(`a=1; ${SIGN_IN_COOKIE}=v1.x.y; b=2`, SIGN_IN_COOKIE),
    ).toBe('v1.x.y')
    expect(readCookie('a=1', SIGN_IN_COOKIE)).toBeNull()
    expect(readCookie(null, SIGN_IN_COOKIE)).toBeNull()
  })
})

describe('the redirect URI', () => {
  it('is the address the browser used, through a tunnel too', () => {
    expect(
      redirectUriFor(
        new Request('http://localhost:3000/api/auth/google/start'),
      ),
    ).toBe('http://localhost:3000/api/auth/google/callback')
    expect(
      redirectUriFor(
        new Request('http://localhost:3000/api/auth/google/start', {
          headers: {
            'x-forwarded-host': 'shelfie.trycloudflare.com',
            'x-forwarded-proto': 'https',
          },
        }),
      ),
    ).toBe('https://shelfie.trycloudflare.com/api/auth/google/callback')
  })
})

describe('granted scopes', () => {
  it('lists the Gmail permissions left unticked', () => {
    expect(missingScopes(`openid email ${GMAIL_SEND} ${GMAIL_READ}`)).toEqual(
      [],
    )
    expect(missingScopes(`openid ${GMAIL_SEND}`)).toEqual([GMAIL_READ])
    expect(missingScopes(undefined)).toEqual([GMAIL_SEND, GMAIL_READ])
  })
})
