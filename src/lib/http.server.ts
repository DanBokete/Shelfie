// Helpers for the /api server routes.
import { z } from 'zod'
import { AIError } from './claude.server'

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

/** Runs a handler and turns thrown errors into JSON responses the UI can show. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof z.ZodError)
      return jsonError(
        400,
        `Bad request: ${err.issues.map((i) => i.message).join('; ')}`,
      )
    if (err instanceof AIError)
      return jsonError(err.kind === 'config' ? 500 : 502, err.message)
    console.error(err)
    return jsonError(
      500,
      err instanceof Error ? err.message : 'Something went wrong',
    )
  }
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** Reads the 'file' field of a multipart request. */
export async function readFile(
  request: Request,
): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File))
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['file'],
        message: 'file is required',
        input: null,
      },
    ])
  if (file.size > MAX_UPLOAD_BYTES)
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['file'],
        message: 'file is over 20 MB',
        input: null,
      },
    ])
  return {
    name: file.name,
    type: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  }
}
