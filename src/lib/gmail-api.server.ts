// The Gmail REST API, with the owner's connected account (lib/google-auth.server.ts).
// https://developers.google.com/workspace/gmail/api/reference/rest
import {
  GmailReconnectError,
  gmailAccess,
  gmailAccessAfterRejection,
  markReconnectNow,
} from './google-auth.server'
import type { GmailMessage } from './gmail-message.server'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/'

/** A Gmail API failure, in the owner's words. */
export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

interface GoogleError {
  error?: {
    code?: number
    message?: string
    status?: string
    errors?: Array<{ reason?: string }>
  }
}

/** Gmail's failures the owner can act on, in their words. */
export function gmailApiError(
  status: number,
  body: GoogleError | null,
): string {
  const reasons = (body?.error?.errors ?? []).map((e) => e.reason)
  const message = body?.error?.message ?? `HTTP ${status}`
  if (
    reasons.includes('accessNotConfigured') ||
    /has not been used in project|is disabled/i.test(message)
  )
    return 'The Gmail API is not enabled in your Google Cloud project. Enable it (see the README, "Connect Gmail") and try again.'
  if (status === 429 || reasons.includes('rateLimitExceeded'))
    return 'Gmail is busy right now. Try again in a minute.'
  if (reasons.includes('dailyLimitExceeded') || /sending limit/i.test(message))
    return 'Gmail’s daily sending limit is reached. Try again tomorrow.'
  if (status === 400 && /recipient|address/i.test(message))
    return 'Gmail would not accept the To address. Check it is correct.'
  if (status >= 500) return 'Gmail is not answering. Try again in a minute.'
  return `Gmail error: ${message}`
}

/**
 * Calls the Gmail API as the connected account. A 401 means the access token was revoked:
 * it is refreshed once, and if Google refuses, the owner is asked to reconnect. A 403 for
 * missing permissions also asks to reconnect.
 */
export async function gmail<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let { token } = await gmailAccess()
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    }).catch((err: unknown) => {
      throw new GmailApiError(
        `Could not reach Gmail. Check the internet connection. (${err instanceof Error ? err.message : String(err)})`,
        0,
      )
    })
    if (res.ok) return (await res.json()) as T
    const body = (await res.json().catch(() => null)) as GoogleError | null
    if (res.status === 401 && attempt === 0) {
      token = (await gmailAccessAfterRejection()).token
      continue
    }
    if (res.status === 401)
      throw new GmailReconnectError(
        'Google stopped Shelfie’s access to your Gmail. Reconnect Gmail in Settings.',
      )
    const reasons = (body?.error?.errors ?? []).map((e) => e.reason)
    if (
      res.status === 403 &&
      (reasons.includes('insufficientPermissions') ||
        /insufficient authentication scopes/i.test(body?.error?.message ?? ''))
    )
      return markReconnectNow(
        `Gmail refused: ${body?.error?.message ?? 'missing permission'}`,
      )
    throw new GmailApiError(gmailApiError(res.status, body), res.status)
  }
}

// --- Calls -----------------------------------------------------------------------------

/** users.messages.send: the raw email, base64url. */
export function sendMessage(raw: string) {
  return gmail<{ id: string; threadId: string }>('messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  })
}

/** users.messages.get with only the headers named. */
export function messageHeaders(id: string, names: Array<string>) {
  const q = new URLSearchParams({ format: 'metadata' })
  for (const n of names) q.append('metadataHeaders', n)
  return gmail<GmailMessage>(`messages/${encodeURIComponent(id)}?${q}`)
}

/** users.messages.get, format=full: headers and body, attachments by id. */
export function getMessage(id: string) {
  return gmail<GmailMessage>(`messages/${encodeURIComponent(id)}?format=full`)
}

/** users.threads.get, format=full. Null when the thread is gone (deleted for good). */
export async function getThread(
  id: string,
): Promise<Array<GmailMessage> | null> {
  try {
    const t = await gmail<{ messages?: Array<GmailMessage> }>(
      `threads/${encodeURIComponent(id)}?format=full`,
    )
    return t.messages ?? []
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) return null
    throw err
  }
}

/** users.messages.list with a Gmail search, ids only. */
export async function searchMessages(
  q: string,
  max = 20,
): Promise<Array<{ id: string; threadId: string }>> {
  const params = new URLSearchParams({ q, maxResults: String(max) })
  const r = await gmail<{ messages?: Array<{ id: string; threadId: string }> }>(
    `messages?${params}`,
  )
  return r.messages ?? []
}

/** users.messages.attachments.get: the attachment's bytes. */
export async function getAttachment(
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const r = await gmail<{ data?: string }>(
    `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  )
  return new Uint8Array(Buffer.from(r.data ?? '', 'base64url'))
}
