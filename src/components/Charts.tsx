// Dashboard charts, drawn as inline SVG so they stay light and work offline.
// Supplier colours were checked for colour-blind separation on the card colour.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { euro, pct, shortDate } from '#/lib/format'

/** Supplier colours, in fixed order. Suppliers past the third share the neutral. */
const SERIES = ['#16855c', '#e0a11b', '#3f6fb5']
const NEUTRAL = '#a39a88'
const RISE = '#b42318'
const GRID = 'var(--color-line)'
const SURFACE = 'var(--color-card)'

export function supplierColour(index: number) {
  return SERIES[index] ?? NEUTRAL
}

/** Width of an element, kept up to date as the layout changes. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** Clean axis steps: 1, 2 or 5 times a power of ten, about `count` of them. */
function niceTicks(max: number, count = 4): Array<number> {
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].find((m) => m * mag >= raw)! * mag
  const ticks = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v)
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}

/** A rectangle with rounded top corners and a square base. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

function Tooltip({
  x,
  y,
  width,
  children,
}: {
  x: number
  y: number
  width: number
  children: ReactNode
}) {
  // Flip to the left of the pointer near the right edge.
  const flip = x > width - 180
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-[0_4px_16px_rgba(29,26,20,0.12)]"
      style={{
        left: flip ? undefined : x + 12,
        right: flip ? width - x + 12 : undefined,
        top: y,
      }}
    >
      {children}
    </div>
  )
}

function Key({ colour }: { colour: string }) {
  return (
    <span
      className="inline-block h-0.5 w-3 shrink-0 rounded-full"
      style={{ background: colour }}
    />
  )
}

export interface SpendWeek {
  week: string
  by_supplier: Record<string, number>
}

/** Weekly invoice spend, stacked by supplier. */
export function WeeklySpendChart({
  weeks,
  suppliers,
}: {
  weeks: Array<SpendWeek>
  suppliers: Array<string>
}) {
  const [ref, width] = useWidth(640)
  const [active, setActive] = useState<number | null>(null)

  const plotH = 180
  const axisW = 48
  const axisH = 24
  const top = 18
  const plotW = Math.max(width - axisW, 100)
  const totals = weeks.map((w) =>
    Object.values(w.by_supplier).reduce((s, v) => s + v, 0),
  )
  const ticks = niceTicks(Math.max(...totals, 1))
  const yMax = ticks[ticks.length - 1]
  const y = (v: number) => top + plotH - (v / yMax) * plotH
  const band = plotW / weeks.length
  const barW = Math.min(24, band * 0.62)
  const peak = totals.indexOf(Math.max(...totals))
  // Label every nth week so dates never collide.
  const every = Math.ceil(weeks.length / Math.max(Math.floor(plotW / 56), 1))

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={top + plotH + axisH}
        role="img"
        aria-label="Weekly invoice spend by supplier"
        className="block overflow-visible"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={axisW}
              x2={width}
              y1={y(t)}
              y2={y(t)}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={axisW - 8}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted text-[11px] tabular-nums"
            >
              {euro(t, { cents: false })}
            </text>
          </g>
        ))}

        {weeks.map((w, i) => {
          const cx = axisW + band * i + band / 2
          const x = cx - barW / 2
          let base = y(0)
          const dim = active != null && active !== i
          const topSeg = suppliers.reduce(
            (last, s, si) => (w.by_supplier[s] > 0 ? si : last),
            -1,
          )
          return (
            <g
              key={w.week}
              opacity={dim ? 0.4 : 1}
              className="transition-opacity"
            >
              <clipPath id={`col-${i}`}>
                <path
                  d={roundedTop(x, y(totals[i]), barW, y(0) - y(totals[i]), 4)}
                />
              </clipPath>
              <g clipPath={`url(#col-${i})`}>
                {suppliers.map((s, si) => {
                  const v = w.by_supplier[s] ?? 0
                  if (v <= 0) return null
                  const h = y(0) - y(v)
                  base -= h
                  // 2px card-coloured gap above every segment but the top one.
                  const gap = si === topSeg ? 0 : 2
                  return (
                    <rect
                      key={s}
                      x={x}
                      y={base + gap}
                      width={barW}
                      height={Math.max(h - gap, 0.5)}
                      fill={supplierColour(si)}
                    />
                  )
                })}
              </g>
              {i === peak && (
                <text
                  x={cx}
                  y={y(totals[i]) - 6}
                  textAnchor="middle"
                  className="fill-ink text-[11px] font-semibold tabular-nums"
                >
                  {euro(totals[i], { cents: false })}
                </text>
              )}
              {i % every === 0 && (
                <text
                  x={cx}
                  y={top + plotH + 16}
                  textAnchor="middle"
                  className="fill-muted text-[11px]"
                >
                  {shortDate(w.week)}
                </text>
              )}
              <rect
                x={axisW + band * i}
                y={top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`Week of ${shortDate(w.week)}: ${euro(totals[i], { cents: false })}`}
                className="cursor-default outline-none"
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          )
        })}
        <line
          x1={axisW}
          x2={width}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--color-muted)"
          strokeOpacity={0.35}
        />
      </svg>

      {active != null && (
        <Tooltip
          x={axisW + band * active + band / 2}
          y={Math.max(y(totals[active]) - 20, 0)}
          width={width}
        >
          <p className="text-muted">Week of {shortDate(weeks[active].week)}</p>
          <p className="text-sm font-semibold tabular-nums">
            {euro(totals[active], { cents: false })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {suppliers.map((s, si) => {
              const v = weeks[active].by_supplier[s] ?? 0
              if (v <= 0) return null
              return (
                <li key={s} className="flex items-center gap-2">
                  <Key colour={supplierColour(si)} />
                  <span className="font-medium tabular-nums">
                    {euro(v, { cents: false })}
                  </span>
                  <span className="truncate text-muted">{s}</span>
                </li>
              )
            })}
          </ul>
        </Tooltip>
      )}
    </div>
  )
}

/** One whole split by supplier: a thin bar, then a row per supplier with its figures. */
export function SupplierSplit({
  suppliers,
}: {
  suppliers: Array<{ name: string; total: number }>
}) {
  const total = suppliers.reduce((s, x) => s + x.total, 0) || 1
  return (
    <div>
      <div
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={suppliers
          .map((s) => `${s.name} ${pct(s.total / total)}`)
          .join(', ')}
      >
        {suppliers.map((s, i) =>
          s.total > 0 ? (
            <div
              key={s.name}
              style={{
                width: `${(s.total / total) * 100}%`,
                background: supplierColour(i),
              }}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {suppliers.map((s, i) => (
          <li key={s.name} className="flex min-w-0 items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: supplierColour(i) }}
            />
            <span className="truncate">{s.name}</span>
            <span className="shrink-0 text-muted tabular-nums">
              {pct(s.total / total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A ranked horizontal bar with its value at the tip. */
export function SavingBar({ value, max }: { value: number; max: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <div
          className="h-2.5 rounded-r bg-[#16855c]"
          style={{ width: `${Math.max((value / (max || 1)) * 100, 2)}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums">
        {euro(value, { cents: false })}
        <span className="font-normal text-muted"> a year</span>
      </span>
    </div>
  )
}

/** Price over time at one supplier, with the latest price marked. */
export function PriceSparkline({
  points,
  unit,
}: {
  points: Array<{ date: string; price: number }>
  unit: string
}) {
  const [ref, width] = useWidth(240)
  const [active, setActive] = useState<number | null>(null)
  if (points.length < 2) return null

  const h = 56
  const pad = 6
  const prices = points.map((p) => p.price)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const span = hi - lo || 1
  const t0 = Date.parse(points[0].date)
  const t1 = Date.parse(points[points.length - 1].date)
  const x = (d: string) =>
    pad + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * (width - pad * 2)
  const y = (v: number) => pad + (1 - (v - lo) / span) * (h - pad * 2)
  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.date)},${y(p.price)}`)
    .join('')
  const shown = active ?? points.length - 1
  const fmt = (v: number) => `${euro(v, { cents: true })}${unit}`

  return (
    <div ref={ref}>
      <svg
        width={width}
        height={h}
        role="img"
        aria-label={`Price from ${fmt(prices[0])} to ${fmt(prices[prices.length - 1])}`}
        className="block overflow-visible"
        onPointerMove={(e) => {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left
          let best = 0
          points.forEach((p, i) => {
            if (Math.abs(x(p.date) - px) < Math.abs(x(points[best].date) - px))
              best = i
          })
          setActive(best)
        }}
        onPointerLeave={() => setActive(null)}
      >
        <path
          d={`${line}L${x(points[points.length - 1].date)},${h}L${x(points[0].date)},${h}Z`}
          fill={RISE}
          fillOpacity={0.08}
        />
        <path
          d={line}
          fill="none"
          stroke={RISE}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {active != null && (
          <line
            x1={x(points[active].date)}
            x2={x(points[active].date)}
            y1={0}
            y2={h}
            stroke="var(--color-muted)"
            strokeOpacity={0.4}
          />
        )}
        <circle
          cx={x(points[shown].date)}
          cy={y(points[shown].price)}
          r={4}
          fill={RISE}
          stroke={SURFACE}
          strokeWidth={2}
        />
      </svg>
      <p className="mt-1.5 flex justify-between text-xs text-muted">
        <span className="tabular-nums">
          {active == null ? (
            <>
              {fmt(prices[0])} <span aria-hidden="true">→</span>{' '}
              <b className="font-semibold text-ink">
                {fmt(prices[prices.length - 1])}
              </b>
            </>
          ) : (
            <b className="font-semibold text-ink">
              {fmt(points[active].price)}
            </b>
          )}
        </span>
        <span>
          {active == null
            ? `${shortDate(points[0].date)} – ${shortDate(points[points.length - 1].date)}`
            : shortDate(points[active].date)}
        </span>
      </p>
    </div>
  )
}
