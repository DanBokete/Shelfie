// Drafts one email per request, lets the owner edit it, then sends it from Shelfie.
// Two kinds: "match" asks a current supplier to match a lower price; "quote" asks a seller
// found online for their trade prices. Each draft is written from the owner's template or by
// Claude (the default is in Settings), and can be redone the other way.
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Icon, Spinner } from './Icon'
import { postJSON } from '#/lib/api'
import { dateTime } from '#/lib/format'
import type { Writer } from '#/lib/templates'
import { openSavedDraft, saveDraft } from '#/server/fns'

export interface EmailItem {
  product_id?: string
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
  | {
      /** A request saved earlier (a draft, or one that failed): opened as it is, no rewrite. */
      kind: 'saved'
      draft_id: string
      email_kind: 'match' | 'quote'
      supplier_name: string
      products: Array<string>
      /** A reminder: sent as a reply in the thread of the request it follows up. */
      follow_up?: boolean
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
  /** Who wrote it: the owner's template or Claude. */
  writer: Writer
  subject: string
  body: string
  supplier: { email: string | null }
  /** Shelfie's inbound address for this draft, CC'd so the reply reaches the app. */
  reply_cc?: string | null
  /** The owner's own address from Settings, BCC'd so they keep a copy. */
  reply_bcc?: string | null
  /** Whether Shelfie can send, and if not, what to set up. */
  sending: { ready: boolean; problem: string | null }
  /** What the email asks for, per product: the buy price we want and the percentage cut. */
  asks?: Array<{
    product_name: string
    pack_label: string
    target: number
    percent: number
    basis: 'profit' | 'found_price'
  }>
  contact?: Contact
}

interface Draft {
  state: 'drafting' | 'ready' | 'failed'
  id?: string
  writer?: Writer
  /** The writer asked for on the last attempt; undefined means the Settings default. */
  tried?: Writer
  /** Rewriting this draft the other way. */
  redoing?: Writer
  redoError?: string
  to: string
  subject: string
  body: string
  cc?: string | null
  bcc?: string | null
  asks?: DraftResponse['asks']
  contact?: Contact
  error?: string
  sending?: { ready: boolean; problem: string | null }
  send: 'idle' | 'sending' | 'sent'
  sendError?: string
  sentAt?: string
}

function nameOf(r: EmailRequest): string {
  return r.kind === 'quote' ? r.seller_name : r.supplier_name
}

function keyOf(r: EmailRequest): string {
  return r.kind === 'match'
    ? r.supplier_id
    : r.kind === 'quote'
      ? r.offer_id
      : r.draft_id
}

function bodyOf(r: Exclude<EmailRequest, { kind: 'saved' }>) {
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

  function fromResponse(r: DraftResponse, to: string): Partial<Draft> {
    return {
      state: 'ready',
      id: r.id,
      writer: r.writer,
      subject: r.subject,
      body: r.body,
      to,
      cc: r.reply_cc ?? null,
      bcc: r.reply_bcc ?? null,
      sending: r.sending,
      asks: r.asks,
      contact: r.contact,
    }
  }

  function draft(i: number, writer?: Writer) {
    patch(i, { state: 'drafting', error: undefined, tried: writer })
    const req = requests[i]
    if (req.kind === 'saved') {
      openSavedDraft({ data: { id: req.draft_id } })
        .then((r) =>
          patch(i, {
            state: 'ready',
            id: r.id,
            subject: r.subject,
            body: r.body,
            to: r.to,
            cc: r.reply_cc,
            bcc: r.reply_bcc,
            sending: r.sending,
          }),
        )
        .catch((e: unknown) =>
          patch(i, {
            state: 'failed',
            error: e instanceof Error ? e.message : 'Could not open the email',
          }),
        )
      return
    }
    postJSON<DraftResponse>('/api/email/draft', {
      ...bodyOf(req),
      writer,
    })
      .then((r) => patch(i, fromResponse(r, r.supplier.email ?? '')))
      .catch((e: unknown) =>
        patch(i, {
          state: 'failed',
          error: e instanceof Error ? e.message : 'Could not draft the email',
        }),
      )
  }

  /** Rewrites a ready draft the other way, in place. The To the owner typed is kept. */
  function redo(i: number, writer: Writer) {
    const current = drafts[i]
    const req = requests[i]
    if (!current.id || req.kind === 'saved') return
    patch(i, { redoing: writer, redoError: undefined })
    postJSON<DraftResponse>('/api/email/draft', {
      ...bodyOf(req),
      writer,
      redo_of: current.id,
    })
      .then((r) =>
        setDrafts((ds) =>
          ds.map((x, j) =>
            j === i
              ? {
                  ...x,
                  ...fromResponse(
                    r,
                    x.to.trim() ? x.to : (r.supplier.email ?? ''),
                  ),
                  redoing: undefined,
                }
              : x,
          ),
        ),
      )
      .catch((e: unknown) =>
        patch(i, {
          redoing: undefined,
          redoError:
            e instanceof Error ? e.message : 'Could not rewrite the email',
        }),
      )
  }

  // Strict Mode runs effects twice in development; without this each open saved two drafts.
  const started = useRef(false)
  useEffect(() => {
    if (!started.current) {
      started.current = true
      requests.forEach((_, i) => draft(i))
    }
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
  const quote =
    r.kind === 'quote' || (r.kind === 'saved' && r.email_kind === 'quote')

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
    !d.redoing &&
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
              {r.kind === 'saved' && r.follow_up
                ? 'Send a reminder'
                : quote
                  ? 'Ask for a quote'
                  : 'Ask to match'}
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
                key={keyOf(x)}
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
              {r.kind === 'saved'
                ? 'Opening your email...'
                : quote
                  ? `Finding how to reach ${nameOf(r)} and writing your quote request...`
                  : `Writing a friendly, firm email to ${nameOf(r)}...`}
            </div>
          )}
          {d.state === 'failed' && (
            <div className="space-y-3 py-8 text-center">
              <p className="text-rust">{d.error}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  className="btn-secondary"
                  onClick={() => draft(tab, d.tried)}
                >
                  Try again
                </button>
                {d.tried !== 'template' && (
                  <button
                    className="btn-secondary"
                    onClick={() => draft(tab, 'template')}
                  >
                    Write from my template
                  </button>
                )}
              </div>
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
              {d.writer && (
                <WriterSwitch
                  writer={d.writer}
                  redoing={d.redoing}
                  error={d.redoError}
                  onRedo={(w) => redo(tab, w)}
                />
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
                  readOnly={Boolean(d.redoing)}
                  onChange={(e) => patch(tab, { subject: e.target.value })}
                />
              </label>
              <label className="block space-y-1">
                <span className="label">Message</span>
                <textarea
                  className={`input min-h-72 resize-y leading-relaxed ${d.redoing ? 'opacity-60' : ''}`}
                  value={d.body}
                  readOnly={Boolean(d.redoing)}
                  onChange={(e) => patch(tab, { body: e.target.value })}
                />
              </label>
              <details className="text-sm text-muted">
                <summary className="cursor-pointer">
                  Figures in this email
                </summary>
                <ul className="mt-2 space-y-1">
                  {r.kind === 'saved' ? (
                    <li>
                      {r.products.length > 0
                        ? `About ${r.products.join(', ')}. `
                        : ''}
                      {r.follow_up
                        ? 'A reply in the same email thread as your request, which is quoted below with its figures.'
                        : 'Saved as you left it: the figures were worked out when it was first written.'}
                    </li>
                  ) : r.kind === 'match' ? (
                    d.asks ? (
                      d.asks.map((a) => (
                        <li key={a.product_name}>
                          {a.product_name} ({a.pack_label}): asks for €
                          {a.target.toFixed(2)}, {a.percent}% lower.{' '}
                          {a.basis === 'profit'
                            ? 'Worked out from your selling price so you keep your profit.'
                            : 'Based on the better price found. Add your selling price on the item screen for a profit-based target.'}
                        </li>
                      ))
                    ) : (
                      <li>Working out what to ask for...</li>
                    )
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
                disabled={d.state !== 'ready' || Boolean(d.redoing)}
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

/** "Written from your template · Rewrite with AI", and the other way round. */
function WriterSwitch({
  writer,
  redoing,
  error,
  onRedo,
}: {
  writer: Writer
  redoing?: Writer
  error?: string
  onRedo: (w: Writer) => void
}) {
  const other: Writer = writer === 'template' ? 'ai' : 'template'
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="text-muted">
          {redoing
            ? redoing === 'ai'
              ? 'Rewriting with AI…'
              : 'Rewriting from your template…'
            : writer === 'template'
              ? 'Written from your template'
              : 'Written by AI (Claude)'}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-brand hover:bg-soft disabled:opacity-50"
          disabled={Boolean(redoing)}
          onClick={() => onRedo(other)}
        >
          {redoing && <Spinner className="h-3.5 w-3.5" />}
          {other === 'ai' ? 'Rewrite with AI' : 'Use my template'}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-rust-soft px-3 py-2 text-sm text-rust"
        >
          {error}
        </p>
      )}
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
