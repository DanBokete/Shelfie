import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { EmailModal } from '#/components/EmailModal'
import type { EmailRequest } from '#/components/EmailModal'
import { Icon, Spinner } from '#/components/Icon'
import { pool, postFile, postJSON } from '#/lib/api'
import type { AuditReport, ReportItem } from '#/lib/audit-types'
import { prepareUpload } from '#/lib/client-files'
import { euro, pct, perStandardShort } from '#/lib/format'
import { GROUP_LABELS } from '#/lib/savings'
import type { FindingGroup } from '#/lib/savings'
import { buildRows, readSheet, sampleRows } from '#/lib/stocklist'
import type { Mapping, StockRow } from '#/lib/stocklist'

export const Route = createFileRoute('/audit')({
  component: AuditPage,
  head: () => ({ meta: [{ title: 'Stock list check - Shelfie' }] }),
})

const BATCH = 25
const CONCURRENCY = 3
const ACCEPT =
  '.csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/*,.heic'

type Stage =
  | { kind: 'idle' }
  | { kind: 'reading'; file: string; message: string }
  | { kind: 'matching'; file: string; done: number; total: number }
  | { kind: 'report'; report: AuditReport }
  | { kind: 'error'; message: string }

const COLUMN_LABELS: Record<keyof Mapping['columns'], string> = {
  product_name: 'Product',
  quantity: 'Quantity',
  unit: 'Unit',
  price: 'Price',
  supplier: 'Supplier',
}

function AuditPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [sheet, setSheet] = useState<{
    rows: Array<Array<string>>
    mapping: Mapping
    truncated: boolean
    items: number
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [email, setEmail] = useState<Array<EmailRequest> | null>(null)
  const input = useRef<HTMLInputElement>(null)

  async function start(file: File) {
    setSheet(null)
    try {
      setStage({
        kind: 'reading',
        file: file.name,
        message: 'Reading your list...',
      })
      let rows: Array<Array<string>>
      if (
        file.type.startsWith('image/') ||
        /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)
      ) {
        setStage({
          kind: 'reading',
          file: file.name,
          message: 'Reading the photo of your list...',
        })
        const { blob, name } = await prepareUpload(file)
        rows = (
          await postFile<{ rows: Array<Array<string>> }>(
            '/api/audit',
            blob,
            name,
          )
        ).rows
        const { cleanRows } = await import('#/lib/stocklist')
        rows = cleanRows(rows)
      } else {
        rows = await readSheet(file)
      }
      if (rows.length === 0) throw new Error('That file looks empty.')
      setStage({
        kind: 'reading',
        file: file.name,
        message: `Found ${rows.length} rows. Reading product names, quantities and prices...`,
      })
      const det = await postJSON<Mapping & { is_stock_list: boolean }>(
        '/api/audit',
        { action: 'columns', rows: sampleRows(rows) },
      )
      if (!det.is_stock_list || det.columns.product_name == null)
        throw new Error(
          "That doesn't look like a stock list. Try a file with one product per row.",
        )
      await run(file.name, rows, det)
    } catch (e) {
      setStage({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Something went wrong',
      })
    }
  }

  async function run(
    fileName: string,
    rows: Array<Array<string>>,
    mapping: Mapping,
  ) {
    const { items, truncated } = buildRows(rows, mapping)
    setSheet({ rows, mapping, truncated, items: items.length })
    if (items.length === 0)
      throw new Error('No product rows found with these columns.')
    const { upload_id } = await postJSON<{ upload_id: string }>('/api/audit', {
      action: 'start',
      file_name: fileName,
      mapping,
    })
    const batches: Array<Array<StockRow>> = []
    for (let i = 0; i < items.length; i += BATCH)
      batches.push(items.slice(i, i + BATCH))
    let done = 0
    setStage({ kind: 'matching', file: fileName, done, total: items.length })
    await pool(batches, CONCURRENCY, async (b) => {
      await postJSON('/api/audit', {
        action: 'batch',
        upload_id,
        period: mapping.quantity_period,
        rows: b,
      })
      done += b.length
      setStage({ kind: 'matching', file: fileName, done, total: items.length })
    })
    const report = await postJSON<AuditReport>('/api/audit', {
      action: 'finish',
      upload_id,
    })
    setStage({ kind: 'report', report })
  }

  async function remap(next: Mapping) {
    if (!sheet || stage.kind !== 'report') return
    const name = stage.report.file_name ?? 'stock list'
    try {
      await run(name, sheet.rows, next)
    } catch (e) {
      setStage({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Something went wrong',
      })
    }
  }

  const busy = stage.kind === 'reading' || stage.kind === 'matching'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Check your whole stock list
        </h1>
        <p className="mt-1 text-muted">
          Upload whatever list you have: a spreadsheet, a CSV, or a photo of a
          handwritten list.
        </p>
      </div>

      {!busy && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const f = e.dataTransfer.files.item(0)
            if (f) void start(f)
          }}
          className={`card flex flex-col items-center gap-3 border-2 border-dashed px-6 ${stage.kind === 'report' ? 'py-5' : 'py-10'} text-center ${
            dragging ? 'border-brand bg-brand-soft' : 'border-line'
          }`}
        >
          {stage.kind !== 'report' && (
            <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-brand">
              <Icon name="list" className="h-6 w-6" />
            </span>
          )}
          <p className="text-sm text-muted">
            CSV, Excel or a photo. No column setup needed.
          </p>
          <button
            className="btn-primary"
            onClick={() => input.current?.click()}
          >
            {stage.kind === 'report'
              ? 'Check another list'
              : 'Choose a stock list'}
          </button>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void start(f)
            }}
          />
        </div>
      )}

      {stage.kind === 'reading' && (
        <div className="card flex items-center gap-3 px-5 py-6">
          <Spinner className="h-6 w-6 text-brand" />
          <div>
            <p className="font-semibold">{stage.file}</p>
            <p className="text-sm text-muted">{stage.message}</p>
          </div>
        </div>
      )}

      {sheet && (busy || stage.kind === 'report') && (
        <ColumnChips
          sheet={sheet}
          disabled={busy}
          onChange={(m) => void remap(m)}
        />
      )}

      {stage.kind === 'matching' && (
        <div className="card space-y-3 px-5 py-5">
          <p className="font-semibold">
            Checking {stage.total} items against your supplier prices...{' '}
            {stage.done}/{stage.total}
          </p>
          <div className="h-2.5 overflow-hidden rounded-full bg-soft">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{
                width: `${Math.max(4, (100 * stage.done) / stage.total)}%`,
              }}
            />
          </div>
        </div>
      )}

      {stage.kind === 'error' && (
        <div className="card flex items-start gap-3 border-rust/30 bg-rust-soft px-5 py-4 text-rust">
          <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{stage.message}</p>
        </div>
      )}

      {stage.kind === 'report' && (
        <Report
          report={stage.report}
          truncated={sheet?.truncated ?? false}
          onEmail={setEmail}
        />
      )}

      {email && <EmailModal requests={email} onClose={() => setEmail(null)} />}
    </div>
  )
}

function ColumnChips({
  sheet,
  disabled,
  onChange,
}: {
  sheet: { rows: Array<Array<string>>; mapping: Mapping; items: number }
  disabled: boolean
  onChange: (m: Mapping) => void
}) {
  const header =
    sheet.mapping.header_row_index == null
      ? null
      : sheet.rows[sheet.mapping.header_row_index]
  const width = Math.max(...sheet.rows.map((r) => r.length))
  const colName = (i: number) =>
    header?.[i] || `Column ${String.fromCharCode(65 + i)}`
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">Found {sheet.items} items. Columns:</span>
      {(Object.keys(COLUMN_LABELS) as Array<keyof Mapping['columns']>).map(
        (k) => (
          <label
            key={k}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-card py-1 pr-1 pl-3"
          >
            <span className="font-semibold">{COLUMN_LABELS[k]}</span>
            <select
              className="rounded-full bg-soft px-2 py-0.5 text-sm outline-none disabled:opacity-60"
              disabled={disabled}
              value={sheet.mapping.columns[k] ?? ''}
              onChange={(e) =>
                onChange({
                  ...sheet.mapping,
                  columns: {
                    ...sheet.mapping.columns,
                    [k]: e.target.value === '' ? null : Number(e.target.value),
                  },
                })
              }
            >
              {k !== 'product_name' && <option value="">none</option>}
              {Array.from({ length: width }, (_, i) => (
                <option key={i} value={i}>
                  {colName(i)}
                </option>
              ))}
            </select>
          </label>
        ),
      )}
      <label className="inline-flex items-center gap-1 rounded-full border border-line bg-card py-1 pr-1 pl-3">
        <span className="font-semibold">Per</span>
        <select
          className="rounded-full bg-soft px-2 py-0.5 text-sm outline-none disabled:opacity-60"
          disabled={disabled}
          value={sheet.mapping.quantity_period}
          onChange={(e) =>
            onChange({
              ...sheet.mapping,
              quantity_period: e.target.value as Mapping['quantity_period'],
            })
          }
        >
          <option value="week">week</option>
          <option value="month">month</option>
          <option value="unknown">not sure (week)</option>
        </select>
      </label>
    </div>
  )
}

function useCountUp(target: number, ms = 1500): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

function emailItem(i: ReportItem) {
  if (
    !i.current ||
    i.your_pack_price == null ||
    i.best_pack_price == null ||
    !i.pack_label
  )
    return null
  return {
    product_name: i.product_name ?? i.raw_name,
    pack_label: i.pack_label,
    your_price: i.your_pack_price,
    best_price: Math.round(i.best_pack_price * 100) / 100,
    weekly_quantity: i.weekly_quantity,
  }
}

function Report({
  report,
  truncated,
  onEmail,
}: {
  report: AuditReport
  truncated: boolean
  onEmail: (g: Array<EmailRequest>) => void
}) {
  const total = useCountUp(report.total_annual_saving)
  const switchItems =
    report.groups.find((g) => g.group === 'switch')?.items ?? []

  function fixAll() {
    const bySupplier = new Map<
      string,
      Extract<EmailRequest, { kind: 'match' }>
    >()
    for (const i of switchItems) {
      const it = emailItem(i)
      if (!it || !i.current) continue
      const g = bySupplier.get(i.current.supplier_id) ?? {
        kind: 'match' as const,
        supplier_id: i.current.supplier_id,
        supplier_name: i.current.supplier_name,
        items: [],
      }
      g.items.push(it)
      bySupplier.set(i.current.supplier_id, g)
    }
    onEmail([...bySupplier.values()])
  }

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand to-brand-dark px-5 py-7 text-white md:px-8">
          <p className="text-lg font-medium text-white/90">You could save</p>
          <p className="text-5xl font-bold tracking-tight tabular-nums md:text-6xl">
            {euro(total, { cents: false })}
            <span className="ml-2 text-xl font-semibold text-white/80">
              a year
            </span>
          </p>
          <p className="mt-2 text-white/85">
            across {report.items_with_saving} items, from{' '}
            {report.suppliers_with_saving} supplier
            {report.suppliers_with_saving === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-5 py-3 text-sm text-muted">
          <span>{report.item_count} items checked</span>
          {report.groups.map((g) =>
            g.items.length ? (
              <span key={g.group}>
                {g.items.length} {GROUP_LABELS[g.group].title.toLowerCase()}
              </span>
            ) : null,
          )}
          {truncated && (
            <span className="text-warn">
              Only the first 300 rows were checked.
            </span>
          )}
        </div>
      </section>

      {report.groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <Group
            key={g.group}
            group={g.group}
            items={g.items}
            onEmail={onEmail}
          />
        ))}

      {switchItems.length > 0 && (
        <button className="btn-primary w-full py-4 text-base" onClick={fixAll}>
          <Icon name="mail" /> Fix all: one email per supplier
        </button>
      )}
    </div>
  )
}

const GROUP_TONE: Record<FindingGroup, string> = {
  switch: 'text-brand',
  creep: 'text-rust',
  two_prices: 'text-warn',
  best: 'text-muted',
  no_data: 'text-muted',
}

function Group({
  group,
  items,
  onEmail,
}: {
  group: FindingGroup
  items: Array<ReportItem>
  onEmail: (g: Array<EmailRequest>) => void
}) {
  const label = GROUP_LABELS[group]
  const collapsed = group === 'best'
  const [open, setOpen] = useState(!collapsed)
  return (
    <section>
      <button
        className="mb-2 flex w-full items-baseline justify-between text-left"
        onClick={() => setOpen(!open)}
      >
        <span>
          <span className={`text-lg font-bold ${GROUP_TONE[group]}`}>
            {label.title}
          </span>
          <span className="ml-2 text-sm text-muted">{items.length}</span>
          <span className="block text-sm text-muted">{label.hint}</span>
        </span>
        <Icon
          name="chevron"
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ul className="card divide-y divide-line">
          {items.map((i) => (
            <ItemRow key={i.id} item={i} onEmail={onEmail} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ItemRow({
  item: i,
  onEmail,
}: {
  item: ReportItem
  onEmail: (g: Array<EmailRequest>) => void
}) {
  const it = i.group === 'switch' ? emailItem(i) : null
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48">
        {i.product_id ? (
          <Link
            to="/item/$productId"
            params={{ productId: i.product_id }}
            className="font-semibold hover:underline"
          >
            {i.raw_name}
          </Link>
        ) : (
          <p className="font-semibold">{i.raw_name}</p>
        )}
        <p className="text-sm text-muted">
          {i.group === 'no_data'
            ? i.product_id
              ? `Matched to ${i.product_name}, but no prices yet`
              : 'Not found in any invoice or price list'
            : i.current
              ? `${i.current.supplier_name}: ${perStandardShort(i.current.ppu, i.base_unit)}`
              : ''}
          {i.group === 'switch' && i.cheapest && (
            <>
              {' '}
              · best {perStandardShort(i.cheapest.ppu, i.base_unit)} at{' '}
              {i.cheapest.supplier_name} ({pct(i.pct_cheaper)} less)
            </>
          )}
          {i.group === 'creep' && i.creep_pct != null && (
            <> · up {pct(i.creep_pct)}</>
          )}
        </p>
      </div>
      {i.group === 'switch' && (
        <div className="text-right">
          <p className="font-bold text-brand">
            {i.annual_saving != null
              ? euro(i.annual_saving, { cents: false })
              : pct(i.pct_cheaper)}
          </p>
          <p className="text-xs text-muted">
            {i.annual_saving != null ? 'a year' : 'cheaper per unit'}
          </p>
        </div>
      )}
      {it && i.current && (
        <button
          className="btn-secondary px-3 py-1.5"
          onClick={() =>
            onEmail([
              {
                kind: 'match',
                supplier_id: i.current!.supplier_id,
                supplier_name: i.current!.supplier_name,
                items: [it],
              },
            ])
          }
        >
          Ask to match
        </button>
      )}
    </li>
  )
}
