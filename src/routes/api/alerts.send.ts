import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { sendTest, sendWeekly } from '#/lib/alerts.server'
import { handle, jsonError } from '#/lib/http.server'

// POST json {kind?: 'weekly' | 'test'}: send this week's summary (the default) or a test
// message to the owner's Telegram now. A real product would send the weekly one on a schedule.
// Answers 200 with {ok, text} when Telegram took the message, otherwise 502 with the reason;
// either way the attempt is recorded in alerts_sent.
export const Route = createFileRoute('/api/alerts/send')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const raw = await request.text()
          const { kind } = z
            .object({ kind: z.enum(['weekly', 'test']).default('weekly') })
            .parse(raw.trim() ? JSON.parse(raw) : {})
          const result = kind === 'test' ? await sendTest() : await sendWeekly()
          if (!result.ok) return jsonError(502, result.error ?? 'Not sent')
          return Response.json({ ok: true, text: result.text })
        }),
    },
  },
})
