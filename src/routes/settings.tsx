import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Icon, Spinner } from '#/components/Icon'
import { postJSON } from '#/lib/api'
import { dateTime, timeAgo } from '#/lib/format'
import { getSettingsPage, updateSettings } from '#/server/fns'

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
    // Gmail only: sending and reading replies both use the owner's Gmail account.
    send_via: 'gmail' as const,
    from_email: v.from_email ?? '',
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
  const [checking, setChecking] = useState(false)

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

  async function checkNow() {
    setChecking(true)
    setMessage(null)
    try {
      const r = await postJSON<{
        status: 'checked' | 'skipped' | 'failed'
        reason: string | null
        new_replies: number
      }>('/api/email/replies', { force: true })
      await router.invalidate()
      setMessage(
        r.status === 'checked'
          ? {
              ok: true,
              text:
                r.new_replies > 0
                  ? `Found ${r.new_replies} new repl${r.new_replies === 1 ? 'y' : 'ies'}. See Invoices → Replies.`
                  : 'Checked Gmail: no new replies.',
            }
          : { ok: false, text: r.reason ?? 'Could not check Gmail.' },
      )
    } catch (err) {
      setMessage({ ok: false, text: readError(err) })
    } finally {
      setChecking(false)
    }
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
        hint="The 'Ask to match' and 'Ask for a quote' emails. Shelfie sends them from your Gmail, without opening a mail app, and they show in your Gmail Sent folder."
        badge={
          view.sending.ready ? (
            <span className="chip bg-good-soft text-good">
              <Icon name="check" className="h-3 w-3" /> Ready
            </span>
          ) : (
            <span className="chip bg-warn-soft text-warn">Not set up</span>
          )
        }
      >
        {view.sending.problem && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            {view.sending.problem}
          </p>
        )}
        <Field
          label="Your Gmail address"
          hint="Emails are sent from it and suppliers reply to it. It must be the account your app password (GMAIL_APP_PASSWORD in .env) belongs to."
        >
          <input
            className="input"
            type="email"
            placeholder="you@gmail.com"
            value={form.from_email}
            onChange={(e) => set('from_email', e.target.value)}
          />
        </Field>
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
        hint="Shelfie checks your Gmail every couple of minutes while the app is open, and reads replies to the emails it sent: quotes and price lists become prices, invoices are read like any upload. It opens nothing else in your inbox and leaves emails unread."
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
        {view.reply_scanning && !view.sending.ready && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            Uses the same Gmail login as sending: set that up above first.
          </p>
        )}
        <Toggle
          label="Read supplier replies"
          checked={form.reply_scanning}
          onChange={(v) => set('reply_scanning', v)}
        />
        <Toggle
          label="Also read emails from the supplier's address"
          hint="Replies in the same email thread are always read. On: a new email from the address you wrote to is read too, even if it is not a reply in the thread."
          checked={form.match_by_sender}
          onChange={(v) => set('match_by_sender', v)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg/60 px-4 py-3">
          <div className="text-sm">
            <p className="font-medium">
              {view.replies_checked_at
                ? `Gmail last checked ${timeAgo(view.replies_checked_at)}`
                : 'Gmail not checked yet'}
            </p>
            {view.replies_check_error ? (
              <p className="text-xs text-rust">{view.replies_check_error}</p>
            ) : (
              view.replies_checked_at && (
                <p className="text-xs text-muted">
                  {dateTime(view.replies_checked_at)}
                </p>
              )
            )}
          </div>
          <button
            className="btn-secondary"
            disabled={checking || !view.reply_scanning_ready}
            onClick={() => void checkNow()}
          >
            {checking ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Icon name="mail" className="h-4 w-4" />
            )}
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </Section>

      <Section
        title="Better-quote alerts"
        hint="When a reply quotes less than you pay now. Alerts go to Telegram once it is set up (see the README)."
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
