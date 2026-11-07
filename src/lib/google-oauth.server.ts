// The parts of "Connect Gmail" that need no network: which scopes to ask for, where Google
// sends the owner back, and checking that the callback answers the sign-in this browser
// started (state and PKCE verifier kept in an encrypted, httpOnly cookie).
import { timingSafeEqual } from 'node:crypto'
import { decrypt, encrypt } from './token-crypto.server'

/** Only what Shelfie needs: who the owner is, sending, and reading replies. */
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly'
export const GOOGLE_SCOPES = ['openid', 'email', GMAIL_SEND, GMAIL_READ]

export const CALLBACK_PATH = '/api/auth/google/callback'
export const SIGN_IN_COOKIE = 'shelfie_google_sign_in'
/** How long the owner has to finish signing in with Google. */
export const SIGN_IN_TTL_S = 10 * 60

/**
 * The callback URL for this request, as the browser sees it. Behind a tunnel or proxy the
 * request reaches the server as http://localhost, so X-Forwarded-Host/Proto win.
 */
export function redirectUriFor(request: Request): string {
  const url = new URL(request.url)
  const first = (h: string) =>
    request.headers.get(h)?.split(',')[0]?.trim() || null
  const host = first('x-forwarded-host') ?? url.host
  const proto = (first('x-forwarded-proto') ?? url.protocol).replace(/:$/, '')
  return `${proto}://${host}${CALLBACK_PATH}`
}

export interface SignIn {
  state: string
  verifier: string
  /** Seconds since 1970, when the sign-in started. */
  at: number
}

export function sealSignIn(s: SignIn, key?: Buffer): string {
  return encrypt(JSON.stringify(s), key)
}

/** The Set-Cookie value for a sign-in, scoped to the Google auth routes. */
export function signInCookie(
  value: string,
  secure: boolean,
  maxAge = SIGN_IN_TTL_S,
): string {
  return [
    `${SIGN_IN_COOKIE}=${value}`,
    'Path=/api/auth/google',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    // Lax: the cookie comes back on Google's top-level redirect to the callback.
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim() || null
  }
  return null
}

/** Why a callback was refused; each has its own message on the Settings page. */
export type CallbackProblem = 'denied' | 'expired' | 'state' | 'failed'

/**
 * Checks Google's answer against the sign-in this browser started. On success, returns the
 * code and the PKCE verifier to exchange it with.
 */
export function checkCallback(input: {
  params: URLSearchParams
  cookie: string | null
  now?: number
  key?: Buffer
}):
  | { ok: true; code: string; verifier: string }
  | { ok: false; problem: CallbackProblem } {
  const { params } = input
  // The owner pressed Cancel, or closed the consent screen.
  if (params.get('error') === 'access_denied')
    return { ok: false, problem: 'denied' }
  if (params.get('error')) return { ok: false, problem: 'failed' }
  if (!input.cookie) return { ok: false, problem: 'expired' }
  let s: SignIn
  try {
    s = JSON.parse(decrypt(input.cookie, input.key)) as SignIn
  } catch {
    return { ok: false, problem: 'state' }
  }
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(s.at) || now - s.at > SIGN_IN_TTL_S)
    return { ok: false, problem: 'expired' }
  const state = params.get('state')
  if (!state || !sameString(state, s.state))
    return { ok: false, problem: 'state' }
  const code = params.get('code')
  if (!code) return { ok: false, problem: 'failed' }
  return { ok: true, code, verifier: s.verifier }
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The Gmail permissions the owner left unticked on Google's consent screen. Google lets
 * them grant some scopes and not others.
 */
export function missingScopes(
  granted: string | null | undefined,
): Array<string> {
  const have = new Set((granted ?? '').split(/\s+/))
  return [GMAIL_SEND, GMAIL_READ].filter((s) => !have.has(s))
}
