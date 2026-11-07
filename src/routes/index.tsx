import { Link, createFileRoute, useLoaderData } from '@tanstack/react-router'
import { useState } from 'react'
import {
  PriceSparkline,
  SavingBar,
  SupplierSplit,
  WeeklySpendChart,
} from '#/components/Charts'
import { Icon, Spinner } from '#/components/Icon'
import { postJSON } from '#/lib/api'
import { euro, pct, shortDate } from '#/lib/format'
import { standardQuantity } from '#/lib/units'
import type { BaseUnit } from '#/lib/units'
import { getHome } from '#/server/fns'

export const Route = createFileRoute('/')({
  loader: () => getHome(),
  component: Home,
})

function Home() {
  const d = Route.useLoaderData()
  const business = useLoaderData({ from: '__root__' })
  const empty = d.invoices === 0
  const weeks = d.spend.weeks
  const supplierNames = d.spend.suppliers.map((s) => s.name)
  const spendTotal = d.spend.suppliers.reduce((s, x) => s + x.total, 0)

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand to-brand-dark px-5 py-7 text-white md:px-8 md:py-10">
          <p className="text-sm font-medium text-white/80">
            {business.name}, {business.town}
          </p>
          {empty ? (
            <>
              <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">
                Are you overpaying your suppliers?
              </h1>
              <p className="mt-3 max-w-xl text-white/85">
                Add a few supplier invoices and Shelfie will show you what you
                could save, product by product.
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-2 text-lg font-medium text-white/90">
                You could save
              </h1>
              <p className="text-5xl font-bold tracking-tight md:text-6xl">
                {euro(d.total_annual_saving, { cents: false })}
                <span className="ml-2 text-xl font-semibold text-white/80">
                  a year
                </span>
              </p>
              <p className="mt-3 text-sm text-white/80">
                From {d.invoices} invoices and {d.prices} prices across{' '}
                {d.suppliers} suppliers.
              </p>
            </>
          )}
        </div>
        <div className="grid grid-cols-3 divide-x divide-line">
          <ActionLink to="/scan" icon="scan" label="Scan an item" />
          <ActionLink to="/audit" icon="list" label="Check stock list" />
          <ActionLink to="/invoices" icon="upload" label="Add invoices" />
        </div>
      </section>

      {d.needs_review > 0 && (
        <Link
          to="/invoices"
          hash="review"
          className="card flex items-center gap-3 border-warn/30 bg-warn-soft px-4 py-3 text-sm"
        >
          <Icon name="alert" className="h-5 w-5 shrink-0 text-warn" />
          <span className="flex-1">
            <b>
              {d.needs_review} invoice{' '}
              {d.needs_review === 1 ? 'line needs' : 'lines need'}
            </b>{' '}
            a quick check before we trust {d.needs_review === 1 ? 'it' : 'them'}
            .
          </span>
          <Icon name="arrowRight" className="h-4 w-4 text-muted" />
        </Link>
      )}

      {weeks.length > 0 && (
        <section className="card p-4 md:p-6">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <h2 className="text-lg font-bold">Weekly spend</h2>
              <p className="text-sm text-muted">
                Invoice totals ex VAT, by supplier. Hover a week for the split.
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold tracking-tight">
                {euro(spendTotal / weeks.length, { cents: false })}
              </p>
              <p className="text-xs text-muted">average a week</p>
            </div>
          </div>
          <div className="mt-5">
            <WeeklySpendChart weeks={weeks} suppliers={supplierNames} />
          </div>
          <div className="mt-5 border-t border-line pt-4">
            <SupplierSplit suppliers={d.spend.suppliers} />
          </div>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted hover:text-ink">
              Show as a table
            </summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 font-medium">Week of</th>
                  {supplierNames.map((s) => (
                    <th key={s} className="py-1 text-right font-medium">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="num divide-y divide-line">
                {weeks.map((w) => (
                  <tr key={w.week}>
                    <td className="py-1">{shortDate(w.week)}</td>
                    {supplierNames.map((s) => (
                      <td key={s} className="py-1 text-right">
                        {w.by_supplier[s]
                          ? euro(w.by_supplier[s], { cents: false })
                          : '-'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        {d.top.length > 0 && (
          <section className="min-w-0 lg:col-span-3">
            <h2 className="mb-3 text-lg font-bold">Biggest savings</h2>
            <ul className="card divide-y divide-line">
              {d.top.map((o) => (
                <li key={o.product_id}>
                  <Link
                    to="/item/$productId"
                    params={{ productId: o.product_id }}
                    className="block px-4 py-3.5 hover:bg-soft/60"
                  >
                    <p className="truncate font-semibold">{o.name}</p>
                    <p className="mb-2 truncate text-sm text-muted">
                      {pct(o.pct_cheaper)} cheaper at {o.cheapest_supplier} than{' '}
                      {o.current_supplier}
                    </p>
                    <SavingBar
                      value={o.annual_saving ?? 0}
                      max={d.top[0].annual_saving ?? 0}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {d.creeps.length > 0 && (
          <section className="min-w-0 lg:col-span-2">
            <h2 className="mb-3 text-lg font-bold">Prices creeping up</h2>
            <ul className="grid gap-3">
              {d.creeps.map((o) => (
                <li key={o.product_id}>
                  <Link
                    to="/item/$productId"
                    params={{ productId: o.product_id }}
                    className="card block px-4 py-3.5 hover:bg-soft/60"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <p className="min-w-0 truncate font-semibold">{o.name}</p>
                      <span className="chip shrink-0 bg-rust-soft text-rust">
                        <Icon name="arrowUp" className="h-3 w-3" />
                        {pct(o.creep_pct)}
                      </span>
                    </div>
                    <PriceSparkline
                      points={o.history}
                      unit={unitSuffix(o.base_unit)}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {!empty && <WeeklyAlertButton />}
    </div>
  )
}

/**
 * Sends this week's Telegram summary now. Kept out of the way on purpose: a real product
 * would send it on a schedule, this is for showing it on stage.
 */
function WeeklyAlertButton() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  )

  async function send() {
    setBusy(true)
    setResult(null)
    try {
      await postJSON('/api/alerts/send', { kind: 'weekly' })
      setResult({ ok: true, text: 'Sent to Telegram.' })
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof Error ? e.message : 'Not sent.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-1 pt-2 pb-4 text-xs">
      <button
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-muted/60 hover:text-muted disabled:opacity-60"
        disabled={busy}
        onClick={() => void send()}
      >
        {busy && <Spinner className="h-3 w-3" />}
        Send this week's alert
      </button>
      {result && (
        <p
          role="status"
          className={`max-w-md text-center ${result.ok ? 'text-brand-dark' : 'text-rust'}`}
        >
          {result.text}
        </p>
      )}
    </div>
  )
}

function ActionLink({
  to,
  icon,
  label,
}: {
  to: '/scan' | '/audit' | '/invoices'
  icon: 'scan' | 'list' | 'upload'
  label: string
}) {
  return (
    <Link
      to={to}
      className="flex flex-col items-center gap-1.5 px-2 py-4 text-center text-sm font-semibold hover:bg-soft"
    >
      <Icon name={icon} className="h-6 w-6 text-brand" />
      {label}
    </Link>
  )
}

/** "/L", "/kg" or " each", for prices per standard unit. */
function unitSuffix(unit: BaseUnit) {
  const { short } = standardQuantity(unit)
  return short ? `/${short}` : ' each'
}
