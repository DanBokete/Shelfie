import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { checkGmailReplies } from '#/lib/gmail-replies.server'
import { handle } from '#/lib/http.server'

// POST json {force?}: check the owner's Gmail for replies to sent requests and read them.
// The app calls this every few minutes while open; force skips the once-a-minute limit.
export const Route = createFileRoute('/api/email/replies')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const { force } = z
            .object({ force: z.boolean().optional() })
            .parse(await request.json().catch(() => ({})))
          return Response.json(await checkGmailReplies({ force }))
        }),
    },
  },
})
