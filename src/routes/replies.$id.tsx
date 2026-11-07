// Review one supplier reply: what they wrote next to what they answered and the prices it
// proposes. Nothing from a reply changes a price until the owner applies it here.
import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Icon, Spinner } from '#/components/Icon'
import { ProductSearch } from '#/components/ProductSearch'
import type { ProductOption } from '#/components/ProductSearch'
import {
  dateTime,
  euro,
  pack as packLabel,
  pct,
  perStandardShort,
} from '#/lib/format'
import { offerPrice } from '#/lib/reply-review'
import type { ReplyOutcome } from '#/lib/reply-review'
import {
  addReplyLineByHand,
  getReplyReview,
  retryReply,
  reviewHeldInvoice,
  reviewReplyAll,
  reviewReplyLine,
  setReplyOutcome,
} from '#/server/fns'

export const Route = createFileRoute('/replies/$id')({
  loader: async ({ params }) => {
    const r = await getReplyReview({ data: { id: params.id } })
    if (!r) throw notFound()
    return r
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `Reply from ${loaderData?.reply.supplier_name ?? loaderData?.reply.from_email ?? 'a supplier'} - Shelfie`,
      },
    ],
  }),
  component: ReviewPage,
  notFoundComponent: () => (
    <div className="card px-5 py-10 text-center">
      <p className="font-semibold">This reply is gone.</p>
      <Link to="/invoices" hash="replies" className="btn-primary mt-4">
        Back to Replies
      </Link>
    </div>
  ),
})

type Data = Awaited<ReturnType<typeof getReplyReview>> & {}
type Line = Data['lines'][number]
type Outcome = Data['outcomes'][number]
type Held = Data['invoices'][number]

const OUTCOMES: Array<{ value: ReplyOutcome; label: string }> = [
  { value: 'accepted', label: 'Accepted' },
  { value: 'counter_offer', label: 'Countered' },
  { value: 'declined', label: 'Declined' },
  { value: 'needs_info', label: 'Needs info' },
  { value: 'unclear', label: 'Unclear' },
]

const OUTCOME_TONE: Record<ReplyOutcome, string> = {
  accepted: 'bg-good-soft text-good',
  counter_offer: 'bg-brand-soft text-brand',
  declined: 'bg-rust-soft text-rust',
  needs_info: 'bg-warn-soft text-warn',
  unclear: 'bg-soft text-muted',
}

const STATUS_TONE: Record<Data['status']['kind'], string> = {
  waiting: 'bg-warn-soft text-warn',
  applied: 'bg-good-soft text-good',
  rejected: 'bg-soft text-muted',
  partly: 'bg-brand-soft text-brand',
  nothing: 'bg-soft text-muted',
}

/** Runs an action, shows its error, and reloads the page data when it worked. */
function useAction() {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await router.invalidate()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, run, setError }
}

function ReviewPage() {
  const data = Route.useLoaderData()
  const { reply, request, outcomes, lines, invoices, status } = data
  const who = reply.supplier_name ?? reply.from_name ?? reply.from_email
  const proposed = lines.filter((l) => l.status === 'proposed')
  const better = proposed.filter((l) => l.comparison.better)
  const pending =
    proposed.length + invoices.filter((i) => i.status === 'proposed').length
  const bulk = useAction()

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-2">
        <Link
          to="/invoices"
          hash="replies"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
        >
          <Icon name="chevronRight" className="h-4 w-4 rotate-180" />
          Replies
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">
            Reply from {who}
          </h1>
          <span className={`chip ${STATUS_TONE[status.kind]}`}>
            {status.label}
          </span>
        </div>
        <p className="text-sm text-muted">
          {dateTime(reply.received_at)}
          {request
            ? ` · answers your ${request.kind === 'match' ? '"Ask to match"' : '"Ask for a quote"'}: ${request.subject ?? '(no subject)'}`
            : ' · the request it answers is not known'}
        </p>
        {reply.status === 'failed' && reply.error && (
          <p role="alert" className="text-sm text-rust">
            {reply.error}
          </p>
        )}
        {reply.status === 'processed' && reply.error && (
          <p className="text-sm text-warn">{reply.error}</p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
        <Written data={data} />

        <div className="min-w-0 space-y-5">
          <Outcomes replyId={reply.id} outcomes={outcomes} />

          {invoices.length > 0 && (
            <Panel title="Invoices in this reply">
              <ul className="divide-y divide-line">
                {invoices.map((i) => (
                  <HeldRow key={i.id} replyId={reply.id} held={i} />
                ))}
              </ul>
            </Panel>
          )}

          <Panel
            title="Prices in this reply"
            actions={
              proposed.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn-primary px-3 py-1.5"
                    disabled={better.length === 0 || bulk.busy !== null}
                    onClick={() =>
                      void bulk.run('better', () =>
                        reviewReplyAll({
                          data: { id: reply.id, action: 'apply_better' },
                        }),
                      )
                    }
                  >
                    {bulk.busy === 'better' ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Icon name="check" className="h-4 w-4" />
                    )}
                    Apply all better prices
                    {better.length > 0 && ` (${better.length})`}
                  </button>
                  <button
                    className="btn-secondary px-3 py-1.5"
                    disabled={pending === 0 || bulk.busy !== null}
                    onClick={() =>
                      void bulk.run('reject', () =>
                        reviewReplyAll({
                          data: { id: reply.id, action: 'reject_all' },
                        }),
                      )
                    }
                  >
                    {bulk.busy === 'reject' && <Spinner className="h-4 w-4" />}
                    Reject all
                  </button>
                </div>
              )
            }
          >
            {bulk.error && (
              <p role="alert" className="px-4 pt-3 text-sm text-rust">
                {bulk.error}
              </p>
            )}
            {lines.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">
                No prices in this reply.
                {outcomes.some((o) => o.outcome === 'accepted') &&
                  ' The supplier said yes, but the request did not say what price it asked, so add the agreed price by hand.'}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {lines.map((l) => (
                  <LineRow key={l.id} line={l} />
                ))}
              </ul>
            )}
            <AddLine replyId={reply.id} />
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Panel({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="font-bold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

// --- What they wrote ------------------------------------------------------------------------

function Written({ data }: { data: Data }) {
  const { reply } = data
  const again = useAction()
  const readAgain = (only: string) =>
    void again.run(only, () => retryReply({ data: { id: reply.id, only } }))
  return (
    <section className="card min-w-0 overflow-hidden lg:sticky lg:top-4">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">What they wrote</h2>
          <p className="truncate text-xs text-muted">
            {reply.from_name
              ? `${reply.from_name} <${reply.from_email}>`
              : reply.from_email}
          </p>
        </div>
        <ReadAgain
          className="-mr-3"
          busy={again.busy === 'email body'}
          disabled={again.busy !== null}
          onClick={() => readAgain('email body')}
        />
      </div>
      <div className="px-4 py-3">
        <p className="text-sm font-semibold break-words">
          {reply.subject || '(no subject)'}
        </p>
        <p className="mt-2 max-h-56 overflow-auto sm:max-h-96 text-sm break-words whitespace-pre-wrap">
          {reply.body_text?.trim() || '(no text)'}
        </p>
      </div>
      {reply.attachments.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {reply.attachments.map((a) => (
            <Attachment
              key={a.index}
              replyId={reply.id}
              file={a}
              busy={again.busy === a.name}
              disabled={again.busy !== null}
              onReadAgain={() => readAgain(a.name)}
            />
          ))}
        </ul>
      )}
      {again.error && (
        <p role="alert" className="px-4 pb-3 text-sm text-rust">
          {again.error}
        </p>
      )}
    </section>
  )
}

function ReadAgain({
  busy,
  disabled,
  onClick,
  className = '',
}: {
  busy: boolean
  disabled: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      className={`btn-ghost shrink-0 px-3 py-1.5 ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      {busy && <Spinner className="h-4 w-4" />}
      {busy ? 'Reading…' : 'Read again'}
    </button>
  )
}

function fileUrl(replyId: string, index: number) {
  return `/api/reply/file?reply=${replyId}&i=${index}`
}

function Attachment({
  replyId,
  file,
  busy,
  disabled,
  onReadAgain,
}: {
  replyId: string
  file: Data['reply']['attachments'][number]
  busy: boolean
  disabled: boolean
  onReadAgain: () => void
}) {
  const [open, setOpen] = useState(false)
  const url = fileUrl(replyId, file.index)
  const image = file.type.startsWith('image/')
  return (
    <li className="px-4 py-3">
      <p className="flex min-w-0 items-center gap-2">
        <Icon name="invoice" className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 truncate text-sm font-medium">
          {file.name}
        </span>
      </p>
      <div className="mt-1 -ml-3 flex flex-wrap gap-1">
        <button
          className="btn-ghost px-3 py-1.5"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
        <ReadAgain busy={busy} disabled={disabled} onClick={onReadAgain} />
      </div>
      {open && (
        <FilePreview
          url={url}
          name={file.name}
          image={image}
          className="mt-2"
        />
      )}
    </li>
  )
}

// A PDF shows in a frame, with a link for browsers that cannot show PDFs inline.
function FilePreview({
  url,
  name,
  image,
  className = '',
}: {
  url: string
  name: string
  image: boolean
  className?: string
}) {
  if (image)
    return (
      <img
        src={url}
        alt={name}
        className={`max-h-[32rem] w-full rounded-lg border border-line object-contain ${className}`}
      />
    )
  return (
    <div className={`space-y-1 ${className}`}>
      <iframe
        src={url}
        title={name}
        className="h-[32rem] w-full rounded-lg border border-line bg-white"
      />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-muted underline"
      >
        Open in a new tab
      </a>
    </div>
  )
}

// --- What they answered ---------------------------------------------------------------------

function Outcomes({
  replyId,
  outcomes,
}: {
  replyId: string
  outcomes: Array<Outcome>
}) {
  // The reply as a whole says little when every requested product has its own answer.
  const perItem = outcomes.filter((o) => o.request_item !== null)
  const shown = perItem.length > 0 ? perItem : outcomes
  return (
    <Panel title="What they answered">
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">
          Not read yet. Press Read again to read it.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((o) => (
            <OutcomeRow key={o.id} replyId={replyId} outcome={o} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function OutcomeRow({
  replyId,
  outcome: o,
}: {
  replyId: string
  outcome: Outcome
}) {
  const [changing, setChanging] = useState(false)
  const act = useAction()
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-semibold">
            {o.product_name ?? 'The reply'}
          </span>
          <span className={`chip ${OUTCOME_TONE[o.outcome]}`}>{o.label}</span>
          {o.set_by === 'owner' && (
            <span className="text-xs text-muted">set by you</span>
          )}
        </div>
        {changing ? (
          <select
            className="rounded-lg border border-line bg-card px-2 py-1.5 text-sm"
            aria-label="What they answered"
            autoFocus
            defaultValue={o.outcome}
            disabled={act.busy !== null}
            onChange={(e) =>
              void act
                .run('set', () =>
                  setReplyOutcome({
                    data: {
                      reply_id: replyId,
                      request_item: o.request_item,
                      outcome: e.target.value as ReplyOutcome,
                    },
                  }),
                )
                .then((ok) => ok && setChanging(false))
            }
            onBlur={() => act.busy === null && setChanging(false)}
          >
            {OUTCOMES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        ) : (
          <button
            className="btn-ghost shrink-0 px-3 py-1"
            onClick={() => setChanging(true)}
          >
            Change
          </button>
        )}
      </div>
      {o.said && <p className="text-sm break-words text-muted">“{o.said}”</p>}
      {o.question && (
        <p className="text-sm text-warn">They asked: {o.question}</p>
      )}
      {act.error && <p className="text-sm text-rust">{act.error}</p>}
    </li>
  )
}

// --- Held invoices --------------------------------------------------------------------------

function HeldRow({ replyId, held }: { replyId: string; held: Held }) {
  const act = useAction()
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const data = Route.useLoaderData()
  const file = data.reply.attachments.find((a) => a.name === held.name)
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="invoice" className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {held.name}
        </span>
        <StatusChip status={held.status} applied="Added" />
      </div>
      <div
        className={`flex flex-wrap gap-2 ${held.status === 'proposed' ? 'pl-6' : 'pl-3'}`}
      >
        {held.status === 'proposed' ? (
          <>
            <button
              className="btn-primary px-3 py-1.5"
              disabled={act.busy !== null}
              onClick={() =>
                void act.run('add', async () => {
                  const r = await reviewHeldInvoice({
                    data: { id: held.id, action: 'add' },
                  })
                  setNote(r.error)
                })
              }
            >
              {act.busy === 'add' && <Spinner className="h-4 w-4" />}
              {act.busy === 'add' ? 'Reading the invoice…' : 'Add this invoice'}
            </button>
            <button
              className="btn-secondary px-3 py-1.5"
              disabled={act.busy !== null}
              onClick={() =>
                void act.run('reject', () =>
                  reviewHeldInvoice({
                    data: { id: held.id, action: 'reject' },
                  }),
                )
              }
            >
              Reject
            </button>
          </>
        ) : (
          <button
            className="btn-ghost px-3 py-1.5"
            disabled={act.busy !== null}
            onClick={() =>
              void act.run('undo', async () => {
                await reviewHeldInvoice({
                  data: { id: held.id, action: 'undo' },
                })
                setNote(null)
              })
            }
          >
            {act.busy === 'undo' && <Spinner className="h-4 w-4" />}
            Undo
          </button>
        )}
        {file && (
          <button
            className="btn-ghost px-3 py-1.5"
            aria-expanded={open}
            onClick={() => setOpen((x) => !x)}
          >
            {open ? 'Hide preview' : 'Preview'}
          </button>
        )}
        {held.status === 'applied' && held.invoice_id && (
          <Link to="/invoices" className="btn-ghost px-3 py-1.5">
            Open in Invoices
          </Link>
        )}
      </div>
      {(note ?? act.error) && (
        <p className={`pl-6 text-sm ${act.error ? 'text-rust' : 'text-warn'}`}>
          {act.error ?? note}
        </p>
      )}
      {open && file && (
        <FilePreview
          url={fileUrl(replyId, file.index)}
          name={held.name}
          image={file.type.startsWith('image/')}
        />
      )}
    </li>
  )
}

function StatusChip({
  status,
  applied = 'Applied',
}: {
  status: 'proposed' | 'applied' | 'rejected'
  applied?: string
}) {
  if (status === 'applied')
    return (
      <span className="chip bg-good-soft text-good">
        <Icon name="check" className="h-3 w-3" />
        {applied}
      </span>
    )
  if (status === 'rejected')
    return <span className="chip text-muted">Rejected</span>
  return <span className="chip bg-warn-soft text-warn">Waiting for you</span>
}

// --- Price lines ----------------------------------------------------------------------------

function LineRow({ line: l }: { line: Line }) {
  const [editing, setEditing] = useState(false)
  const act = useAction()
  const c = l.comparison
  const unit = l.base_unit
  const productName =
    l.product_name ??
    (l.new_product_name ? `New product: ${l.new_product_name}` : null)
  const decided = l.status !== 'proposed'

  return (
    <li className={`space-y-2.5 px-4 py-3.5 ${decided ? 'bg-soft/30' : ''}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="font-semibold break-words">
            {productName ?? <span className="text-warn">Pick the product</span>}
          </p>
          <p className="text-xs break-words text-muted">
            They wrote “{l.raw_description}” ·{' '}
            {l.origin === 'accepted'
              ? 'the price you asked for, which they accepted'
              : l.origin === 'manual'
                ? 'added by you'
                : l.source}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {l.agreed && (
            <span
              className="chip bg-brand-soft text-brand"
              title="Applying it makes it the price this supplier agreed to"
            >
              Agreed price
            </span>
          )}
          <StatusChip status={l.status} />
        </div>
      </div>

      <div className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Fact label="Their price">
          <span className="font-semibold">
            {offerPrice({
              pack_price: l.pack_price,
              pack_size: l.pack_size,
              pack_unit: l.pack_unit,
              units_per_case: l.units_per_case,
            })}
          </span>
          {c.ppu != null && unit && !offerPrice(l).includes('/') && (
            <span className="block text-muted">
              {perStandardShort(c.ppu, unit)}
            </span>
          )}
        </Fact>
        <Fact label="You pay now">
          {c.your_ppu != null && unit ? (
            <>
              <span className="font-semibold">
                {perStandardShort(c.your_ppu, unit)}
              </span>
              <span className="block text-muted">
                {c.your_pack_price != null &&
                  `${euro(c.your_pack_price, { cents: true })} per ${packLabel(l)} · `}
                {c.your_supplier}
              </span>
            </>
          ) : (
            <span className="text-muted">
              {c.problem ? '-' : 'Not bought yet'}
            </span>
          )}
        </Fact>
        <Fact label="Difference">
          {c.better === true && c.diff_ppu != null && unit ? (
            <>
              <span className="font-semibold text-good">
                {pct(c.diff_pct)} less · {difference(l, c.diff_ppu, unit)} less
              </span>
              <span className="block">
                {c.annual_saving != null && c.annual_saving > 0 ? (
                  <>
                    <span className="tag">
                      {euro(c.annual_saving, { cents: false })}
                    </span>{' '}
                    a year
                  </>
                ) : (
                  <span className="text-muted">yearly saving not known</span>
                )}
              </span>
            </>
          ) : c.better === false && c.diff_ppu != null && unit ? (
            <span className="font-semibold text-rust">
              Not better: {pct(-(c.diff_pct ?? 0))} more ·{' '}
              {difference(l, -c.diff_ppu, unit)} more
            </span>
          ) : (
            <span className="text-muted">-</span>
          )}
        </Fact>
      </div>

      {(c.problem || l.review_reasons.length > 0) && !decided && (
        <ul className="space-y-0.5 text-sm text-warn">
          {c.problem && <li>{c.problem}</li>}
          {l.review_reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {/* A ghost button leads once decided: pull it left so its text lines up. */}
      <div
        className={`flex flex-wrap gap-2 ${l.status === 'proposed' ? '' : '-ml-3'}`}
      >
        {l.status === 'proposed' ? (
          <>
            <button
              className="btn-primary px-3 py-1.5"
              disabled={act.busy !== null}
              onClick={() =>
                void act.run('apply', () =>
                  reviewReplyLine({ data: { id: l.id, action: 'apply' } }),
                )
              }
            >
              {act.busy === 'apply' ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Icon name="check" className="h-4 w-4" />
              )}
              Apply
            </button>
            <button
              className="btn-secondary px-3 py-1.5"
              disabled={act.busy !== null}
              onClick={() =>
                void act.run('reject', () =>
                  reviewReplyLine({ data: { id: l.id, action: 'reject' } }),
                )
              }
            >
              Reject
            </button>
            <button
              className="btn-ghost px-3 py-1.5"
              aria-expanded={editing}
              disabled={act.busy !== null}
              onClick={() => setEditing((e) => !e)}
            >
              <Icon name="pencil" className="h-4 w-4" />
              {editing ? 'Close' : 'Edit'}
            </button>
          </>
        ) : (
          <button
            className="btn-ghost px-3 py-1.5"
            disabled={act.busy !== null}
            onClick={() =>
              void act.run('undo', () =>
                reviewReplyLine({ data: { id: l.id, action: 'undo' } }),
              )
            }
          >
            {act.busy === 'undo' && <Spinner className="h-4 w-4" />}
            Undo
          </button>
        )}
        {l.product_id && (
          <Link
            to="/item/$productId"
            params={{ productId: l.product_id }}
            className="btn-ghost px-3 py-1.5"
          >
            Open item
          </Link>
        )}
      </div>

      {editing && l.status === 'proposed' && (
        <LineForm
          initial={l}
          busy={act.busy}
          onSubmit={(edit, apply) =>
            void act
              .run(apply ? 'apply' : 'edit', () =>
                reviewReplyLine({
                  data: { id: l.id, action: apply ? 'apply' : 'edit', edit },
                }),
              )
              .then((ok) => ok && setEditing(false))
          }
        />
      )}
      {act.error && (
        <p role="alert" className="text-sm text-rust">
          {act.error}
        </p>
      )}
    </li>
  )
}

/**
 * The price difference in the units an owner thinks in: per litre or kg, and per pack for
 * things counted each (a cent per egg reads as €0.00).
 */
function difference(l: Line, diffPpu: number, unit: BaseUnit): string {
  if (unit !== 'each') return perStandardShort(diffPpu, unit)
  const perPack =
    diffPpu *
    (l.pack_size ?? 1) *
    (l.pack_unit === 'each' ? l.units_per_case : 1)
  return `${euro(perPack, { cents: true })} per ${packLabel(l)}`
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="label">{label}</p>
      <p className="break-words">{children}</p>
    </div>
  )
}

// --- Editing and adding ----------------------------------------------------------------------

const UNITS = ['ml', 'cl', 'l', 'g', 'kg', 'each'] as const
type RawUnit = (typeof UNITS)[number]
type BaseUnit = 'ml' | 'g' | 'each'

function baseOf(u: string | null): BaseUnit {
  if (u === 'ml' || u === 'l' || u === 'cl') return 'ml'
  if (u === 'g' || u === 'kg') return 'g'
  return 'each'
}

interface FormValue {
  product_id?: string | null
  new_product?: { canonical_name: string; base_unit: BaseUnit } | null
  pack_price: number
  pack_size: number | null
  pack_unit: RawUnit | null
  units_per_case: number
}

/** Product, pack and price of a line. Used to edit a proposed line and to add one by hand. */
function LineForm({
  initial,
  busy,
  onSubmit,
  withDescription,
}: {
  initial?: Pick<
    Line,
    | 'product_id'
    | 'product_name'
    | 'new_product_name'
    | 'new_product_unit'
    | 'pack_price'
    | 'pack_size'
    | 'pack_unit'
    | 'units_per_case'
  >
  busy: string | null
  onSubmit: (
    v: FormValue & { raw_description?: string },
    apply: boolean,
  ) => void
  withDescription?: boolean
}) {
  const [product, setProduct] = useState<
    | { kind: 'existing'; id: string; name: string }
    | { kind: 'new'; name: string; unit: BaseUnit }
    | null
  >(
    initial?.product_id
      ? {
          kind: 'existing',
          id: initial.product_id,
          name: initial.product_name ?? '',
        }
      : initial?.new_product_name
        ? {
            kind: 'new',
            name: initial.new_product_name,
            unit: initial.new_product_unit ?? baseOf(initial.pack_unit),
          }
        : null,
  )
  const [searching, setSearching] = useState(!product)
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState(initial ? String(initial.pack_price) : '')
  const [size, setSize] = useState(
    initial?.pack_size == null ? '' : String(initial.pack_size),
  )
  const [unit, setUnit] = useState<string>(initial?.pack_unit ?? '')
  const [perCase, setPerCase] = useState(String(initial?.units_per_case ?? 1))

  const priceN = Number(price.replace(',', '.'))
  const sizeN = size.trim() === '' ? null : Number(size.replace(',', '.'))
  const perCaseN = Math.round(Number(perCase))
  const valid =
    product !== null &&
    price.trim() !== '' &&
    priceN > 0 &&
    (sizeN === null || sizeN > 0) &&
    perCaseN >= 1 &&
    (!withDescription || description.trim() !== '')

  const value = (): FormValue & { raw_description?: string } => ({
    ...(product?.kind === 'existing'
      ? { product_id: product.id, new_product: null }
      : product
        ? {
            product_id: null,
            new_product: {
              canonical_name: product.name,
              base_unit: product.unit,
            },
          }
        : {}),
    pack_price: Math.round(priceN * 100) / 100,
    pack_size: sizeN,
    pack_unit: (UNITS as ReadonlyArray<string>).includes(unit)
      ? (unit as RawUnit)
      : null,
    units_per_case: perCaseN,
    ...(withDescription ? { raw_description: description.trim() } : {}),
  })

  return (
    <form
      className="space-y-3 rounded-lg bg-soft/60 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit(value(), !withDescription)
      }}
    >
      {withDescription && (
        <Field label="What they wrote">
          <input
            className="input"
            value={description}
            placeholder="e.g. Whole milk 2L at 1.75"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      )}
      <div className="space-y-1">
        <span className="label">Product</span>
        {product && !searching ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {product.kind === 'new'
                ? `New product: ${product.name}`
                : product.name}
            </span>
            {product.kind === 'new' && (
              <select
                className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
                aria-label="Priced per"
                value={product.unit}
                onChange={(e) =>
                  setProduct({ ...product, unit: e.target.value as BaseUnit })
                }
              >
                <option value="ml">priced per litre</option>
                <option value="g">priced per kg</option>
                <option value="each">priced each</option>
              </select>
            )}
            <button
              type="button"
              className="btn-ghost px-3 py-1"
              onClick={() => setSearching(true)}
            >
              Change
            </button>
          </div>
        ) : (
          <ProductSearch
            initial={product?.name ?? ''}
            autoFocus={!withDescription}
            onSelect={(p: ProductOption) => {
              setProduct({ kind: 'existing', id: p.id, name: p.canonical_name })
              setSearching(false)
            }}
            onCreate={(name) => {
              setProduct({ kind: 'new', name, unit: baseOf(unit || null) })
              setSearching(false)
            }}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Price per pack €">
          <input
            className="input"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field label="Units per case">
          <input
            className="input"
            inputMode="numeric"
            value={perCase}
            onChange={(e) => setPerCase(e.target.value)}
          />
        </Field>
        <Field label="Size">
          <input
            className="input"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </Field>
        <Field label="Unit">
          <select
            className="input"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="">unknown</option>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {unit && sizeN != null && (
        <p className="text-xs text-muted">
          Pack:{' '}
          {packLabel({
            pack_size: sizeN,
            pack_unit: unit,
            units_per_case: perCaseN || 1,
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {withDescription ? (
          <button className="btn-primary" disabled={!valid || busy !== null}>
            {busy === 'add' && <Spinner className="h-4 w-4" />}
            Add line
          </button>
        ) : (
          <>
            <button className="btn-primary" disabled={!valid || busy !== null}>
              {busy === 'apply' && <Spinner className="h-4 w-4" />}
              Save and apply
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!valid || busy !== null}
              onClick={() => valid && onSubmit(value(), false)}
            >
              {busy === 'edit' && <Spinner className="h-4 w-4" />}
              Save
            </button>
          </>
        )}
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

function AddLine({ replyId }: { replyId: string }) {
  const [open, setOpen] = useState(false)
  const act = useAction()
  return (
    <div className="space-y-3 border-t border-line px-4 py-3">
      <button
        className="btn-ghost -ml-3 px-3 py-1.5"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? 'close' : 'pencil'} className="h-4 w-4" />
        {open ? 'Cancel' : 'Add a line by hand'}
      </button>
      {open && (
        <LineForm
          withDescription
          busy={act.busy}
          onSubmit={(v) =>
            void act
              .run('add', () =>
                addReplyLineByHand({
                  data: {
                    reply_id: replyId,
                    raw_description: v.raw_description ?? '',
                    product_id: v.product_id ?? null,
                    new_product: v.new_product ?? null,
                    pack_price: v.pack_price,
                    pack_size: v.pack_size,
                    pack_unit: v.pack_unit,
                    units_per_case: v.units_per_case,
                  },
                }),
              )
              .then((ok) => ok && setOpen(false))
          }
        />
      )}
      {act.error && (
        <p role="alert" className="text-sm text-rust">
          {act.error}
        </p>
      )}
    </div>
  )
}
