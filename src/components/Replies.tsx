import { useEffect, useRef, useState } from 'react'
import { Icon, Spinner } from '#/components/Icon'
import { postJSON } from '#/lib/api'
import { getReplies, retryReply } from '#/server/fns'

type Overview = Awaited<ReturnType<typeof getReplies>>
type Reply = Overview['replies'][number]

const POLL_MS = 5000

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
  })
}

const HOW: Record<string, string> = {
  // Also used for Gmail replies tied to a request by their thread.
  plus_address: 'matched to your request',
  sender_email: 'matched by sender address',
  sender_domain: 'matched by sender company',
  manual: 'assigned by you',
}

function summary(r: Reply): string {
  const bits: Array<string> = []
  if (r.quote_lines > 0)
    bits.push(`${r.quote_lines} price${r.quote_lines === 1 ? '' : 's'} added`)
  if (r.invoices_read > 0)
    bits.push(
      `${r.invoices_read} invoice${r.invoices_read === 1 ? '' : 's'} read`,
    )
  if (bits.length === 0) bits.push('no prices in this reply')
  return bits.join(' · ')
}

interface ReplyCheck {
  status: 'checked' | 'skipped' | 'failed'
  reason: string | null
  checked_at: string | null
  new_replies: number
}

/**
 * Supplier replies to requests Shelfie sent, read from the owner's Gmail. The app checks
 * Gmail every few minutes (see __root); this list refreshes itself from the database so a
 * reply shows up as soon as it is read, and tells the page when one was.
 */
export function Replies({
  initial,
  onRead,
}: {
  initial: Overview
  onRead: () => void
}) {
  const [data, setData] = useState(initial)
  const onReadRef = useRef(onRead)
  onReadRef.current = onRead
  const readCount = useRef(
    initial.replies.filter((r) => r.status === 'processed').length,
  )

  useEffect(() => {
    let live = true
    const tick = () => {
      if (document.hidden) return
      void getReplies()
        .then((next) => {
          if (!live) return
          setData(next)
          const done = next.replies.filter(
            (r) => r.status === 'processed',
          ).length
          if (done !== readCount.current) {
            readCount.current = done
            onReadRef.current()
          }
        })
        .catch(() => undefined)
    }
    const timer = setInterval(tick, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const { replies, suppliers } = data
  const [check, setCheck] = useState<ReplyCheck | null>(null)
  const [checking, setChecking] = useState(false)

  async function checkNow() {
    setChecking(true)
    try {
      const res = await postJSON<ReplyCheck>('/api/email/replies', {
        force: true,
      })
      setCheck(res)
      setData(await getReplies())
    } catch (e) {
      setCheck({
        status: 'failed',
        reason: e instanceof Error ? e.message : 'Could not check Gmail',
        checked_at: null,
        new_replies: 0,
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <section id="replies" className="scroll-mt-20 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Replies</h2>
          <p className="text-sm text-muted">
            When a supplier answers a quote or match request with a quote, price
            list or invoice, Shelfie reads it from your Gmail and updates your
            prices.
          </p>
        </div>
        <button
          className="btn-secondary"
          disabled={checking}
          onClick={() => void checkNow()}
        >
          {checking ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Icon name="mail" className="h-4 w-4" />
          )}
          {checking ? 'Checking Gmail…' : 'Check Gmail now'}
        </button>
      </div>
      {check && (
        <p
          role="status"
          className={`text-sm ${check.status === 'failed' ? 'text-rust' : 'text-muted'}`}
        >
          {check.status === 'checked'
            ? check.new_replies > 0
              ? `Found ${check.new_replies} new repl${check.new_replies === 1 ? 'y' : 'ies'}.`
              : 'Checked Gmail: no new replies.'
            : check.reason}
        </p>
      )}
      {data.undelivered.length > 0 && (
        <ul className="space-y-1.5">
          {data.undelivered.map((u) => (
            <li
              key={u.id}
              className="flex gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-sm text-warn"
            >
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <b className="font-semibold">
                  {u.subject ? `“${u.subject}”` : 'A request'}
                  {u.suppliers ? ` to ${u.suppliers.name}` : ''}
                </b>
                : {u.send_error} Check the address in Settings or on the
                supplier.
              </span>
            </li>
          ))}
        </ul>
      )}
      {replies.length === 0 ? (
        <p className="card px-4 py-5 text-sm text-muted">
          No replies yet. Send a request with the email button on an item: when
          the supplier answers, their reply shows up here.
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {replies.map((r) => (
            <ReplyRow
              key={r.id}
              reply={r}
              suppliers={suppliers}
              onChanged={() => void getReplies().then(setData)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function ReplyRow({
  reply: r,
  suppliers,
  onChanged,
}: {
  reply: Reply
  suppliers: Overview['suppliers']
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function run(supplierId?: string) {
    setBusy(true)
    setErr(null)
    try {
      await retryReply({ data: { id: r.id, supplier_id: supplierId } })
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read it')
    } finally {
      setBusy(false)
    }
  }

  const reading = r.status === 'received'
  const tone =
    r.status === 'processed'
      ? 'bg-brand-soft text-brand'
      : reading
        ? 'bg-soft text-muted'
        : 'bg-rust-soft text-rust'
  const who = r.supplier_name ?? r.from_name ?? r.from_email

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}`}
      >
        {reading ? (
          <Spinner className="h-5 w-5" />
        ) : (
          <Icon
            name={
              r.status === 'processed'
                ? 'check'
                : r.status === 'failed'
                  ? 'alert'
                  : 'mail'
            }
            className="h-5 w-5"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-semibold">{who}</span>
          <span className="text-xs text-muted">{ago(r.received_at)}</span>
        </p>
        <p className="truncate text-sm text-muted">
          {r.subject || '(no subject)'}
          {r.attachment_names.length > 0 &&
            ` · ${r.attachment_names.join(', ')}`}
        </p>
        <p className="mt-0.5 text-sm">
          {r.status === 'processed' && (
            <>
              <span className="text-muted">{summary(r)}</span>
              {r.better_quotes > 0 && (
                <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {r.better_quotes} better deal
                  {r.better_quotes === 1 ? '' : 's'}
                </span>
              )}
            </>
          )}
          {reading && <span className="text-muted">Reading the reply...</span>}
          {r.status === 'failed' && (
            <span className="text-rust">
              {r.error ?? "Couldn't read this reply"}
            </span>
          )}
          {r.status === 'unmatched' && (
            <span className="text-warn">
              We could not tell which supplier this is from. Pick one to read
              it.
            </span>
          )}
        </p>
        {r.status === 'processed' && r.error && (
          <p className="text-sm text-warn">{r.error}</p>
        )}
        {r.match_method && r.status !== 'unmatched' && (
          <p className="text-xs text-muted">
            {HOW[r.match_method]}
            {r.request_subject ? `: ${r.request_subject}` : ''}
          </p>
        )}
        {err && <p className="text-sm text-rust">{err}</p>}
        {r.status === 'unmatched' && (
          <div className="mt-2 flex flex-wrap gap-2">
            <select
              className="rounded-lg border border-line bg-card px-2 py-1.5 text-sm"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              aria-label="Supplier this reply is from"
            >
              <option value="">Choose supplier...</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              className="btn-secondary px-3 py-1.5"
              disabled={!pick || busy}
              onClick={() => void run(pick)}
            >
              {busy ? 'Reading...' : 'Read it'}
            </button>
          </div>
        )}
      </div>
      {r.status === 'failed' && (
        <button
          className="btn-secondary px-3 py-1.5"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? 'Reading...' : 'Retry'}
        </button>
      )}
    </li>
  )
}
