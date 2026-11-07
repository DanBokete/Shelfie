import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handle } from '#/lib/http.server'
import { checkProductPrices } from '#/lib/market.server'

// POST json {product_id}: search the web now for what other sellers charge. Takes up to a minute.
export const Route = createFileRoute('/api/prices/check')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const { product_id } = z
            .object({ product_id: z.uuid() })
            .parse(await request.json())
          return Response.json({ check: await checkProductPrices(product_id) })
        }),
    },
  },
})
