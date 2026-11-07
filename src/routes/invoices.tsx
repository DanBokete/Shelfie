import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Icon, Spinner } from '#/components/Icon'
import { LineFixer } from '#/components/LineFixer'
import { Replies } from '#/components/Replies'
import { pool, postFile, postJSON } from '#/lib/api'
import { prepareUpload } from '#/lib/client-files'
import { euro, pack, pct, shortDate } from '#/lib/format'
import {
  getInvoiceLines,
  getInvoices,
  getReplies,
  getReviewQueue,
} from '#/server/fns'

export const Route = createFileRoute('/invoices')({
  loader: async () => {
    const [invoices, review, replies] = await Promise.all([
      getInvoices(),
      getReviewQueue(),
      getReplies(),
    ])
    return { invoices, review, replies }
  },
  component: InvoicesPage,
  head: () => ({ meta: [{ title: 'Invoices - Shelfie' }] }),
})

type ExtractResult =
  | { status: 'done'; invoice_id: string }
  | { status: 'duplicate'; invoice_id: string; duplicate_of: string }
  | { status: 'failed'; invoice_id: string; error: string }

interface QueueItem {
  key: string
  name: string
  file: File
  state: 'waiting' | 'reading' | 'done' | 'duplicate' | 'failed'
  invoice_id?: string
  error?: string
  seconds?: number
}

const MAX_FILES = 10
const CONCURRENCY = 3
const ACCEPT =
  'application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif'

function InvoicesPage() {
  const { invoices, review, replies } = Route.useLoaderData()
  const router = useRouter()
  const [queue, setQueue] = useState<Array<QueueItem>>([])
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)

  const update = (key: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  async function process(item: QueueItem) {
    const started = Date.now()
    update(item.key, { state: 'reading' })
    try {
      const { blob, name } = await prepareUpload(item.file)
      const r = await postFile<ExtractResult>(
        '/api/invoices/extract',
        blob,
        name,
      )
      finish(item.key, r, started)
    } catch (e) {
      update(item.key, {
        state: 'failed',
        error: e instanceof Error ? e.message : 'Upload failed',
      })
    }
  }

  async function retry(item: QueueItem) {
    if (!item.invoice_id) return process(item)
    const started = Date.now()
    update(item.key, { state: 'reading', error: undefined })
    try {
      finish(
        item.key,
        await postJSON<ExtractResult>('/api/invoices/extract', {
          invoice_id: item.invoice_id,
        }),
        started,
      )
    } catch (e) {
      update(item.key, {
        state: 'failed',
        error: e instanceof Error ? e.message : 'Failed',
      })
    }
  }

  function finish(key: string, r: ExtractResult, started: number) {
    update(key, {
      state: r.status,
      invoice_id: r.invoice_id,
      error: r.status === 'failed' ? r.error : undefined,
      seconds: (Date.now() - started) / 1000,
    })
    void router.invalidate()
  }

  async function addFiles(list: FileList | Array<File>) {
    const files = [...list]
    setNotice(
      files.length > MAX_FILES
        ? `Up to ${MAX_FILES} files at a time: added the first ${MAX_FILES}.`
        : null,
    )
    const items = files.slice(0, MAX_FILES).map((file) => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      file,
      state: 'waiting' as const,
    }))
    setQueue((q) => [...items, ...q])
    await pool(items, CONCURRENCY, process)
  }

  const busy = queue.some((q) => q.state === 'waiting' || q.state === 'reading')
  const queuedIds = new Set(queue.map((q) => q.invoice_id).filter(Boolean))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
        <p className="mt-1 text-muted">
          Drop in supplier invoices: PDFs, photos, even crumpled ones.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
        }}
        className={`card flex flex-col items-center gap-4 border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? 'border-brand bg-brand-soft' : 'border-line'
        }`}
      >
        <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-brand">
          <Icon name="upload" className="h-6 w-6" />
        </span>
        <div>
          <p className="font-semibold">Drag invoices here</p>
          <p className="text-sm text-muted">
            PDF, JPG, PNG or HEIC, up to {MAX_FILES} at once
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            className="btn-primary"
            onClick={() => fileInput.current?.click()}
          >
            Choose files
          </button>
          <button
            className="btn-secondary"
            onClick={() => cameraInput.current?.click()}
          >
            <Icon name="camera" className="h-4 w-4" /> Take photo
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        {notice && <p className="text-sm text-warn">{notice}</p>}
      </div>

      {queue.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Just added</h2>
            {!busy && (
              <button
                className="btn-ghost px-2 py-1"
                onClick={() => setQueue([])}
              >
                Clear
              </button>
            )}
          </div>
          {queue.map((item) => (
            <QueueCard key={item.key} item={item} onRetry={() => retry(item)} />
          ))}
        </section>
      )}

      <section id="review" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-lg font-bold">Check matches</h2>
          <p className="text-sm text-muted">
            Lines we are not sure about. Anything with a reading or maths
            problem is left out of your savings until you confirm it.
          </p>
        </div>
        {review.length === 0 ? (
          <p className="card px-4 py-5 text-sm text-muted">
            Nothing to check. Every line was read and matched with confidence.
          </p>
        ) : (
          <ul className="space-y-3">
            {review.map((r) => (
              <ReviewCard
                key={r.id}
                row={r}
                onDone={() => void router.invalidate()}
              />
            ))}
          </ul>
        )}
      </section>

      <Replies initial={replies} onRead={() => void router.invalidate()} />

      <section className="space-y-3">
        <h2 className="text-lg font-bold">All invoices</h2>
        {invoices.length === 0 ? (
          <p className="card px-4 py-5 text-sm text-muted">No invoices yet.</p>
        ) : (
          <ul className="card divide-y divide-line">
            {invoices
              .filter((i) => !queuedIds.has(i.id))
              .map((i) => (
                <InvoiceRow key={i.id} inv={i} />
              ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function QueueCard({
  item,
  onRetry,
}: {
  item: QueueItem
  onRetry: () => void
}) {
  const [lines, setLines] = useState<Awaited<
    ReturnType<typeof getInvoiceLines>
  > | null>(null)
  const [meta, setMeta] = useState<{
    supplier: string | null
    date: string | null
    number: string | null
  } | null>(null)

  useEffect(() => {
    if (item.state !== 'done' || !item.invoice_id) return
    let live = true
    void Promise.all([
      getInvoiceLines({ data: { id: item.invoice_id } }),
      getInvoices(),
    ]).then(([l, all]) => {
      if (!live) return
      const inv = all.find((x) => x.id === item.invoice_id)
      setLines(l)
      setMeta({
        supplier: inv?.supplier_name ?? null,
        date: inv?.invoice_date ?? null,
        number: inv?.invoice_number ?? null,
      })
    })
    return () => {
      live = false
    }
  }, [item.state, item.invoice_id])

  return (
    <article className="card overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3">
        <StatusDot state={item.state} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {meta?.supplier ?? item.name}
          </p>
          <p className="truncate text-sm text-muted">
            {item.state === 'waiting' && 'Waiting...'}
            {item.state === 'reading' && 'Reading invoice...'}
            {item.state === 'duplicate' && 'Already added'}
            {item.state === 'failed' &&
              (item.error ?? "Couldn't read this one")}
            {item.state === 'done' &&
              (meta
                ? `${shortDate(meta.date)} · ${meta.number ?? 'no number'} · ${lines?.length ?? 0} lines`
                : 'Loading lines...')}
          </p>
        </div>
        {item.seconds != null && (
          <span className="text-xs text-muted">{item.seconds.toFixed(1)}s</span>
        )}
        {item.state === 'failed' && (
          <button className="btn-secondary px-3 py-1.5" onClick={onRetry}>
            Retry
          </button>
        )}
      </header>
      {lines && <LinesTable lines={lines} />}
    </article>
  )
}

function StatusDot({ state }: { state: QueueItem['state'] }) {
  if (state === 'waiting' || state === 'reading')
    return (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-soft text-muted">
        <Spinner className="h-5 w-5" />
      </span>
    )
  const tone =
    state === 'done'
      ? 'bg-brand-soft text-brand'
      : state === 'duplicate'
        ? 'bg-soft text-muted'
        : 'bg-rust-soft text-rust'
  return (
    <span
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}`}
    >
      <Icon
        name={
          state === 'done' ? 'check' : state === 'duplicate' ? 'copy' : 'alert'
        }
        className="h-5 w-5"
      />
    </span>
  )
}

type Line = Awaited<ReturnType<typeof getInvoiceLines>>[number]

function LinesTable({ lines }: { lines: Array<Line> }) {
  const [open, setOpen] = useState<string | null>(null)
  const router = useRouter()
  const [rows, setRows] = useState(lines)
  useEffect(() => setRows(lines), [lines])

  if (rows.length === 0)
    return (
      <p className="border-t border-line px-4 py-3 text-sm text-muted">
        No product lines found.
      </p>
    )
  return (
    <ul className="divide-y divide-line border-t border-line">
      {rows.map((l) => {
        const flagged = l.needs_review
        const body = (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[13px] leading-snug break-words">
                {l.raw_description}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
                <Icon name="chevronRight" className="h-3.5 w-3.5" />
                <span className="font-medium text-ink">
                  {l.products?.canonical_name ?? 'Not matched'}
                </span>
                <span>· {pack(l)}</span>
              </p>
            </div>
            <div className="shrink-0 text-right text-sm">
              <p className="font-semibold whitespace-nowrap">
                {l.quantity != null && (
                  <span className="font-normal text-muted">
                    {l.quantity} x{' '}
                  </span>
                )}
                {euro(Number(l.pack_price), { cents: true })}
              </p>
              {flagged && (
                <span className="mt-1 inline-block rounded-full bg-warn px-2 py-0.5 text-[11px] font-semibold text-white">
                  Check this
                </span>
              )}
            </div>
          </div>
        )
        return (
          <li key={l.id} className={flagged ? 'bg-warn-soft/70' : ''}>
            {flagged ? (
              <button
                className="w-full px-4 py-2.5 text-left hover:bg-warn-soft"
                onClick={() => setOpen(open === l.id ? null : l.id)}
              >
                {body}
              </button>
            ) : (
              <div className="px-4 py-2.5">{body}</div>
            )}
            {open === l.id && (
              <div className="space-y-2 px-4 pb-3">
                <Reasons reasons={l.review_reasons} />
                <LineFixer
                  line={l}
                  onDone={() => {
                    setOpen(null)
                    setRows((r) =>
                      r.map((x) =>
                        x.id === l.id ? { ...x, needs_review: false } : x,
                      ),
                    )
                    void router.invalidate()
                  }}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Reasons({ reasons }: { reasons: Array<string> }) {
  return (
    <ul className="space-y-1 text-sm">
      {reasons.map((r) => (
        <li key={r} className="flex gap-2 text-warn">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{r.replace(/^(Maths|Extraction|Match|VAT): /, '')}</span>
        </li>
      ))}
    </ul>
  )
}

type ReviewRow = Awaited<ReturnType<typeof getReviewQueue>>[number]

function ReviewCard({ row, onDone }: { row: ReviewRow; onDone: () => void }) {
  return (
    <li className="card space-y-3 px-4 py-4">
      <div>
        <p className="font-mono text-[13px] font-semibold break-words">
          {row.raw_description}
        </p>
        <p className="text-sm text-muted">
          {row.suppliers?.name} ·{' '}
          {row.source === 'price_list'
            ? 'Price list'
            : row.source === 'quote'
              ? 'Quote'
              : `Invoice ${row.invoices?.invoice_number ?? ''}`}{' '}
          · {shortDate(row.observed_on)}
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-2 rounded-xl bg-soft/70 px-3 py-2 text-sm">
        <div>
          <dt className="label">Qty</dt>
          <dd>{row.quantity ?? '-'}</dd>
        </div>
        <div>
          <dt className="label">Price</dt>
          <dd>{euro(Number(row.pack_price), { cents: true })}</dd>
        </div>
        <div>
          <dt className="label">Line total</dt>
          <dd>
            {row.line_total != null
              ? euro(Number(row.line_total), { cents: true })
              : '-'}
          </dd>
        </div>
        <div className="col-span-3">
          <dt className="label">Matched to</dt>
          <dd>
            <b>{row.products?.canonical_name ?? 'no product'}</b>{' '}
            <span className="text-muted">· {pack(row)}</span>
            {row.match_confidence != null && (
              <span className="text-muted">
                {' '}
                · {pct(Number(row.match_confidence))} sure
              </span>
            )}
          </dd>
        </div>
      </dl>
      <Reasons reasons={row.review_reasons} />
      <LineFixer line={row} onDone={onDone} />
    </li>
  )
}

function InvoiceRow({
  inv,
}: {
  inv: Awaited<ReturnType<typeof getInvoices>>[number]
}) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<Array<Line> | null>(null)
  useEffect(() => {
    if (open && !lines)
      void getInvoiceLines({ data: { id: inv.id } }).then(setLines)
  }, [open, lines, inv.id])

  return (
    <li>
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-soft/60"
        onClick={() => setOpen(!open)}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {inv.supplier_name ?? inv.file_name}
          </p>
          <p className="truncate text-sm text-muted">
            {inv.status === 'done'
              ? `${shortDate(inv.invoice_date)} · ${inv.invoice_number ?? 'no number'}`
              : inv.status === 'failed'
                ? (inv.error ?? 'Failed')
                : inv.status === 'duplicate'
                  ? 'Already added'
                  : 'Reading...'}
          </p>
        </div>
        <span className="hidden truncate text-xs text-muted sm:block">
          {inv.file_name}
        </span>
        <Icon
          name="chevron"
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open &&
        (lines ? (
          <LinesTable lines={lines} />
        ) : (
          <div className="px-4 py-3">
            <Spinner className="h-4 w-4 text-muted" />
          </div>
        ))}
    </li>
  )
}
