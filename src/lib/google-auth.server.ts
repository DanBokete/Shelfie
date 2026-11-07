// The owner's Gmail connection ("Connect Gmail" in Settings): Google's OAuth web server
// flow with PKCE, the refresh token kept encrypted in email_accounts, and fresh access
// tokens for the Gmail API. Tokens never leave the server.
// https://developers.google.com/identity/protocols/oauth2/web-server
import { randomBytes } from 'node:crypto'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { emailOf } from './inbound'
import { GOOGLE_SCOPES, missingScopes, sealSignIn } from './google-oauth.server'
import { db, must } from './supabase.server'
import { decrypt, encrypt, encryptionKey } from './token-crypto.server'

/** What the rest of the app knows about the connection: never the token. */
export interface GmailLink {
  email: string
  connected_at: string
  /** Google refused the refresh token: the owner has to connect again. */
  needs_reconnect: boolean
  last_error: string | null
}

interface AccountRow extends GmailLink {
  id: string
  refresh_token: string
}

/** The owner has to sign in with Google again; shown as is. */
export class GmailReconnectError extends Error {}

/** Whether "Connect Gmail" can work, and if not, what to add to .env. */
export function googleSetupProblem(): string | null {
  const missing = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
  ].filter((k) => !process.env[k])
  if (missing.length)
    return `To connect Gmail, add ${missing.join(', ')} to .env and restart (see the README, "Connect Gmail").`
  try {
    encryptionKey()
  } catch (err) {
    return (err as Error).message
  }
  return null
}

function client(redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  })
}

// --- Signing in ------------------------------------------------------------------------

/** Google's consent screen URL, and the sealed state + PKCE verifier for the cookie. */
export async function startSignIn(
  redirectUri: string,
): Promise<{ url: string; cookie: string }> {
  const c = client(redirectUri)
  const { codeVerifier, codeChallenge } = await c.generateCodeVerifierAsync()
  const state = randomBytes(32).toString('base64url')
  const url = c.generateAuthUrl({
    access_type: 'offline',
    // Always show consent, so Google always returns a refresh token.
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  })
  return {
    url,
    cookie: sealSignIn({
      state,
      verifier: codeVerifier,
      at: Math.floor(Date.now() / 1000),
    }),
  }
}

/** Why connecting failed; the Settings page explains each code. */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly code: 'scopes' | 'failed',
  ) {
    super(message)
  }
}

/**
 * Exchanges Google's code for tokens and stores the connection. Replaces an earlier one
 * (its token is revoked). Also makes the connected address the one requests come from.
 */
export async function finishSignIn(input: {
  code: string
  verifier: string
  redirectUri: string
}): Promise<{ email: string }> {
  const c = client(input.redirectUri)
  const { tokens } = await c.getToken({
    code: input.code,
    codeVerifier: input.verifier,
    redirect_uri: input.redirectUri,
  })
  const missing = missingScopes(tokens.scope)
  if (missing.length) {
    // Granted something, but not what Shelfie needs: give it back.
    if (tokens.access_token)
      await c.revokeToken(tokens.access_token).catch(() => undefined)
    throw new ConnectError(`Missing scopes: ${missing.join(' ')}`, 'scopes')
  }
  if (!tokens.refresh_token || !tokens.id_token)
    throw new ConnectError('No refresh token or id token', 'failed')
  const ticket = await c.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  })
  const payload = ticket.getPayload()
  const email = emailOf(payload?.email)
  if (!email || payload?.email_verified === false)
    throw new ConnectError('No verified email address', 'failed')

  const old = await loadAccount()
  must(
    await db()
      .from('email_accounts')
      .upsert(
        {
          provider: 'google',
          email,
          refresh_token: encrypt(tokens.refresh_token),
          scopes: (tokens.scope ?? '').split(/\s+/).filter(Boolean),
          connected_at: new Date().toISOString(),
          needs_reconnect: false,
          last_error: null,
        },
        { onConflict: 'provider' },
      ),
    'save Gmail connection',
  )
  forget()
  // Revoking a token ends the whole grant for that Google account, so only the old token of
  // a different account is revoked; the same account's old token would take the new one too.
  if (old && old.email !== email) await revoke(old)
  // Requests now come from this address, through the Gmail API.
  must(
    await db()
      .from('settings')
      .update({
        send_via: 'gmail',
        from_email: email,
        replies_check_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', true),
    'save Gmail address',
  )
  return { email }
}

/** Revokes Shelfie's access with Google and forgets the connection. */
export async function disconnectGmail(): Promise<void> {
  const account = await loadAccount()
  if (!account) return
  // Already revoked or expired is fine: the row goes either way.
  await revoke(account)
  must(
    await db().from('email_accounts').delete().eq('id', account.id),
    'remove Gmail connection',
  )
  forget()
}

async function revoke(account: AccountRow) {
  try {
    await client().revokeToken(decrypt(account.refresh_token))
  } catch (err) {
    console.warn('[gmail] could not revoke the old token', errorText(err))
  }
}

// --- The stored connection -------------------------------------------------------------

async function loadAccount(): Promise<AccountRow | null> {
  const rows = must(
    await db()
      .from('email_accounts')
      .select(
        'id, email, refresh_token, connected_at, needs_reconnect, last_error',
      )
      .eq('provider', 'google')
      .limit(1),
    'load Gmail connection',
  ) as Array<AccountRow>
  return rows[0] ?? null
}

/** The Gmail connection, without the token. Null when Gmail is not connected. */
export async function gmailLink(): Promise<GmailLink | null> {
  const a = await loadAccount()
  if (!a) return null
  return {
    email: a.email,
    connected_at: a.connected_at,
    needs_reconnect: a.needs_reconnect,
    last_error: a.last_error,
  }
}

// --- Access tokens ---------------------------------------------------------------------

/** One OAuth client per stored token: it keeps the access token and refreshes it. */
let cached: { sealed: string; email: string; client: OAuth2Client } | null =
  null

function forget() {
  cached = null
}

/**
 * A valid access token for the connected account. Throws GmailReconnectError (and marks
 * the account) when Google no longer accepts the refresh token.
 */
export async function gmailAccess(): Promise<{ token: string; email: string }> {
  const account = await loadAccount()
  if (!account) throw new GmailReconnectError('Gmail is not connected.')
  if (account.needs_reconnect) throw new GmailReconnectError(reconnectText())
  if (cached?.sealed !== account.refresh_token) {
    const c = client()
    c.setCredentials({ refresh_token: decrypt(account.refresh_token) })
    cached = { sealed: account.refresh_token, email: account.email, client: c }
  }
  try {
    const { token } = await cached.client.getAccessToken()
    if (!token) throw new Error('Google returned no access token')
    if (account.last_error)
      await db()
        .from('email_accounts')
        .update({ last_error: null })
        .eq('id', account.id)
    return { token, email: account.email }
  } catch (err) {
    if (isInvalidGrant(err)) {
      await markReconnect(account.id, errorText(err))
      throw new GmailReconnectError(reconnectText())
    }
    throw err
  }
}

/**
 * Called when Gmail refuses a token Shelfie just refreshed (access revoked in the Google
 * account): drop it, and try one refresh. If Google refuses that too, the owner reconnects.
 */
export async function gmailAccessAfterRejection(): Promise<{
  token: string
  email: string
}> {
  forget()
  return gmailAccess()
}

/** Gmail refused the scopes it was given: connect again with both permissions. */
export async function markReconnectNow(reason: string): Promise<never> {
  const account = await loadAccount()
  if (account) await markReconnect(account.id, reason)
  forget()
  throw new GmailReconnectError(reconnectText())
}

async function markReconnect(id: string, reason: string) {
  forget()
  await db()
    .from('email_accounts')
    .update({ needs_reconnect: true, last_error: reason })
    .eq('id', id)
}

function reconnectText() {
  return 'Google stopped Shelfie’s access to your Gmail. Reconnect Gmail in Settings.'
}

/**
 * Google refuses a refresh token with invalid_grant when access was revoked, the token
 * expired (after 7 days while the app is in Testing mode, or 6 months unused), or the
 * password changed. https://developers.google.com/identity/protocols/oauth2#expiration
 */
export function isInvalidGrant(err: unknown): boolean {
  const e = err as {
    response?: { data?: { error?: string } }
    message?: string
  }
  return (
    e.response?.data?.error === 'invalid_grant' ||
    /invalid_grant/.test(e.message ?? '')
  )
}

function errorText(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: string; error_description?: string } }
  }
  const d = e.response?.data
  if (d?.error) return [d.error, d.error_description].filter(Boolean).join(': ')
  return err instanceof Error ? err.message : String(err)
}
