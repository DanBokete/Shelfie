import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  MAX_ROWS,
  createUpload,
  detectColumns,
  finalize,
  matchBatch,
  transcribePhoto,
} from '#/lib/audit.server'
import { handle, readFile } from '#/lib/http.server'

const cell = z.string().max(500)
const StockRow = z.object({
  raw_name: z.string().min(1).max(500),
  raw_quantity: cell.nullable(),
  raw_unit: cell.nullable(),
  raw_price: cell.nullable(),
  raw_supplier: cell.nullable(),
})

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('columns'),
    rows: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          cells: z.array(cell).max(40),
        }),
      )
      .min(1)
      .max(15),
  }),
  z.object({
    action: z.literal('start'),
    file_name: z.string().max(300),
    mapping: z.unknown(),
  }),
  z.object({
    action: z.literal('batch'),
    upload_id: z.uuid(),
    period: z.enum(['week', 'month', 'unknown']),
    rows: z.array(StockRow).min(1).max(25),
  }),
  z.object({ action: z.literal('finish'), upload_id: z.uuid() }),
])

// One endpoint, called by the browser step by step so it can show progress:
// multipart {file} -> transcribe a photographed list into rows
// {action:'columns'} -> detect columns from the first 10 and last 5 rows
// {action:'start'} -> create the upload; {action:'batch'} -> match up to 25 rows; {action:'finish'} -> report
export const Route = createFileRoute('/api/audit')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          if (
            request.headers.get('content-type')?.includes('multipart/form-data')
          ) {
            const rows = await transcribePhoto(await readFile(request))
            return Response.json({ rows: rows.slice(0, MAX_ROWS + 20) })
          }
          const body = Body.parse(await request.json())
          switch (body.action) {
            case 'columns':
              return Response.json(await detectColumns(body.rows))
            case 'start':
              return Response.json({
                upload_id: await createUpload(body.file_name, body.mapping),
              })
            case 'batch':
              return Response.json(
                await matchBatch(body.upload_id, body.period, body.rows),
              )
            case 'finish':
              return Response.json(await finalize(body.upload_id))
          }
        }),
    },
  },
})
