// Service-role Supabase client. Server only: never import this into a component.
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

export function db(): SupabaseClient {
  if (client) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key)
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env',
    )
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

/** Unwraps a Supabase result, throwing on error. */
export function must<T>(
  res: { data: T; error: { message: string } | null },
  what: string,
): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

/** Unwraps a single-row result, throwing on error or when the row is missing. */
export function mustOne<T>(
  res: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  const row = must(res, what)
  if (row == null) throw new Error(`${what}: not found`)
  return row
}

/** Downloads a stored file, throwing if it is missing. */
export async function downloadFile(
  bucket: string,
  filePath: string,
): Promise<Blob> {
  const blob = must(
    await db().storage.from(bucket).download(filePath),
    `download ${filePath}`,
  )
  if (!blob) throw new Error(`File not found: ${filePath}`)
  return blob
}

export const INVOICE_BUCKET = 'invoices'
