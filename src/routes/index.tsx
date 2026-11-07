import { Link, createFileRoute } from '@tanstack/react-router'
import { Icon } from '#/components/Icon'
import { euro, pct } from '#/lib/format'
import { getHome } from '#/server/fns'

export const Route = createFileRoute('/')({
  loader: () => getHome(),
  component: Home,
})

function Home() {
  const d = Route.useLoaderData()
  const empty = d.invoices === 0

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand to-brand-dark px-5 py-7 text-white md:px-8 md:py-10">
          <p className="text-sm font-medium text-white/80">
            The Corner Café, Cork
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

      {d.top.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold">Biggest savings</h2>
          <ul className="card divide-y divide-line">
            {d.top.map((o) => (
              <li key={o.product_id}>
                <Link
                  to="/item/$productId"
                  params={{ productId: o.product_id }}
                  className="flex items-center gap-3 px-4 py-3.5 hover:bg-soft/60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{o.name}</p>
                    <p className="truncate text-sm text-muted">
                      {pct(o.pct_cheaper)} cheaper at {o.cheapest_supplier} than{' '}
                      {o.current_supplier}
                    </p>
                  </div>
                  <span className="text-right">
                    <span className="block font-bold text-brand">
                      {euro(o.annual_saving, { cents: false })}
                    </span>
                    <span className="block text-xs text-muted">a year</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.creeps.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold">Prices creeping up</h2>
          <ul className="grid gap-3 md:grid-cols-3">
            {d.creeps.map((o) => (
              <li key={o.product_id}>
                <Link
                  to="/item/$productId"
                  params={{ productId: o.product_id }}
                  className="card flex items-center gap-3 px-4 py-3.5 hover:bg-soft/60"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-rust-soft text-rust">
                    <Icon name="arrowUp" className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{o.name}</p>
                    <p className="text-sm text-muted">
                      Up {pct(o.creep_pct)} at {o.current_supplier}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
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
