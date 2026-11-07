// The once-per-reply rule, against a small in-memory stand-in for the database that keeps the
// alerts_sent unique index (one claimed row per kind and key, failed rows don't count).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SupabaseServer from './supabase.server'

type Row = Record<string, unknown>
const tables: Record<string, Array<Row>> = {}

const ONCE_KINDS = ['better_quote', 'web_price', 'reply']

function claims(a: Row, b: Row): boolean {
  return (
    a.kind === b.kind &&
    a.key === b.key &&
    a.ok !== false &&
    b.ok !== false &&
    ONCE_KINDS.includes(String(a.kind))
  )
}

/** Just enough of the supabase-js query builder for alerts.server.ts. */
function query(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' = 'select'
  let payload: Row = {}
  let single = false
  const rows = () => (tables[table] ??= [])
  const run = () => {
    if (op === 'insert') {
      const row = { id: crypto.randomUUID(), ...payload }
      if (table === 'alerts_sent' && rows().some((r) => claims(r, row)))
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      rows().push(row)
      return { data: single ? row : [row], error: null }
    }
    const hit = rows().filter((r) => filters.every((f) => f(r)))
    if (op === 'update') for (const r of hit) Object.assign(r, payload)
    return { data: single ? (hit[0] ?? null) : hit, error: null }
  }
  const q = {
    select: () => q,
    insert: (row: Row) => ((op = 'insert'), (payload = row), q),
    update: (row: Row) => ((op = 'update'), (payload = row), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), q),
    order: () => q,
    limit: () => q,
    single: () => ((single = true), q),
    then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(ok, fail),
  }
  return q
}

vi.mock('./supabase.server', async (orig) => ({
  ...(await orig<typeof SupabaseServer>()),
  db: () => ({ from: query }),
}))
vi.mock('./queries.server', () => ({
  allOpportunities: vi.fn(),
  invoicePeriod: vi.fn(),
  observationsByProduct: vi.fn(),
}))

const { notifyBetterQuote, notifyReply } = await import('./alerts.server')

const REPLY = '22222222-2222-4222-8222-222222222222'
const DRAFT = '33333333-3333-4333-8333-333333333333'
const telegram = vi.fn()

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.inbound_emails = [
    {
      id: REPLY,
      from_email: 'sales@leevalley.ie',
      from_name: null,
      subject: 'RE: Our prices with you',
      body_text: 'Yes thats perfect\n\nSent from Outlook for Mac',
      status: 'processed',
      error: null,
      draft_id: DRAFT,
      attachments: [],
      invoices_read: 0,
      suppliers: { name: 'Lee Valley Wholesale' },
    },
  ]
  tables.email_drafts = [
    { id: DRAFT, kind: 'match', items: [{ product_name: 'Salted butter' }] },
  ]
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'token')
  vi.stubEnv('TELEGRAM_CHAT_ID', '42')
  vi.stubEnv('APP_URL', 'https://shelfie.example')
  telegram.mockReset()
  telegram.mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', telegram)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function sentTexts(): Array<string> {
  return telegram.mock.calls.map(
    (c) =>
      (JSON.parse(String((c[1] as RequestInit).body)) as { text: string }).text,
  )
}

describe('notifyReply', () => {
  it('sends one message for a reply, read from the database', async () => {
    const res = await notifyReply(REPLY)
    expect(res).toMatchObject({ ok: true, duplicate: false })
    expect(sentTexts()).toEqual([
      [
        'Lee Valley Wholesale replied to your Salted butter match request',
        '"Yes thats perfect"',
        'No prices or invoices in it.',
        `Open: https://shelfie.example/replies/${REPLY}`,
      ].join('\n'),
    ])
    expect(tables.alerts_sent).toMatchObject([
      { kind: 'reply', key: REPLY, ok: true },
    ])
  })

  it('never sends the same reply twice', async () => {
    await notifyReply(REPLY)
    const again = await notifyReply(REPLY)
    expect(again).toMatchObject({ ok: true, duplicate: true })
    expect(telegram).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failed send, then stops', async () => {
    telegram.mockResolvedValueOnce(
      Response.json({ ok: false, description: 'Bad' }, { status: 400 }),
    )
    expect(await notifyReply(REPLY)).toMatchObject({ ok: false })
    expect(await notifyReply(REPLY)).toMatchObject({ ok: true })
    expect(await notifyReply(REPLY)).toMatchObject({ duplicate: true })
    expect(telegram).toHaveBeenCalledTimes(2)
  })

  it('waits while the reply is still being read', async () => {
    tables.inbound_emails[0].status = 'received'
    expect(await notifyReply(REPLY)).toBeNull()
    expect(telegram).not.toHaveBeenCalled()
    expect(tables).not.toHaveProperty('alerts_sent')
  })

  it('sends for an unmatched reply too', async () => {
    Object.assign(tables.inbound_emails[0], {
      status: 'unmatched',
      draft_id: null,
      suppliers: null,
      from_name: 'Sean',
    })
    await notifyReply(REPLY)
    expect(sentTexts()[0]).toContain(
      "We couldn't tell which supplier this is from",
    )
    expect(sentTexts()[0]).toContain('Sean (sales@leevalley.ie) replied to')
  })
})

describe('notifyBetterQuote', () => {
  const q = {
    supplier_name: 'Munster Fresh Foods',
    product_name: 'Whole milk',
    your_ppu: 0.0021,
    quote_ppu: 0.00178,
    base_unit: 'ml' as const,
    annual_saving: 120,
    product_id: '11111111-1111-4111-8111-111111111111',
  }

  it('records the deal once and sends nothing: the reply message carries it', async () => {
    await notifyBetterQuote(q)
    await notifyBetterQuote(q)
    expect(telegram).not.toHaveBeenCalled()
    expect(tables.alerts_sent).toHaveLength(1)
    expect(tables.alerts_sent[0]).toMatchObject({ kind: 'better_quote' })
  })
})
