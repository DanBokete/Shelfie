import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import { EmailModal } from '#/components/EmailModal'
import type { EmailRequest } from '#/components/EmailModal'
import { Icon } from '#/components/Icon'
import { postJSON } from '#/lib/api'
import {
  dateTime,
  euro,
  monthName,
  pack,
  pct,
  perStandard,
  perStandardShort,
  shortDate,
  timeAgo,
} from '#/lib/format'
import { baseUnitsPerPack, isRawUnit, standardQuantity } from '#/lib/units'
import type { BaseUnit } from '#/lib/units'
import { targetBuyPrice } from '#/lib/ask'
import {
  getProduct,
  getProductPriceChecks,
  saveSellingPrice,
} from '#/server/fns'

export const Route = createFileRoute('/item/$productId')({
  loader: async ({ params }) => {
    const [d, live] = await Promise.all([
      getProduct({ data: { id: params.productId } }),
      getProductPriceChecks({ data: { id: params.productId } }),
    ])
    if (!d) throw notFound()
    return { ...d, live }
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
  const { product, insight, names, supplier, live } = Route.useLoaderData()
  const [email, setEmail] = useState<Array<EmailRequest> | null>(null)
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

  const matchRequest: Array<EmailRequest> =
    canAsk && cur && supplier && bestInMyPack != null
      ? [
          {
            kind: 'match',
            supplier_id: supplier.id,
            supplier_name: supplier.name,
            items: [
              {
                product_id: product.id,
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

      {/* 4. What you sell it for: lets the "ask to match" email aim for a profit-based price */}
      {cur && curUnits && (
        <SellingPrice
          productId={product.id}
          packLabel={pack(cur)}
          saved={
            product.selling_price_per_base_unit == null
              ? null
              : Math.round(
                  Number(product.selling_price_per_base_unit) *
                    curUnits.amount *
                    100,
                ) / 100
          }
          buyPrice={cur.pack_price}
          bestPrice={bestInMyPack}
        />
      )}

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
          onClick={() => setEmail(matchRequest)}
        >
          <Icon name="mail" className="h-5 w-5 shrink-0" /> Ask{' '}
          {cur.supplier_name} to match {euro(bestInMyPack, { cents: true })}
        </button>
      )}

      <OnlinePrices
        productId={product.id}
        productName={product.canonical_name}
        live={live}
        unit={unit}
        yourPpu={cur?.ppu ?? null}
        onQuote={(r) => setEmail([r])}
      />

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
                      {s.source === 'web' && s.source_url ? (
                        <a
                          href={s.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-ink"
                        >
                          Online
                        </a>
                      ) : (
                        SOURCE_LABEL[s.source]
                      )}{' '}
                      · {shortDate(s.observed_on)}
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

      {email && <EmailModal requests={email} onClose={() => setEmail(null)} />}
    </div>
  )
}

/** Owner enters what a pack of this sells for (ex VAT); the match email then asks for the buy price that keeps their profit. */
function SellingPrice({
  productId,
  packLabel,
  saved,
  buyPrice,
  bestPrice,
}: {
  productId: string
  packLabel: string
  saved: number | null
  buyPrice: number
  bestPrice: number | null
}) {
  const router = useRouter()
  const [value, setValue] = useState(saved == null ? '' : String(saved))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const entered = Number(value)
  const valid = value.trim() !== '' && Number.isFinite(entered) && entered > 0
  const preview =
    valid && bestPrice != null
      ? targetBuyPrice({
          your_price: buyPrice,
          best_price: Math.round(bestPrice * 100) / 100,
          selling_price: entered,
        })
      : null

  async function save(price: number | null) {
    setBusy(true)
    setErr(null)
    try {
      await saveSellingPrice({
        data: { product_id: productId, pack_price: price },
      })
      if (price == null) setValue('')
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card px-5 py-4">
      <p className="label">You sell it for</p>
      <p className="mt-1 text-sm text-muted">
        What one {packLabel} sells for in total, ex VAT. Used to work out the
        buy price you need to sell at the competitive price and keep your
        profit. Never shown to suppliers.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-semibold">€</span>
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Selling price per ${packLabel}, ex VAT`}
          className="w-32 rounded-lg border border-line bg-card px-3 py-2"
        />
        <button
          className="btn-secondary px-3 py-2"
          disabled={!valid || busy}
          onClick={() => void save(entered)}
        >
          {busy ? 'Saving...' : 'Save'}
        </button>
        {saved != null && (
          <button
            className="btn-ghost px-2 py-2"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Clear
          </button>
        )}
      </div>
      {preview && (
        <p className="mt-2 text-sm">
          The email will ask for <b>{euro(preview.target, { cents: true })}</b>{' '}
          per {packLabel}, <b>{preview.percent}% lower</b>
          {preview.basis === 'found_price' &&
            ' (your selling price did not give a usable target, so this is the better price found)'}
          .
        </p>
      )}
      {err && <p className="mt-2 text-sm text-rust">{err}</p>}
    </section>
  )
}

const SOURCE_LABEL = {
  invoice: 'Invoice',
  price_list: 'Price list',
  web: 'Online',
  quote: 'Quote',
} as const

type Live = Awaited<ReturnType<typeof getProductPriceChecks>>

/** Competitor prices from the latest web search, with a button to search again now. */
function OnlinePrices({
  productId,
  productName,
  live,
  unit,
  yourPpu,
  onQuote,
}: {
  productId: string
  productName: string
  live: Live
  unit: BaseUnit
  yourPpu: number | null
  onQuote: (r: EmailRequest) => void
}) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const last = live.checks.at(0) ?? null
  const lastDone = live.checks.find((c) => c.status === 'done') ?? null

  async function check() {
    setRunning(true)
    setError(null)
    try {
      await postJSON('/api/prices/check', { product_id: productId })
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await router.invalidate()
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="font-bold">Online prices</h2>
          <p
            className="text-xs text-muted"
            title={last ? dateTime(last.started_at) : undefined}
          >
            {last
              ? `Last checked ${timeAgo(last.started_at)} · ${dateTime(last.started_at)}`
              : 'Not checked yet'}
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={running}
          onClick={() => void check()}
        >
          {running ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            <Icon name="search" className="h-4 w-4" />
          )}
          {running ? 'Searching…' : 'Check now'}
        </button>
      </div>

      {running && (
        <p className="border-t border-line bg-brand-soft px-5 py-3 text-sm text-brand-dark">
          Searching the web for what other sellers in Ireland charge. This can
          take up to a minute.
        </p>
      )}
      {(error ?? (last?.status === 'failed' ? last.error : null)) && (
        <p className="border-t border-line bg-rust-soft px-5 py-3 text-sm text-rust">
          The last check failed: {error ?? last?.error}
        </p>
      )}
      {lastDone?.summary && (
        <p className="border-t border-line px-5 py-3 text-sm">
          {lastDone.summary}
        </p>
      )}

      {live.offers.length > 0 ? (
        <ul className="divide-y divide-line border-t border-line">
          {live.offers.map((o) => {
            const diff = yourPpu ? (o.ppu - yourPpu) / yourPpu : null
            const equivalent = o.review_reasons.some((r) =>
              r.startsWith('Match: close equivalent'),
            )
            const vatUnknown = o.review_reasons.some((r) =>
              r.startsWith('Web: shelf price incl. VAT'),
            )
            // The seller's page can come back as an old cached copy.
            const stale =
              Date.now() - Date.parse(o.observed_at) >
              live.max_age_days * 86_400_000
            return (
              <li
                key={o.id}
                className="flex items-start justify-between gap-4 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{o.seller}</p>
                  {o.url ? (
                    <a
                      href={o.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm text-muted underline decoration-line underline-offset-2 hover:text-ink"
                    >
                      {o.title}
                    </a>
                  ) : (
                    <p className="truncate text-sm text-muted">{o.title}</p>
                  )}
                  <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted">
                    <span>
                      {euro(o.pack_price, { cents: true })} per {pack(o)} · read{' '}
                      {dateTime(o.observed_at)}
                    </span>
                    {equivalent && (
                      <span className="chip">Similar product</span>
                    )}
                    {vatUnknown && <span className="chip">Incl. VAT</span>}
                    {stale && (
                      <span className="chip bg-warn-soft text-warn">
                        Old copy of the page, not counted
                      </span>
                    )}
                  </p>
                  {(diff == null || diff < 0) && (
                    <button
                      className="btn-secondary mt-2 px-3 py-1.5"
                      onClick={() =>
                        onQuote({
                          kind: 'quote',
                          offer_id: o.id,
                          seller_name: o.seller,
                          product_name: productName,
                          price_seen: `${euro(o.pack_price, { cents: true })} ex VAT per ${pack(o)}`,
                        })
                      }
                    >
                      <Icon name="mail" className="h-4 w-4" /> Ask for a quote
                    </button>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold tabular-nums">
                    {perStandardShort(o.ppu, unit)}
                  </p>
                  {diff != null && (
                    <span
                      className={`chip mt-1 ${diff < 0 ? 'bg-good-soft text-good' : ''}`}
                    >
                      {diff < 0 ? `${pct(-diff)} less` : `${pct(diff)} more`}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        lastDone && (
          <p className="border-t border-line px-5 py-3 text-sm text-muted">
            No like-for-like prices found online on{' '}
            {dateTime(lastDone.started_at)}.
          </p>
        )
      )}

      <div className="border-t border-line px-5 py-3 text-xs text-muted">
        <p>
          Prices are ex VAT, read from each seller's own page. They count
          towards your savings for {live.max_age_days} days after the check.
        </p>
        {live.checks.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer hover:text-ink">
              Check history
            </summary>
            <ul className="mt-2 space-y-1">
              {live.checks.map((c) => (
                <li key={c.id} className="flex justify-between gap-3">
                  <span className="tabular-nums">{dateTime(c.started_at)}</span>
                  <span className={c.status === 'failed' ? 'text-rust' : ''}>
                    {c.status === 'done'
                      ? `${c.offers_found} price${c.offers_found === 1 ? '' : 's'} found`
                      : c.status === 'running'
                        ? 'Searching…'
                        : 'Failed'}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  )
}
