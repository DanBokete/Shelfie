import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handle, jsonError } from '#/lib/http.server'
import { SendError, sendDraft } from '#/lib/send.server'

const Body = z.object({
  id: z.uuid(),
  to: z.email('Enter the supplier email address'),
  subject: z.string().trim().min(1, 'Add a subject').max(300),
  body: z.string().trim().min(1, 'The message is empty').max(5000),
})

// POST json {id, to, subject, body}: send a drafted request through Postmark, with the
// owner's edits. CC and BCC come from Settings on the server.
export const Route = createFileRoute('/api/email/send')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const { id, ...edits } = Body.parse(await request.json())
          try {
            return Response.json(await sendDraft(id, edits))
          } catch (err) {
            if (err instanceof SendError) return jsonError(400, err.message)
            throw err
          }
        }),
    },
  },
})
