import { timingSafeEqual } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { handle, jsonError } from '#/lib/http.server'
import { parsePostmark, receiveInbound } from '#/lib/inbound.server'

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The webhook URL carries the secret: https://user:SECRET@host/api/email/inbound, or ?secret=SECRET. */
function authorised(request: Request): boolean {
  const secret = process.env.INBOUND_WEBHOOK_SECRET
  if (!secret) return false
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
export const Route = createFileRoute('/api/email/inbound')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          if (!process.env.INBOUND_WEBHOOK_SECRET)
            return jsonError(
              503,
              'Reply scanning is not set up: INBOUND_WEBHOOK_SECRET is missing.',
            )
          if (!authorised(request)) return jsonError(401, 'Unauthorised')
          const msg = parsePostmark(await request.json())
          return Response.json(await receiveInbound(msg))
        }),
    },
  },
})
