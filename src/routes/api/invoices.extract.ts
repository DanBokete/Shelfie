import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { handle, readFile } from '#/lib/http.server'
import { extractInvoice, storeInvoiceFile } from '#/lib/invoices.server'

// POST multipart {file}: store and extract a new invoice.
// POST json {invoice_id}: retry extraction of a stored invoice.
export const Route = createFileRoute('/api/invoices/extract')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          let invoiceId: string
          if (
            request.headers.get('content-type')?.includes('multipart/form-data')
          ) {
            invoiceId = await storeInvoiceFile(await readFile(request))
          } else {
            invoiceId = z
              .object({ invoice_id: z.uuid() })
              .parse(await request.json()).invoice_id
          }
          return Response.json(await extractInvoice(invoiceId))
        }),
    },
  },
})
