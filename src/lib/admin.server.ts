// Demo safety: snapshot the database and restore it in one tap.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { mediaTypeFor } from './media.server'
import { INVOICE_BUCKET, db, downloadFile, must } from './supabase.server'

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshot')
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'snapshot.json')
const FILES_DIR = path.join(SNAPSHOT_DIR, 'files')

// Insert order respects foreign keys.
const TABLES = [
  'suppliers',
  'products',
  'invoices',
  'product_aliases',
  'price_checks',
  'price_observations',
  'stock_uploads',
  'stock_items',
  'email_drafts',
] as const

async function selectAll(
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for (let from = 0; ; from += 1000) {
    const rows = must(
      await db()
        .from(table)
        .select('*')
        .order('id')
        .range(from, from + 999),
      `read ${table}`,
    ) as Array<Record<string, unknown>>
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

export async function wipe(): Promise<void> {
  must(await db().rpc('reset_demo_data'), 'reset data')
}

export async function saveSnapshot(): Promise<Record<string, number>> {
  const data: Record<string, Array<Record<string, unknown>>> = {}
  for (const t of TABLES) data[t] = await selectAll(t)
  await mkdir(FILES_DIR, { recursive: true })
  for (const inv of data.invoices) {
    const p = String(inv.file_path)
    const target = path.join(FILES_DIR, p)
    if (existsSync(target)) continue
    const blob = await downloadFile(INVOICE_BUCKET, p)
    await writeFile(target, Buffer.from(await blob.arrayBuffer()))
  }
  await writeFile(
    SNAPSHOT_FILE,
    JSON.stringify({ saved_at: new Date().toISOString(), data }, null, 1),
  )
  return Object.fromEntries(TABLES.map((t) => [t, data[t].length]))
}

export function hasSnapshot(): boolean {
  return existsSync(SNAPSHOT_FILE)
}

export async function snapshotInfo(): Promise<{
  saved_at: string
  counts: Record<string, number>
} | null> {
  if (!hasSnapshot()) return null
  const snap = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as {
    saved_at: string
    data: Partial<Record<string, Array<unknown>>>
  }
  return {
    saved_at: snap.saved_at,
    // Snapshots saved before live prices existed have no price_checks.
    counts: Object.fromEntries(
      TABLES.map((t) => [t, snap.data[t]?.length ?? 0]),
    ),
  }
}

export async function restoreSnapshot(): Promise<Record<string, number>> {
  if (!hasSnapshot())
    throw new Error('No snapshot saved yet. Run `npm run demo:snapshot` first.')
  const snap = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as {
    data: Partial<Record<string, Array<Record<string, unknown>>>>
  }
  await wipe()
  for (const t of TABLES) {
    const rows = snap.data[t] ?? []
    for (let i = 0; i < rows.length; i += 500) {
      must(
        await db()
          .from(t)
          .insert(rows.slice(i, i + 500)),
        `restore ${t}`,
      )
    }
  }
  // Make sure every invoice file exists in storage.
  for (const inv of snap.data.invoices ?? []) {
    const p = String(inv.file_path)
    const local = path.join(FILES_DIR, p)
    if (!existsSync(local)) continue
    await db()
      .storage.from(INVOICE_BUCKET)
      .upload(p, await readFile(local), {
        upsert: true,
        contentType: mediaTypeFor(p, ''),
      })
  }
  return Object.fromEntries(TABLES.map((t) => [t, snap.data[t]?.length ?? 0]))
}
