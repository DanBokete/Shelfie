import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '#/components/Icon'
import { dateTime } from '#/lib/format'
import {
  getSettingsPage,
  getWebhookSecret,
  newWebhookSecret,
  updateSettings,
} from '#/server/fns'

export const Route = createFileRoute('/settings')({
  loader: () => getSettingsPage(),
  head: () => ({ meta: [{ title: 'Settings - Shelfie' }] }),
  component: SettingsPage,
})

type View = ReturnType<typeof Route.useLoaderData>

/** The editable fields, as the form holds them (numbers and emails as typed text). */
function formOf(v: View) {
  return {
    business_name: v.business_name,
    owner_name: v.owner_name,
    town: v.town,
    reply_by_days: String(v.reply_by_days),
    cc_shelfie: v.cc_shelfie,
    bcc_email: v.bcc_email ?? '',
    reply_scanning: v.reply_scanning,
    inbound_address: v.inbound_address ?? '',
    match_by_sender: v.match_by_sender,
    alerts_enabled: v.alerts_enabled,
    alert_min_saving: String(v.alert_min_saving),
  }
}
type Form = ReturnType<typeof formOf>

function SettingsPage() {
  const view = Route.useLoaderData()
  const router = useRouter()
  const [form, setForm] = useState<Form>(() => formOf(view))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  )
  const [secretBusy, setSecretBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // The page's own address, known only in the browser.
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])

  const set = <TKey extends keyof Form>(key: TKey, value: Form[TKey]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setMessage(null)
  }
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(view))

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const next = await updateSettings({
        data: {
          ...form,
          reply_by_days: Number(form.reply_by_days),
          alert_min_saving: Number(form.alert_min_saving || 0),
        },
      })
      setForm(formOf(next))
      await router.invalidate()
      setMessage({ ok: true, text: 'Settings saved.' })
    } catch (err) {
      setMessage({ ok: false, text: readError(err) })
    } finally {
      setSaving(false)
    }
  }

  async function rotate() {
    const replacing = view.webhook_secret_source !== null
    if (
      replacing &&
      !window.confirm(
        'Make a new webhook secret? The webhook URL in Postmark stops working until you paste in the new one.',
      )
    )
      return
    setSecretBusy(true)
    try {
      await newWebhookSecret()
      await router.invalidate()
      setMessage({
        ok: true,
        text: 'New webhook secret made. Copy the webhook URL into Postmark.',
      })
    } catch (err) {
      setMessage({ ok: false, text: readError(err) })
    } finally {
      setSecretBusy(false)
    }
  }

  async function copyWebhookUrl() {
    const secret = await getWebhookSecret()
    if (!secret) return
    await navigator.clipboard.writeText(webhookUrl(origin, secret))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 pb-24">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          How Shelfie writes your supplier emails and reads the replies.
          {view.updated_at && ` Last saved ${dateTime(view.updated_at)}.`}
        </p>
      </div>

      <Section
        title="Your business"
        hint="Used to sign the emails Claude drafts, and shown across the app."
      >
        <Field label="Business name">
          <input
            className="input"
            value={form.business_name}
            maxLength={80}
            onChange={(e) => set('business_name', e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" hint="Emails are signed with it.">
            <input
              className="input"
              value={form.owner_name}
              maxLength={60}
              onChange={(e) => set('owner_name', e.target.value)}
            />
          </Field>
          <Field label="Town" hint="Where deliveries go.">
            <input
              className="input"
              value={form.town}
              maxLength={60}
              onChange={(e) => set('town', e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Sending requests"
        hint="The 'Ask to match' and 'Ask for a quote' emails. They open in your own mail app, so they're sent from whichever account it uses."
      >
        <Field
          label="Ask for a reply within"
          hint="The email gives the supplier a date this many days away."
        >
          <div className="flex items-center gap-2">
            <input
              className="input w-24"
              type="number"
              min={1}
              max={60}
              value={form.reply_by_days}
              onChange={(e) => set('reply_by_days', e.target.value)}
            />
            <span className="text-sm text-muted">days</span>
          </div>
        </Field>
        <Toggle
          label="CC Shelfie on requests"
          hint="Adds Shelfie's reply address in CC, so when the supplier hits Reply all, their quote is read automatically."
          checked={form.cc_shelfie}
          onChange={(v) => set('cc_shelfie', v)}
          note={
            form.cc_shelfie && !view.reply_scanning_ready
              ? 'Not added until reply scanning below is set up.'
              : null
          }
        />
        <Field
          label="BCC me a copy"
          hint="Your own email address. Leave empty for no copy."
        >
          <input
            className="input"
            type="email"
            placeholder="you@example.ie"
            value={form.bcc_email}
            onChange={(e) => set('bcc_email', e.target.value)}
          />
        </Field>
      </Section>

      <Section
        title="Reading replies"
        hint="Supplier replies reach Shelfie through a Postmark inbound address. Quotes and price lists in them become prices; invoices are read like any upload."
        badge={
          view.reply_scanning_ready ? (
            <span className="chip bg-good-soft text-good">
              <Icon name="check" className="h-3 w-3" /> Ready
            </span>
          ) : view.reply_scanning ? (
            <span className="chip bg-warn-soft text-warn">Not set up</span>
          ) : (
            <span className="chip">Off</span>
          )
        }
      >
        <Toggle
          label="Read supplier replies"
          hint="When off, replies that reach Shelfie are dropped and requests don't CC Shelfie."
          checked={form.reply_scanning}
          onChange={(v) => set('reply_scanning', v)}
        />
        <Field
          label="Shelfie reply address"
          hint={
            view.env_inbound_address
              ? `Leave empty to use the address in .env (${view.env_inbound_address}).`
              : 'Your Postmark inbound address, e.g. abc123@inbound.postmarkapp.com.'
          }
        >
          <input
            className="input"
            type="email"
            placeholder={
              view.env_inbound_address ?? 'abc123@inbound.postmarkapp.com'
            }
            value={form.inbound_address}
            onChange={(e) => set('inbound_address', e.target.value)}
          />
        </Field>
        <Toggle
          label="Match plain replies by sender"
          hint="If a supplier hits Reply instead of Reply all, match the reply by their email address, then their company's domain. Off: only replies that keep Shelfie's address are matched, and the rest wait under Replies for you to pick the supplier."
          checked={form.match_by_sender}
          onChange={(v) => set('match_by_sender', v)}
        />

        <div className="space-y-3 rounded-lg border border-line bg-bg/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Webhook secret</p>
              <p className="text-xs text-muted">
                {view.webhook_secret_source === 'settings'
                  ? 'Set here. It is never shown.'
                  : view.webhook_secret_source === 'env'
                    ? 'Set in .env. Make a new one to manage it here.'
                    : 'Not set: Postmark cannot deliver replies yet.'}
              </p>
            </div>
            <button
              className="btn-secondary"
              disabled={secretBusy}
              onClick={() => void rotate()}
            >
              {view.webhook_secret_source ? 'Make a new secret' : 'Make secret'}
            </button>
          </div>
          <div>
            <p className="text-sm font-medium">Webhook URL</p>
            <p className="text-xs text-muted">
              Paste this into Postmark as the inbound webhook. Postmark can't
              reach localhost: run a tunnel (e.g.{' '}
              <code>cloudflared tunnel --url http://localhost:3000</code>) and
              swap in its address.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-soft px-2.5 py-2 text-xs">
                {webhookUrl(
                  origin,
                  view.webhook_secret_source ? '••••••••' : '',
                )}
              </code>
              <button
                className="btn-secondary shrink-0"
                disabled={!view.webhook_secret_source}
                onClick={() => void copyWebhookUrl()}
              >
                <Icon name="copy" className="h-4 w-4" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Better-quote alerts"
        hint="When a reply quotes less than you pay now. Alerts are logged for now; Telegram sending is being built."
      >
        <Toggle
          label="Alert me about better quotes"
          checked={form.alerts_enabled}
          onChange={(v) => set('alerts_enabled', v)}
        />
        <Field
          label="Only when it saves at least"
          hint="A year, from your usage. 0 alerts on every better quote."
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">€</span>
            <input
              className="input w-32"
              type="number"
              min={0}
              step={10}
              disabled={!form.alerts_enabled}
              value={form.alert_min_saving}
              onChange={(e) => set('alert_min_saving', e.target.value)}
            />
            <span className="text-sm text-muted">a year</span>
          </div>
        </Field>
      </Section>

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 border-t border-line bg-card/95 backdrop-blur md:bottom-0 md:left-60">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <p
            role="status"
            className={`flex-1 text-sm ${message ? (message.ok ? 'text-good' : 'text-rust') : 'text-muted'}`}
          >
            {message?.text ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
          </p>
          {dirty && (
            <button
              className="btn-ghost"
              disabled={saving}
              onClick={() => {
                setForm(formOf(view))
                setMessage(null)
              }}
            >
              Undo
            </button>
          )}
          <button
            className="btn-primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function webhookUrl(origin: string, secret: string): string {
  return `${origin}/api/email/inbound?secret=${secret}`
}

/** Validation errors come back as a JSON list of issues; show their messages. */
function readError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  try {
    const issues = JSON.parse(text) as Array<{ message: string }>
    if (Array.isArray(issues)) return issues.map((i) => i.message).join('. ')
  } catch {
    // Not JSON: a plain message.
  }
  return text
}

function Section({
  title,
  hint,
  badge,
  children,
}: {
  title: string
  hint: string
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card space-y-4 px-5 py-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold">{title}</h2>
          {badge}
        </div>
        <p className="mt-0.5 text-sm text-muted">{hint}</p>
      </div>
      {children}
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  )
}

function Toggle({
  label,
  hint,
  note,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  note?: string | null
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
        {note && <span className="mt-1 block text-xs text-warn">{note}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="h-6 w-10 rounded-full bg-line transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40" />
        <span className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-card shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  )
}
