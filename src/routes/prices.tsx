import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '#/components/Icon'
import { pool, postJSON } from '#/lib/api'
import { dateTime, pct, perStandardShort, timeAgo } from '#/lib/format'
import { getLivePrices } from '#/server/fns'

export const Route = createFileRoute('/prices')({
  loader: () => getLivePrices(),
  head: () => ({ meta: [{ title: 'Live prices - Shelfie' }] }),
  component: LivePrices,
})

/** Searches at once. Each takes up to a minute. */
const PARALLEL = 3
const WEEK_MS = 7 * 86_400_000

type Run =
  | { status: 'queued' | 'running' }
  | { status: 'done'; found: number }
  | { status: 'failed'; error: string }

type Row = ReturnType<typeof Route.useLoaderData>[number]

function LivePrices() {
  const rows = Route.useLoaderData()
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [runs, setRuns] = useState<Record<string, Run>>({})

  const active = Object.values(runs).filter(
    (r) => r.status === 'queued' || r.status === 'running',
  ).length
  const allSelected = rows.length > 0 && selected.size === rows.length
  const setRun = (id: string, run: Run) =>
    setRuns((prev) => ({ ...prev, [id]: run }))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectStale() {
    setSelected(
      new Set(
        rows
          .filter(
            (r) =>
              !r.last_check ||
              Date.now() - Date.parse(r.last_check.started_at) > WEEK_MS,
          )
          .map((r) => r.product_id),
      ),
    )
  }

  async function checkSelected() {
    const ids = rows.map((r) => r.product_id).filter((id) => selected.has(id))
    setSelected(new Set())
    for (const id of ids) setRun(id, { status: 'queued' })
    await pool(ids, PARALLEL, async (id) => {
      setRun(id, { status: 'running' })
      try {
        const { check } = await postJSON<{ check: { offers_found: number } }>(
          '/api/prices/check',
          { product_id: id },
        )
        setRun(id, { status: 'done', found: check.offers_found })
      } catch (err) {
        setRun(id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Refresh as each product lands, so the new prices and times show straight away.
      void router.invalidate()
    })
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Live prices</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Search the web now for what other sellers in Ireland charge. Every
          price is saved with the time it was found and counts towards your
          savings for 14 days. Each product takes up to a minute.
        </p>
      </div>

      <div className="card sticky top-16 z-10 flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 md:top-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand"
            checked={allSelected}
            onChange={() =>
              setSelected(
                allSelected
                  ? new Set()
                  : new Set(rows.map((r) => r.product_id)),
              )
            }
          />
          Select all
        </label>
        <button className="btn-ghost px-2 py-1" onClick={selectStale}>
          Not checked this week
        </button>
        <span className="flex-1 text-sm text-muted">
          {active > 0
            ? `Searching ${active} product${active === 1 ? '' : 's'}…`
            : `${selected.size} selected`}
        </span>
        <button
          className="btn-primary"
          disabled={selected.size === 0}
          onClick={() => void checkSelected()}
        >
          <Icon name="search" className="h-4 w-4" />
          Check {selected.size > 0 ? selected.size : ''} live
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="card px-5 py-10 text-center text-muted">
          No products yet. Add some invoices first.
        </div>
      ) : (
        <ul className="card divide-y divide-line">
          {rows.map((r) => (
            <PriceRow
              key={r.product_id}
              row={r}
              run={runs[r.product_id]}
              checked={selected.has(r.product_id)}
              onToggle={() => toggle(r.product_id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function PriceRow({
  row,
  run,
  checked,
  onToggle,
}: {
  row: Row
  run: Run | undefined
  checked: boolean
  onToggle: () => void
}) {
  const busy = run?.status === 'queued' || run?.status === 'running'
  const cheaper = row.pct_vs_you != null && row.pct_vs_you < 0
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <input
        type="checkbox"
        aria-label={`Select ${row.name}`}
        className="mt-1 h-4 w-4 shrink-0 accent-brand"
        checked={checked}
        disabled={busy}
        onChange={onToggle}
      />
      <div className="grid min-w-0 flex-1 gap-x-6 gap-y-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center">
        <div className="min-w-0">
          <Link
            to="/item/$productId"
            params={{ productId: row.product_id }}
            className="block truncate font-semibold hover:underline"
          >
            {row.name}
          </Link>
          <p className="truncate text-xs text-muted">
            {row.category ?? 'Product'}
          </p>
        </div>

        <div className="min-w-0 text-sm">
          <p className="text-xs text-muted">You pay</p>
          {row.current ? (
            <p className="truncate">
              <b className="tabular-nums">
                {perStandardShort(row.current.ppu, row.base_unit)}
              </b>{' '}
              <span className="text-muted">at {row.current.supplier_name}</span>
            </p>
          ) : (
            <p className="text-muted">No invoice yet</p>
          )}
        </div>

        <div className="min-w-0 text-sm">
          <p className="text-xs text-muted">Cheapest online</p>
          {row.best_online ? (
            <p className="flex min-w-0 items-center gap-2">
              <b className="tabular-nums">
                {perStandardShort(row.best_online.ppu, row.base_unit)}
              </b>
              {row.best_online.url ? (
                <a
                  href={row.best_online.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-muted underline decoration-line underline-offset-2 hover:text-ink"
                >
                  {row.best_online.supplier_name}
                </a>
              ) : (
                <span className="truncate text-muted">
                  {row.best_online.supplier_name}
                </span>
              )}
              {row.pct_vs_you != null && (
                <span
                  className={`chip shrink-0 ${cheaper ? 'bg-good-soft text-good' : ''}`}
                >
                  {cheaper
                    ? `${pct(-row.pct_vs_you)} less`
                    : `${pct(row.pct_vs_you)} more`}
                </span>
              )}
            </p>
          ) : (
            <p className="text-muted">
              {row.last_check?.status === 'done' ? 'None found' : '-'}
            </p>
          )}
        </div>

        <Status row={row} run={run} />
      </div>
    </li>
  )
}

function Status({ row, run }: { row: Row; run: Run | undefined }) {
  const last = row.last_check
  let chip: ReactNode
  if (run?.status === 'queued') chip = <span className="chip">Queued</span>
  else if (run?.status === 'running')
    chip = (
      <span className="chip bg-brand-soft text-brand">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        Searching
      </span>
    )
  else if (run?.status === 'failed')
    chip = (
      <span className="chip bg-rust-soft text-rust" title={run.error}>
        Failed
      </span>
    )
  else if (last?.status === 'failed')
    chip = (
      <span className="chip bg-rust-soft text-rust" title={last.error ?? ''}>
        Last check failed
      </span>
    )
  else if (last?.status === 'done')
    chip = (
      <span className="chip">
        {last.offers_found} price{last.offers_found === 1 ? '' : 's'}
      </span>
    )

  return (
    <div className="flex items-center gap-2 text-xs text-muted md:flex-col md:items-end md:gap-1">
      {chip}
      <span title={last ? dateTime(last.started_at) : undefined}>
        {last ? `Checked ${timeAgo(last.started_at)}` : 'Never checked'}
      </span>
    </div>
  )
}
