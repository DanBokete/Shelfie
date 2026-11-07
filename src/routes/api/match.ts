import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handle } from '#/lib/http.server'
import { applyOutcomes, matchLines } from '#/lib/match.server'
import { db, must } from '#/lib/supabase.server'

// POST json {observation_ids}: run (or re-run) the matching pipeline on stored price lines.
export const Route = createFileRoute('/api/match')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const { observation_ids } = z
            .object({ observation_ids: z.array(z.uuid()).min(1).max(200) })
            .parse(await request.json())
          const rows = must(
            await db()
              .from('price_observations')
              .select('id, raw_description, supplier_id, suppliers(name)')
              .in('id', observation_ids),
            'load lines',
          ) as unknown as Array<{
            id: string
            raw_description: string
            supplier_id: string
            suppliers: { name: string } | null
          }>
          const outcomes = await matchLines(
            rows.map((r) => ({
              id: r.id,
              description: r.raw_description,
              supplier_id: r.supplier_id,
              supplier_name: r.suppliers?.name ?? '',
              barcode: null,
            })),
          )
          await applyOutcomes(outcomes)
          return Response.json({ outcomes })
        }),
    },
  },
})
