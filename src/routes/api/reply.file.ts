import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handle } from '#/lib/http.server'
import { replyAttachment } from '#/lib/reply-review.server'

// GET ?reply=<id>&i=<index>: one attachment of a supplier reply, shown on the review page.
export const Route = createFileRoute('/api/reply/file')({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const q = new URL(request.url).searchParams
          const { reply, i } = z
            .object({ reply: z.uuid(), i: z.coerce.number().int().min(0) })
            .parse({ reply: q.get('reply'), i: q.get('i') })
          const file = await replyAttachment(reply, i)
          return new Response(file.blob, {
            headers: {
              'Content-Type': file.type,
              'Content-Disposition': `inline; filename="${file.name.replace(/[^\w.-]+/g, '_')}"`,
              'Cache-Control': 'private, max-age=300',
            },
          })
        }),
    },
  },
})
