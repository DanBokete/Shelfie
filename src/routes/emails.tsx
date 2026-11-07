// Every email that still needs something: requests waiting for a reply, drafts never sent,
// sends that failed, replies the owner has to review, and what each supplier answered.
// Reading only: no Claude calls.
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { EmailModal } from '#/components/EmailModal'
import type { EmailRequest } from '#/components/EmailModal'
import { Icon, Spinner } from '#/components/Icon'
import type { IconName } from '#/components/Icon'
import { dateTime, shortDate, timeAgo } from '#/lib/format'
import type {
  AnsweredEmail,
  FailedEmail,
  PendingDraft,
  RequestAnswer,
  ReviewReply,
  WaitingEmail,
} from '#/lib/pending-emails'
import {
  createReminder,
  discardPendingEmail,
  getPendingEmails,
} from '#/server/fns'

export const Route = createFileRoute('/emails')({
  loader: () => getPendingEmails(),
  component: EmailsPage,
  head: () => ({ meta: [{ title: 'Emails - Shelfie' }] }),
})

const KIND: Record<PendingDraft['kind'], string> = {
  match: 'Ask to match',
  quote: 'Ask for a quote',
}

function EmailsPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [open, setOpen] = useState<EmailRequest | null>(null)
  const refresh = () => void router.invalidate()

  const edit = (d: PendingDraft) =>
    setOpen({
      kind: 'saved',
      draft_id: d.id,
      email_kind: d.kind,
      supplier_name: d.supplier_name ?? d.to_email ?? 'the supplier',
      products: d.products,
      follow_up: Boolean(d.follow_up_of),
    })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Emails</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Everything you have asked suppliers and sellers that still needs
          something: a reply, a send or a look from you.
        </p>
      </div>

      {data.not_honoured.length > 0 && (
        <Section
          id="not-honoured"
          title="Prices not honoured"
          count={data.not_honoured.length}
          note="A supplier agreed a price in a reply, then charged more on their next invoice."
          empty=""
        >
          {data.not_honoured.map((b) => (
            <Row key={`${b.product_id}:${b.supplier_id}`}>
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-rust-soft text-rust">
                  <Icon name="alert" className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold break-words">{b.text}</p>
                  <p className="text-sm text-muted">
                    Invoice of {shortDate(b.invoice_on)}
                  </p>
                </div>
              </div>
              <Actions>
                <Link
                  to="/item/$productId"
                  params={{ productId: b.product_id }}
                  className="btn-secondary px-3 py-1.5"
                >
                  Open item
                  <Icon name="arrowRight" className="h-4 w-4" />
                </Link>
              </Actions>
            </Row>
          ))}
        </Section>
      )}

      <Section
        id="review"
        title="Replies to review"
        count={data.review.length}
        note="Prices and invoices in a reply change nothing until you apply them."
        empty="No replies need you. When a supplier replies, what they offer waits here for you to apply or reject."
      >
        {data.review.map((r) => (
          <ReviewRow key={r.id} reply={r} />
        ))}
      </Section>

      <Section
        id="waiting"
        title="Waiting for a reply"
        count={data.waiting.length}
        note={`Marked when there is no reply after ${data.reply_by_days} day${data.reply_by_days === 1 ? '' : 's'}, the reply-by time in Settings.`}
        empty="No requests waiting. When you send one, it stays here until the supplier replies."
      >
        {data.waiting.map((w) => (
          <WaitingRow
            key={w.id}
            email={w}
            replyByDays={data.reply_by_days}
            onRemind={(id) => edit({ ...w, id, follow_up_of: w.id })}
          />
        ))}
      </Section>

      <Section
        id="answered"
        title="Answered"
        count={data.answered.length}
        empty="No answers yet. When a supplier replies to a request, what they said shows here."
      >
        {data.answered.map((a) => (
          <AnsweredRow key={a.id} email={a} />
        ))}
      </Section>

      <Section
        id="drafts"
        title="Drafts not sent"
        count={data.drafts.length}
        empty="No drafts. Emails you write but don't send are kept here."
      >
        {data.drafts.map((d) => (
          <DraftRow
            key={d.id}
            email={d}
            onEdit={() => edit(d)}
            onDiscarded={refresh}
          />
        ))}
      </Section>

      <Section
        id="failed"
        title="Failed to send"
        count={data.failed.length}
        empty="Nothing failed. If an email can't be sent or delivered, it shows up here."
      >
        {data.failed.map((f) => (
          <FailedRow
            key={f.id}
            email={f}
            onRetry={() => edit(f)}
            onDiscarded={refresh}
          />
        ))}
      </Section>

      {open && (
        <EmailModal
          requests={[open]}
          onClose={() => {
            setOpen(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function Section({
  id,
  title,
  count,
  note,
  empty,
  children,
}: {
  id: string
  title: string
  count: number
  note?: string
  empty: string
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          {title}
          {count > 0 && (
            <span className="chip num" aria-label={`${count} emails`}>
              {count}
            </span>
          )}
        </h2>
        {note && count > 0 && <p className="text-sm text-muted">{note}</p>}
      </div>
      {count === 0 ? (
        <p className="card px-4 py-5 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="card divide-y divide-line">{children}</ul>
      )}
    </section>
  )
}

/** The round icon, who it is to, what kind, and the subject and products. */
function Summary({
  icon,
  tone,
  email,
  when,
  children,
}: {
  icon: IconName
  tone: string
  email: PendingDraft
  when: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <span
        className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}`}
      >
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-semibold">
            {email.supplier_name ?? email.to_email ?? 'No supplier'}
          </span>
          <span className="text-xs text-muted">
            {email.follow_up_of ? 'Reminder' : KIND[email.kind]} · {when}
          </span>
        </p>
        <p className="text-sm break-words sm:truncate">
          {email.subject || '(no subject)'}
        </p>
        {email.products.length > 0 && (
          <p className="truncate text-sm text-muted">
            {email.products.join(', ')}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2 pl-12 sm:pl-0">
      {children}
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
      {children}
    </li>
  )
}

function WaitingRow({
  email: w,
  replyByDays,
  onRemind,
}: {
  email: WaitingEmail
  replyByDays: number
  /** Opens the reminder draft (made now, or the one already drafted) in the email window. */
  onRemind: (reminderId: string) => void
}) {
  const [showing, setShowing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function remind() {
    setBusy(true)
    setErr(null)
    try {
      const { id } = await createReminder({ data: { id: w.id } })
      onRemind(id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not write the reminder')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row>
      <Summary
        icon="mail"
        tone="bg-soft text-muted"
        email={w}
        when={`sent ${timeAgo(w.sent_at)}`}
      >
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="chip">Waiting</span>
          {w.overdue && (
            <span className="chip bg-warn-soft text-warn">
              <Icon name="alert" className="h-3 w-3" />
              No reply after {w.days} day{w.days === 1 ? '' : 's'}
            </span>
          )}
          {w.last_reminder_at && (
            <span className="chip">
              {w.reminders === 1 ? 'Reminder' : `${w.reminders} reminders`} sent{' '}
              {timeAgo(w.last_reminder_at)}
            </span>
          )}
        </p>
        {err && (
          <p role="alert" className="mt-1 text-sm text-rust">
            {err}
          </p>
        )}
        {showing && (
          <div className="mt-3 space-y-2 rounded-lg bg-soft/60 px-3 py-2.5 text-sm">
            <p className="text-xs text-muted">
              To {w.to_email ?? 'no address'} · {dateTime(w.sent_at)}
              {!w.overdue &&
                ` · reply asked within ${replyByDays} day${replyByDays === 1 ? '' : 's'}`}
            </p>
            <p className="font-semibold">{w.subject || '(no subject)'}</p>
            <p className="break-words whitespace-pre-wrap">{w.body}</p>
          </div>
        )}
      </Summary>
      <Actions>
        <button
          className="btn-secondary px-3 py-1.5"
          aria-expanded={showing}
          onClick={() => setShowing((s) => !s)}
        >
          {showing ? 'Hide email' : 'View email'}
        </button>
        <button
          className={`${w.overdue ? 'btn-primary' : 'btn-secondary'} px-3 py-1.5`}
          disabled={busy}
          onClick={() => void remind()}
        >
          {busy ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Icon name="mail" className="h-4 w-4" />
          )}
          Send a reminder
        </button>
      </Actions>
    </Row>
  )
}

function DraftRow({
  email: d,
  onEdit,
  onDiscarded,
}: {
  email: PendingDraft
  onEdit: () => void
  onDiscarded: () => void
}) {
  return (
    <Row>
      <Summary
        icon="pencil"
        tone="bg-soft text-muted"
        email={d}
        when={`written ${timeAgo(d.created_at)}`}
      >
        {!d.to_email && (
          <p className="mt-1 text-sm text-warn">No address yet.</p>
        )}
      </Summary>
      <Actions>
        <button className="btn-primary px-3 py-1.5" onClick={onEdit}>
          <Icon name="mail" className="h-4 w-4" />
          Edit and send
        </button>
        <Discard id={d.id} onDiscarded={onDiscarded} />
      </Actions>
    </Row>
  )
}

function FailedRow({
  email: f,
  onRetry,
  onDiscarded,
}: {
  email: FailedEmail
  onRetry: () => void
  onDiscarded: () => void
}) {
  return (
    <Row>
      <Summary
        icon="alert"
        tone="bg-rust-soft text-rust"
        email={f}
        when={
          f.bounced && f.sent_at
            ? `sent ${timeAgo(f.sent_at)}`
            : `written ${timeAgo(f.created_at)}`
        }
      >
        <p className="mt-1 text-sm break-words text-rust">
          {f.bounced ? f.reason : `Not sent. ${f.reason}`}
        </p>
      </Summary>
      <Actions>
        <button className="btn-primary px-3 py-1.5" onClick={onRetry}>
          <Icon name="pencil" className="h-4 w-4" />
          {f.bounced ? 'Fix and resend' : 'Fix and retry'}
        </button>
        <Discard id={f.id} onDiscarded={onDiscarded} />
      </Actions>
    </Row>
  )
}

/** "Discard", then "Delete this email?" with Delete and Keep, so one tap never deletes. */
function Discard({ id, onDiscarded }: { id: string; onDiscarded: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function discard() {
    setBusy(true)
    setErr(null)
    try {
      await discardPendingEmail({ data: { id } })
      onDiscarded()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete it')
      setBusy(false)
    }
  }

  if (!confirming)
    return (
      <button
        className="btn-ghost px-3 py-1.5"
        onClick={() => setConfirming(true)}
      >
        Discard
      </button>
    )
  return (
    <span
      role="group"
      aria-label="Delete this email?"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-sm text-muted">Delete it?</span>
      <button
        className="btn px-3 py-1.5 text-rust hover:bg-rust-soft"
        disabled={busy}
        onClick={() => void discard()}
      >
        {busy && <Spinner className="h-3.5 w-3.5" />}
        Delete
      </button>
      <button
        className="btn-ghost px-3 py-1.5"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Keep
      </button>
      {err && (
        <span role="alert" className="w-full text-sm text-rust">
          {err}
        </span>
      )}
    </span>
  )
}

function ReviewRow({ reply: r }: { reply: ReviewReply }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${
            r.status === 'failed'
              ? 'bg-rust-soft text-rust'
              : r.status === 'proposed'
                ? 'bg-brand-soft text-brand'
                : 'bg-warn-soft text-warn'
          }`}
        >
          <Icon
            name={
              r.status === 'failed'
                ? 'alert'
                : r.status === 'proposed'
                  ? 'check'
                  : 'mail'
            }
            className="h-5 w-5"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-semibold">
              {r.supplier_name ?? r.from}
            </span>
            <span className="text-xs text-muted">
              Reply · {timeAgo(r.received_at)}
            </span>
          </p>
          <p className="text-sm break-words sm:truncate">
            {r.subject || '(no subject)'}
          </p>
          {r.outcome_label && (
            <p className="mt-1.5">
              <span className="chip">{r.outcome_label}</span>
            </p>
          )}
          <p
            className={`mt-1 text-sm ${
              r.status === 'failed'
                ? 'text-rust'
                : r.status === 'proposed'
                  ? 'text-muted'
                  : 'text-warn'
            }`}
          >
            {r.reason}
          </p>
        </div>
      </div>
      <Actions>
        {r.status === 'proposed' ? (
          <Link
            to="/replies/$id"
            params={{ id: r.id }}
            className="btn-primary px-3 py-1.5"
          >
            Review
            <Icon name="arrowRight" className="h-4 w-4" />
          </Link>
        ) : (
          <Link
            to="/invoices"
            hash="replies"
            className="btn-secondary px-3 py-1.5"
          >
            Open in Replies
            <Icon name="arrowRight" className="h-4 w-4" />
          </Link>
        )}
      </Actions>
    </Row>
  )
}

const ANSWER_TONE: Record<RequestAnswer['answers'][number]['outcome'], string> =
  {
    accepted: 'bg-good-soft text-good',
    counter_offer: 'bg-brand-soft text-brand',
    declined: 'bg-rust-soft text-rust',
    needs_info: 'bg-warn-soft text-warn',
    unclear: 'bg-soft text-muted',
  }

function AnsweredRow({ email: a }: { email: AnsweredEmail }) {
  const several = (a.answer?.answers.length ?? 0) > 1
  return (
    <Row>
      <Summary
        icon="mail"
        tone="bg-brand-soft text-brand"
        email={a}
        when={`replied ${timeAgo(a.replied_at)}`}
      >
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          {a.answer ? (
            a.answer.answers.map((x, i) => (
              <span key={i} className={`chip ${ANSWER_TONE[x.outcome]}`}>
                {several && x.product_name ? `${x.product_name}: ` : ''}
                {x.label}
              </span>
            ))
          ) : (
            <span className="chip">Reply not read yet</span>
          )}
        </p>
        {a.answer?.answers
          .filter((x) => x.question)
          .map((x, i) => (
            <p key={i} className="mt-1 text-sm text-warn">
              They asked: {x.question}
            </p>
          ))}
      </Summary>
      <Actions>
        <Link
          to="/replies/$id"
          params={{ id: a.reply_id }}
          className="btn-secondary px-3 py-1.5"
        >
          Open reply
          <Icon name="arrowRight" className="h-4 w-4" />
        </Link>
      </Actions>
    </Row>
  )
}
