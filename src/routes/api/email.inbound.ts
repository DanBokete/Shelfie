import { timingSafeEqual } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { handle, jsonError } from '#/lib/http.server'
import { parsePostmark, receiveInbound } from '#/lib/inbound.server'
import { getSettings, webhookSecret } from '#/lib/settings.server'

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The webhook URL carries the secret: https://user:SECRET@host/api/email/inbound, or ?secret=SECRET. */
function authorised(request: Request, secret: string): boolean {
  const url = new URL(request.url)
  const query = url.searchParams.get('secret')
  if (query && same(query, secret)) return true
  const basic = /^Basic (.+)$/i.exec(request.headers.get('authorization') ?? '')
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8')
    const password = decoded.slice(decoded.indexOf(':') + 1)
    if (same(password, secret)) return true
  }
  return false
}

// POST: Postmark's inbound webhook. Keeps the reply, ties it to the request it answers and
// reads it. Always answers 200 for a message it has stored, so Postmark does not retry it.
// The secret and the on/off switch come from Settings, with .env as the fallback secret.
export const Route = createFileRoute('/api/email/inbound')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const settings = await getSettings()
          const secret = webhookSecret(settings)
          if (!secret)
            return jsonError(
              503,
              'Reply scanning is not set up: generate a webhook secret in Settings.',
            )
          if (!authorised(request, secret))
            return jsonError(401, 'Unauthorised')
          // Turned off: accept and drop, so Postmark does not keep retrying.
          if (!settings.reply_scanning)
            return Response.json({ ignored: 'reply scanning is off' })
          const msg = parsePostmark(await request.json())
          return Response.json(await receiveInbound(msg))
        }),
    },
  },
})
