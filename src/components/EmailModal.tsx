// Drafts one email per request, lets the owner edit it, then sends it from Shelfie (Postmark).
// Two kinds: "match" asks a current supplier to match a lower price; "quote" asks a seller
// found online for their trade prices.
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Icon, Spinner } from './Icon'
import { postJSON } from '#/lib/api'
import { dateTime } from '#/lib/format'
import { saveDraft } from '#/server/fns'

export interface EmailItem {
  product_name: string
  pack_label: string
  your_price: number
  best_price: number
  weekly_quantity: number | null
}

export type EmailRequest =
  | {
      kind: 'match'
      supplier_id: string
      supplier_name: string
      items: Array<EmailItem>
    }
  | {
      kind: 'quote'
      offer_id: string
      seller_name: string
      product_name: string
      price_seen: string
    }

interface Contact {
  sells_to_trade: 'yes' | 'no' | 'unknown'
  email: string | null
  phone: string | null
  contact_source_url: string | null
  note: string | null
  website: string | null
  lookup_error: string | null
}

interface DraftResponse {
  id: string
  subject: string
  body: string
  supplier: { email: string | null }
  /** Shelfie's inbound address for this draft, CC'd so the reply reaches the app. */
  reply_cc?: string | null
  /** The owner's own address from Settings, BCC'd so they keep a copy. */
  reply_bcc?: string | null
  /** Whether Shelfie can send, and if not, what to set up. */
  sending: { ready: boolean; problem: string | null }
  contact?: Contact
}

interface Draft {
  state: 'drafting' | 'ready' | 'failed'
  id?: string
  to: string
  subject: string
  body: string
  cc?: string | null
  bcc?: string | null
  contact?: Contact
  error?: string
  sending?: { ready: boolean; problem: string | null }
  send: 'idle' | 'sending' | 'sent'
  sendError?: string
  sentAt?: string
}

function nameOf(r: EmailRequest): string {
  return r.kind === 'match' ? r.supplier_name : r.seller_name
}

function bodyOf(r: EmailRequest) {
  return r.kind === 'match'
    ? { kind: 'match', supplier_id: r.supplier_id, items: r.items }
    : { kind: 'quote', offer_id: r.offer_id }
}

export function EmailModal({
  requests,
  onClose,
}: {
  requests: Array<EmailRequest>
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Array<Draft>>(() =>
    requests.map(() => ({
      state: 'drafting',
      to: '',
      subject: '',
      body: '',
      send: 'idle',
    })),
  )
  const [tab, setTab] = useState(0)
  const [copied, setCopied] = useState(false)

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)))

  function draft(i: number) {
    patch(i, { state: 'drafting', error: undefined })
    postJSON<DraftResponse>('/api/email/draft', bodyOf(requests[i]))
      .then((r) =>
        patch(i, {
          state: 'ready',
          id: r.id,
          subject: r.subject,
          body: r.body,
          to: r.supplier.email ?? '',
          cc: r.reply_cc ?? null,
          bcc: r.reply_bcc ?? null,
          sending: r.sending,
          contact: r.contact,
        }),
      )
      .catch((e: unknown) =>
        patch(i, {
          state: 'failed',
          error: e instanceof Error ? e.message : 'Could not draft the email',
        }),
      )
  }

  useEffect(() => {
    requests.forEach((_, i) => draft(i))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
    // Draft once per open: the modal is mounted fresh each time it opens.
  }, [])

  const d = drafts[tab]
  const r = requests[tab]
  const quote = r.kind === 'quote'

  function persist(status: 'draft') {
    if (!d.id) return
    void saveDraft({
      data: {
        id: d.id,
        subject: d.subject,
        body: d.body,
        to_email: d.to.trim() || null,
        status,
      },
    })
  }

  async function send() {
    const i = tab
    if (!d.id) return
    patch(i, { send: 'sending', sendError: undefined })
    try {
      // The server adds the CC (Shelfie's reply address) and BCC from Settings.
      const res = await postJSON<{ sent_at: string }>('/api/email/send', {
        id: d.id,
        to: d.to.trim(),
        subject: d.subject,
        body: d.body,
      })
      patch(i, { send: 'sent', sentAt: res.sent_at })
    } catch (e) {
      patch(i, {
        send: 'idle',
        sendError: e instanceof Error ? e.message : 'Could not send the email',
      })
    }
  }

  const sent = d.send === 'sent'
  const canSend =
    d.state === 'ready' &&
    d.send === 'idle' &&
    Boolean(d.sending?.ready) &&
    d.to.trim() !== ''

  async function copy() {
    await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`)
    persist('draft')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Email draft"
        className="flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-3xl bg-card shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">
              {quote ? 'Ask for a quote' : 'Ask to match'}
            </h2>
            <p className="truncate text-sm text-muted">
              {requests.length > 1
                ? `${requests.length} emails, one per supplier`
                : `To ${nameOf(r)}`}
            </p>
          </div>
          <button
            className="btn-ghost p-2"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </header>

        {requests.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
            {requests.map((x, i) => (
              <button
                key={x.kind === 'match' ? x.supplier_id : x.offer_id}
                onClick={() => setTab(i)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  i === tab ? 'bg-soft text-ink' : 'text-muted hover:bg-soft'
                }`}
              >
                {drafts[i].state === 'drafting' && (
                  <Spinner className="h-3.5 w-3.5" />
                )}
                {drafts[i].send === 'sent' && (
                  <Icon name="check" className="h-3.5 w-3.5 text-brand" />
                )}
                {nameOf(x)}
                {x.kind === 'match' && (
                  <span className="text-xs text-muted">({x.items.length})</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          {d.state === 'drafting' && (
            <div className="flex items-center gap-3 py-16 text-muted">
              <Spinner className="h-5 w-5 shrink-0" />
              {quote
                ? `Finding how to reach ${nameOf(r)} and writing your quote request...`
                : `Writing a friendly, firm email to ${nameOf(r)}...`}
            </div>
          )}
          {d.state === 'failed' && (
            <div className="space-y-3 py-8 text-center">
              <p className="text-rust">{d.error}</p>
              <button className="btn-secondary" onClick={() => draft(tab)}>
                Try again
              </button>
            </div>
          )}
          {d.state === 'ready' && sent && (
            <div className="space-y-2 py-12 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-good-soft text-good">
                <Icon name="check" className="h-6 w-6" />
              </span>
              <p className="text-lg font-semibold">Sent to {d.to}</p>
              <p className="text-sm text-muted">
                {d.sentAt && `${dateTime(d.sentAt)}. `}
                {d.cc
                  ? 'Their reply will show up under Invoices → Replies.'
                  : 'Their reply goes to your inbox.'}
              </p>
            </div>
          )}
          {d.state === 'ready' && !sent && (
            <>
              {d.sending && !d.sending.ready && (
                <p className="flex flex-wrap items-center gap-x-2 rounded-xl bg-warn-soft px-3 py-2.5 text-sm text-warn">
                  <Icon name="alert" className="h-4 w-4 shrink-0" />
                  {d.sending.problem}{' '}
                  <Link
                    to="/settings"
                    className="font-semibold underline underline-offset-2"
                  >
                    Open Settings
                  </Link>
                </p>
              )}
              {d.contact && (
                <ContactNote contact={d.contact} seller={nameOf(r)} />
              )}
              <label className="block space-y-1">
                <span className="label">To</span>
                <input
                  className="input"
                  type="email"
                  inputMode="email"
                  placeholder={
                    quote ? 'Add their trade or sales email' : 'Supplier email'
                  }
                  value={d.to}
                  onChange={(e) => patch(tab, { to: e.target.value })}
                />
                {(d.cc || d.bcc) && (
                  <span className="block text-xs text-muted">
                    {[
                      d.cc && 'Shelfie is CC’d to read the reply',
                      d.bcc && `a copy goes to ${d.bcc}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </label>
              <label className="block space-y-1">
                <span className="label">Subject</span>
                <input
                  className="input"
                  value={d.subject}
                  onChange={(e) => patch(tab, { subject: e.target.value })}
                />
              </label>
              <label className="block space-y-1">
                <span className="label">Message</span>
                <textarea
                  className="input min-h-72 resize-y leading-relaxed"
                  value={d.body}
                  onChange={(e) => patch(tab, { body: e.target.value })}
                />
              </label>
              <details className="text-sm text-muted">
                <summary className="cursor-pointer">
                  Figures in this email
                </summary>
                <ul className="mt-2 space-y-1">
                  {r.kind === 'match' ? (
                    r.items.map((it) => (
                      <li key={it.product_name}>
                        {it.product_name} ({it.pack_label}): you pay €
                        {it.your_price.toFixed(2)}, found €
                        {it.best_price.toFixed(2)}
                      </li>
                    ))
                  ) : (
                    <li>
                      {r.product_name}: seen online at {r.price_seen}. Your
                      current supplier and price are not mentioned.
                    </li>
                  )}
                </ul>
              </details>
            </>
          )}
        </div>

        {d.sendError && (
          <p
            role="alert"
            className="border-t border-line bg-rust-soft px-5 py-2.5 text-sm text-rust"
          >
            {d.sendError}
          </p>
        )}
        <footer className="flex gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {sent ? (
            <button className="btn-primary flex-1" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                className="btn-primary flex-1"
                disabled={!canSend}
                onClick={() => void send()}
              >
                {d.send === 'sending' ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <Icon name="mail" className="h-4 w-4" />
                )}
                {d.send === 'sending' ? 'Sending…' : 'Send'}
              </button>
              <button
                className="btn-secondary"
                disabled={d.state !== 'ready'}
                onClick={() => void copy()}
              >
                <Icon name={copied ? 'check' : 'copy'} className="h-4 w-4" />{' '}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function ContactNote({
  contact: c,
  seller,
}: {
  contact: Contact
  seller: string
}) {
  const link = (url: string, label: string) => (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline underline-offset-2"
    >
      {label}
    </a>
  )
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }
  return (
    <div
      className={`space-y-1 rounded-xl px-3 py-2.5 text-sm ${
        c.sells_to_trade === 'no'
          ? 'bg-warn-soft text-warn'
          : 'bg-soft/70 text-ink'
      }`}
    >
      {c.sells_to_trade === 'no' && (
        <p className="flex gap-2 font-semibold">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {seller} looks like a shop for the public, not trade. Their price is
          still useful when you talk to your supplier.
        </p>
      )}
      {c.email ? (
        <p>
          Email found
          {c.contact_source_url ? (
            <> on {link(c.contact_source_url, host(c.contact_source_url))}</>
          ) : null}
          .
        </p>
      ) : (
        <p>
          {c.lookup_error ?? 'No trade email found on their site.'}{' '}
          {c.website && <>Find one on {link(c.website, host(c.website))}.</>}
        </p>
      )}
      {c.phone && <p>Phone: {c.phone}</p>}
      {c.note && <p className="text-muted">{c.note}</p>}
    </div>
  )
}
