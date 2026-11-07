// Drafts one negotiation email per supplier, lets the owner edit it, then hands it to their mail app.
import { useEffect, useState } from 'react'
import { Icon, Spinner } from './Icon'
import { postJSON } from '#/lib/api'
import { saveDraft } from '#/server/fns'

export interface EmailItem {
  product_name: string
  pack_label: string
  your_price: number
  best_price: number
  weekly_quantity: number | null
}

export interface EmailGroup {
  supplier_id: string
  supplier_name: string
  items: Array<EmailItem>
}

interface Draft {
  state: 'drafting' | 'ready' | 'failed'
  id?: string
  to?: string | null
  subject: string
  body: string
  error?: string
  sent?: boolean
}

export function EmailModal({
  groups,
  onClose,
}: {
  groups: Array<EmailGroup>
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Array<Draft>>(() =>
    groups.map(() => ({ state: 'drafting', subject: '', body: '' })),
  )
  const [tab, setTab] = useState(0)
  const [copied, setCopied] = useState(false)

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)))

  function draft(i: number) {
    patch(i, { state: 'drafting', error: undefined })
    postJSON<{
      id: string
      subject: string
      body: string
      supplier: { email: string | null }
    }>('/api/email/draft', {
      supplier_id: groups[i].supplier_id,
      items: groups[i].items,
    })
      .then((r) =>
        patch(i, {
          state: 'ready',
          id: r.id,
          subject: r.subject,
          body: r.body,
          to: r.supplier.email,
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
    groups.forEach((_, i) => draft(i))
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
  const g = groups[tab]

  function send() {
    if (!d.id) return
    void saveDraft({
      data: { id: d.id, subject: d.subject, body: d.body, status: 'approved' },
    })
    patch(tab, { sent: true })
    window.location.href = `mailto:${encodeURIComponent(d.to ?? '')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`
  }

  async function copy() {
    await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`)
    if (d.id)
      void saveDraft({
        data: { id: d.id, subject: d.subject, body: d.body, status: 'draft' },
      })
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
          <div>
            <h2 className="text-lg font-bold">Ask to match</h2>
            <p className="text-sm text-muted">
              {groups.length > 1
                ? `${groups.length} emails, one per supplier`
                : `To ${g.supplier_name}`}
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

        {groups.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
            {groups.map((x, i) => (
              <button
                key={x.supplier_id}
                onClick={() => setTab(i)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  i === tab ? 'bg-soft text-ink' : 'text-muted hover:bg-soft'
                }`}
              >
                {drafts[i].state === 'drafting' && (
                  <Spinner className="h-3.5 w-3.5" />
                )}
                {drafts[i].sent && (
                  <Icon name="check" className="h-3.5 w-3.5 text-brand" />
                )}
                {x.supplier_name}
                <span className="text-xs text-muted">({x.items.length})</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          {d.state === 'drafting' && (
            <div className="flex items-center gap-3 py-16 text-muted">
              <Spinner /> Writing a friendly, firm email to {g.supplier_name}...
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
          {d.state === 'ready' && (
            <>
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
                  {g.items.map((it) => (
                    <li key={it.product_name}>
                      {it.product_name} ({it.pack_label}): you pay €
                      {it.your_price.toFixed(2)}, found €
                      {it.best_price.toFixed(2)}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>

        <footer className="flex gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            className="btn-primary flex-1"
            disabled={d.state !== 'ready'}
            onClick={send}
          >
            <Icon name="mail" className="h-4 w-4" /> Send
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
        </footer>
      </div>
    </div>
  )
}
