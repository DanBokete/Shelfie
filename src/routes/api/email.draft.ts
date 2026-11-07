import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { draftEmail } from '#/lib/email.server'
import { handle } from '#/lib/http.server'

const Item = z.object({
  product_name: z.string().min(1).max(200),
  pack_label: z.string().max(100),
  your_price: z.number().positive(),
  best_price: z.number().positive(),
  weekly_quantity: z.number().nonnegative().nullable(),
})

// POST json {supplier_id, items}: draft one negotiation email for one supplier.
export const Route = createFileRoute('/api/email/draft')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const body = z
            .object({
              supplier_id: z.uuid(),
              items: z.array(Item).min(1).max(40),
            })
            .parse(await request.json())
          return Response.json(await draftEmail(body.supplier_id, body.items))
        }),
    },
  },
})
