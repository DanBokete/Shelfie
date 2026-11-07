import { createFileRoute } from '@tanstack/react-router'
import { handle, readFile } from '#/lib/http.server'
import { identifyPhoto } from '#/lib/scan.server'

// POST multipart {file}: identify a product from a photo.
export const Route = createFileRoute('/api/scan/identify')({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () =>
          Response.json(await identifyPhoto(await readFile(request))),
        ),
    },
  },
})
