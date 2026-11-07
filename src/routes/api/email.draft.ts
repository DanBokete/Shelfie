import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { draftEmail } from '#/lib/email.server'
import { handle } from '#/lib/http.server'
import { draftQuoteRequest } from '#/lib/quotes.server'

const Item = z.object({
  product_id: z.uuid().optional(),
  product_name: z.string().min(1).max(200),
  pack_label: z.string().max(100),
  your_price: z.number().positive(),
  best_price: z.number().positive(),
  weekly_quantity: z.number().nonnegative().nullable(),
})

const Body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('match'),
    supplier_id: z.uuid(),
    items: z.array(Item).min(1).max(40),
  }),
  z.object({ kind: z.literal('quote'), offer_id: z.uuid() }),
])

// POST json {kind: 'match', supplier_id, items}: ask a current supplier to match lower prices.
// POST json {kind: 'quote', offer_id}: ask a seller found online for a trade quote.
export const Route = createFileRoute('/api/email/draft')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const body = Body.parse(await request.json())
          if (body.kind === 'quote') {
            return Response.json(await draftQuoteRequest(body.offer_id))
          }
          return Response.json(await draftEmail(body.supplier_id, body.items))
        }),
    },
  },
})
