import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { useState } from 'react'
import { EmailModal } from '#/components/EmailModal'
import type { EmailGroup } from '#/components/EmailModal'
import { Icon } from '#/components/Icon'
import {
  euro,
  monthName,
  pack,
  pct,
  perStandard,
  perStandardShort,
  shortDate,
} from '#/lib/format'
import { baseUnitsPerPack, isRawUnit, standardQuantity } from '#/lib/units'
import type { BaseUnit } from '#/lib/units'
import { getProduct } from '#/server/fns'

export const Route = createFileRoute('/item/$productId')({
  loader: async ({ params }) => {
    const d = await getProduct({ data: { id: params.productId } })
    if (!d) throw notFound()
    return d
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.product.canonical_name ?? 'Item'} - Shelfie` },
    ],
  }),
  component: ItemPage,
  notFoundComponent: () => (
    <div className="card px-5 py-10 text-center">
      <p className="font-semibold">We don't know this product yet.</p>
      <Link to="/scan" className="btn-primary mt-4">
        Scan again
      </Link>
    </div>
  ),
})

function unitsIn(p: {
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
}) {
  return isRawUnit(p.pack_unit)
    ? baseUnitsPerPack({
        pack_size: p.pack_size,
        pack_unit: p.pack_unit,
        units_per_case: p.units_per_case,
      })
    : null
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "€21.30 ÷ 12L = €1.78 per litre", in the units an owner thinks in. */
function maths(packPrice: number, baseAmount: number, unit: BaseUnit): string {
  const std = standardQuantity(unit)
  const qty = baseAmount / std.amount
  const q = Number.isInteger(qty)
    ? qty.toLocaleString('en-IE')
    : qty.toLocaleString('en-IE', { maximumFractionDigits: 3 })
  return `${euro(packPrice, { cents: true })} ÷ ${q}${std.short} = ${perStandard(packPrice / baseAmount, unit)}`
}

function ItemPage() {
  const { product, insight, names, supplier } = Route.useLoaderData()
  const [emailOpen, setEmailOpen] = useState(false)
  const unit = product.base_unit
  const cur = insight.current
  const best = insight.cheapest
  const curUnits = cur ? unitsIn(cur) : null
  // The cheaper price expressed in the pack the owner already buys, e.g. "€3.55 per 2 l".
  const bestInMyPack = best && curUnits ? best.ppu * curUnits.amount : null
  const saving = insight.annual_saving ?? 0
  const canAsk = Boolean(
    cur &&
    best &&
    bestInMyPack != null &&
    supplier &&
    (insight.per_unit_saving ?? 0) > 0,
  )

  const emailGroups: Array<EmailGroup> =
    canAsk && cur && supplier && bestInMyPack != null
      ? [
          {
            supplier_id: supplier.id,
            supplier_name: supplier.name,
            items: [
              {
                product_name: product.canonical_name,
                pack_label: pack(cur),
                your_price: cur.pack_price,
                best_price: Math.round(bestInMyPack * 100) / 100,
                weekly_quantity:
                  insight.annual_base_units != null && curUnits
                    ? insight.annual_base_units / 52 / curUnits.amount
                    : null,
              },
            ],
          },
        ]
      : []

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <p className="label">{product.category ?? 'Product'}</p>
        <h1 className="text-2xl font-bold tracking-tight">
          {product.canonical_name}
        </h1>
      </div>

      {/* 1. Headline */}
      <section
        className={`card px-5 py-6 ${saving > 0 ? 'border-brand/30 bg-brand-soft' : ''}`}
      >
        {!cur ? (
          <p className="text-xl font-semibold">
            No invoices for this yet. Add one to see what you pay.
          </p>
        ) : saving > 0 ? (
          <>
            <p className="text-lg font-medium text-brand-dark">
              You could save
            </p>
            <p className="text-5xl font-bold tracking-tight text-brand">
              {euro(saving, { cents: false })}
              <span className="ml-2 text-xl font-semibold text-brand-dark/80">
                a year on this
              </span>
            </p>
          </>
        ) : best == null || (insight.per_unit_saving ?? 0) <= 0 ? (
          <p className="flex items-center gap-2 text-2xl font-bold text-brand">
            <Icon name="check" className="h-7 w-7" /> You're already on the best
            price
          </p>
        ) : (
          <p className="text-xl font-semibold">
            {pct(insight.pct_cheaper)} cheaper elsewhere. Add more invoices to
            estimate the yearly saving.
          </p>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* 2. You pay */}
        {cur && (
          <section className="card px-5 py-4">
            <p className="label">You pay</p>
            <p className="mt-1 text-3xl font-bold">
              {euro(cur.pack_price, { cents: true })}
            </p>
            <p className="text-sm text-muted">
              per {pack(cur)} at <b className="text-ink">{cur.supplier_name}</b>
            </p>
            <p className="mt-2 text-sm">{perStandard(cur.ppu, unit)}</p>
          </section>
        )}
        {/* 3. Cheapest option */}
        {best && (insight.per_unit_saving ?? 0) > 0 && (
          <section className="card border-brand/30 px-5 py-4">
            <p className="label">Cheapest option</p>
            <p className="mt-1 text-3xl font-bold text-brand">
              {bestInMyPack != null
                ? euro(bestInMyPack, { cents: true })
                : euro(best.pack_price, { cents: true })}
            </p>
            <p className="text-sm text-muted">
              {bestInMyPack != null && cur
                ? `per ${pack(cur)} equivalent`
                : `per ${pack(best)}`}{' '}
              at <b className="text-ink">{best.supplier_name}</b>
            </p>
            <p className="mt-2 text-sm">
              {perStandard(best.ppu, unit)} ·{' '}
              <b className="text-brand">{pct(insight.pct_cheaper)} less</b>
            </p>
            <p className="mt-1 text-xs text-muted">
              Sold as {pack(best)} for {euro(best.pack_price, { cents: true })}
            </p>
          </section>
        )}
      </div>

      {/* 5. Price creep */}
      {insight.creep && (
        <section className="card flex items-center gap-3 border-rust/30 bg-rust-soft px-5 py-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-card text-rust">
            <Icon name="arrowUp" />
          </span>
          <p>
            <b>
              Up {pct(insight.creep.pct)} since{' '}
              {monthName(insight.creep.from_date)}
            </b>{' '}
            at {insight.creep.supplier_name}: from{' '}
            {perStandard(insight.creep.from_ppu, unit)} to{' '}
            {perStandard(insight.creep.to_ppu, unit)}.
          </p>
        </section>
      )}

      {/* 7. Action */}
      {canAsk && cur && bestInMyPack != null && (
        <button
          className="btn-primary w-full py-4 text-center text-base whitespace-normal"
          onClick={() => setEmailOpen(true)}
        >
          <Icon name="mail" className="h-5 w-5 shrink-0" /> Ask{' '}
          {cur.supplier_name} to match {euro(bestInMyPack, { cents: true })}
        </button>
      )}

      {/* 4. All suppliers */}
      {insight.suppliers.length > 0 && (
        <section className="card overflow-hidden">
          <h2 className="px-5 pt-4 pb-2 font-bold">All suppliers</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-2 font-semibold">Supplier</th>
                <th className="px-2 py-2 text-right font-semibold">
                  Pack price
                </th>
                <th className="px-5 py-2 text-right font-semibold">
                  Unit price
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {insight.suppliers.map((s, i) => (
                <tr
                  key={s.supplier_id}
                  className={
                    s.supplier_id === cur?.supplier_id ? 'bg-soft/60' : ''
                  }
                >
                  <td className="px-5 py-2.5">
                    <p className="font-medium">{s.supplier_name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      {s.source === 'price_list' ? 'Price list' : 'Invoice'} ·{' '}
                      {shortDate(s.observed_on)}
                      {i === 0 && (
                        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                          cheapest
                        </span>
                      )}
                      {s.supplier_id === cur?.supplier_id && (
                        <span className="rounded-full bg-soft px-2 py-0.5 text-[11px] font-semibold text-ink">
                          you buy here
                        </span>
                      )}
                    </p>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    {euro(s.pack_price, { cents: true })}
                    <p className="text-xs text-muted">{pack(s)}</p>
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold whitespace-nowrap">
                    {perStandardShort(s.ppu, unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* 6. How we matched this */}
      <details className="card group overflow-hidden" open>
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 font-bold">
          How we matched this
          <Icon
            name="chevron"
            className="h-4 w-4 text-muted transition-transform group-open:rotate-180"
          />
        </summary>
        <p className="px-5 text-sm text-muted">
          {plural(new Set(names.map((n) => n.supplier_name)).size, 'supplier')},{' '}
          {plural(new Set(names.map((n) => n.raw_description)).size, 'name')},
          one product. Compared{' '}
          {standardQuantity(unit).label === 'each'
            ? 'per item'
            : standardQuantity(unit).label}
          .
        </p>
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {names.map((n) => {
            const u = unitsIn(n)
            return (
              <li
                key={`${n.supplier_name}|${n.raw_description}`}
                className="px-5 py-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <code className="text-[13px] font-semibold">
                    {n.raw_description}
                  </code>
                  <span className="text-xs text-muted">{n.supplier_name}</span>
                </div>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  {u
                    ? `${(n.units_per_case ?? 1) > 1 ? `${pack(n)} · ` : ''}${maths(n.pack_price, u.amount, unit)}`
                    : 'Pack size unknown: not compared'}
                </p>
              </li>
            )
          })}
        </ul>
      </details>

      {emailOpen && (
        <EmailModal groups={emailGroups} onClose={() => setEmailOpen(false)} />
      )}
    </div>
  )
}
