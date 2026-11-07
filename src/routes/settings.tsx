import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { z } from 'zod'
import { EmailWriting, templatesValid } from '#/components/EmailTemplates'
import { Icon, Spinner } from '#/components/Icon'
import { postJSON } from '#/lib/api'
import { dateTime, timeAgo } from '#/lib/format'
import { templateFor } from '#/lib/templates'
import { disconnectGoogle, getSettingsPage, updateSettings } from '#/server/fns'

/** Where "Connect Gmail" starts Google's sign-in. */
const CONNECT_GMAIL = '/api/auth/google/start'

export const Route = createFileRoute('/settings')({
  // ?gmail=<outcome>: back from Google's sign-in (api/auth.google.callback.ts).
  validateSearch: z.object({ gmail: z.string().optional() }),
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
    email_writer: v.email_writer,
    // Null means the default wording: the form shows it so it can be edited from there.
    ...withTemplates(v),
  }
}

function withTemplates(v: View) {
  const match = templateFor('match', {
    subject: v.match_template_subject,
    body: v.match_template_body,
  })
  const quote = templateFor('quote', {
    subject: v.quote_template_subject,
    body: v.quote_template_body,
  })
  return {
    match_template_subject: match.subject,
    match_template_body: match.body,
    quote_template_subject: quote.subject,
    quote_template_body: quote.body,
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
  const [disconnecting, setDisconnecting] = useState(false)
  const { gmail: outcome } = Route.useSearch()
  const navigate = useNavigate()

  // Back from Google: say how it went once, and drop ?gmail= so a reload does not repeat it.
  useEffect(() => {
    if (!outcome) return
    setMessage(gmailOutcome(outcome, view))
    void navigate({ to: '/settings', search: {}, replace: true })
  }, [outcome, view, navigate])

  async function disconnect() {
    setDisconnecting(true)
    setMessage(null)
    try {
      const next = await disconnectGoogle()
      setForm(formOf(next))
      await router.invalidate()
      setMessage({ ok: true, text: 'Gmail disconnected.' })
    } catch (err) {
      setMessage({ ok: false, text: readError(err) })
    } finally {
      setDisconnecting(false)
    }
  }

  const set = <TKey extends keyof Form>(key: TKey, value: Form[TKey]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setMessage(null)
  }
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(view))
  const valid = templatesValid(form)

  async function save() {
    if (!valid) {
      setMessage({
        ok: false,
        text: 'Fix the problems in your email templates first.',
      })
      return
    }
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
        hint="Used to sign your supplier emails, and shown across the app."
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
        title="Writing emails"
        hint="How the 'Ask to match' and 'Ask for a quote' emails are written. The figures in them always come from Shelfie, never from the AI."
      >
        <EmailWriting
          form={form}
          business={form}
          replyByDays={Number(form.reply_by_days)}
          onChange={(patch) => {
            setForm((f) => ({ ...f, ...patch }))
            setMessage(null)
          }}
        />
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
        {/* Connecting (or reconnecting) is explained in the Gmail block below. */}
        {view.sending.problem && !view.gmail && view.has_app_password && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            {view.sending.problem}
          </p>
        )}
        <GmailConnection
          view={view}
          disconnecting={disconnecting}
          onDisconnect={() => void disconnect()}
        />
        {!view.gmail && view.has_app_password && (
          <Field
            label="Or use your Gmail app password"
            hint="Without connecting: emails are sent from this address with GMAIL_APP_PASSWORD in .env, which must belong to it."
          >
            <input
              className="input"
              type="email"
              placeholder="you@gmail.com"
              value={form.from_email}
              onChange={(e) => set('from_email', e.target.value)}
            />
          </Field>
        )}
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
            {view.gmail?.needs_reconnect
              ? 'Replies are not being read: reconnect Gmail above.'
              : 'Replies are read from the Gmail you send from: connect it above first.'}
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

/** What happened on Google's sign-in, from ?gmail= on the way back. */
function gmailOutcome(
  outcome: string,
  view: View,
): { ok: boolean; text: string } {
  switch (outcome) {
    case 'connected':
      return {
        ok: true,
        text: view.gmail
          ? `Connected as ${view.gmail.email}.`
          : 'Gmail connected.',
      }
    case 'denied':
      return {
        ok: false,
        text: 'Gmail was not connected: the sign-in was cancelled on Google’s screen.',
      }
    case 'scopes':
      return {
        ok: false,
        text: 'Shelfie needs both Gmail permissions, to send email and to read replies. Press "Connect Gmail" again and leave both ticked.',
      }
    case 'expired':
      return {
        ok: false,
        text: 'The Google sign-in took too long. Press "Connect Gmail" again.',
      }
    case 'state':
      return {
        ok: false,
        text: 'That Google sign-in did not start from this page, so it was ignored. Press "Connect Gmail" again.',
      }
    case 'setup':
      return {
        ok: false,
        text: view.google_setup_problem ?? 'Connecting Gmail is not set up.',
      }
    default:
      return {
        ok: false,
        text: 'Google sign-in did not work. Try again.',
      }
  }
}

/** "Connect Gmail", "Connected as ..." or "Reconnect Gmail". */
function GmailConnection({
  view,
  disconnecting,
  onDisconnect,
}: {
  view: View
  disconnecting: boolean
  onDisconnect: () => void
}) {
  const g = view.gmail
  const setup = view.google_setup_problem
  const disconnect = (
    <button
      className="btn-ghost"
      disabled={disconnecting}
      onClick={onDisconnect}
    >
      {disconnecting && <Spinner className="h-4 w-4" />}
      {disconnecting ? 'Disconnecting…' : 'Disconnect'}
    </button>
  )
  if (g && !g.needs_reconnect)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg/60 px-4 py-3">
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium">Connected as {g.email}</p>
          <p className="text-xs text-muted">
            Emails are sent from this Gmail and replies are read from it.
            Connected {dateTime(g.connected_at)}.
          </p>
        </div>
        {disconnect}
      </div>
    )
  if (g)
    return (
      <div className="space-y-3 rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn">
        <p className="flex gap-2">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Google stopped Shelfie’s access to <b>{g.email}</b>, so emails
            cannot be sent or replies read. This happens when access is removed
            in the Google account, and every 7 days while the Google app is in
            Testing mode.
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <ConnectButton disabled={Boolean(setup)} label="Reconnect Gmail" />
          {disconnect}
        </div>
      </div>
    )
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg/60 px-4 py-3">
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">Your Gmail account</p>
        <p className={`text-xs ${setup ? 'text-warn' : 'text-muted'}`}>
          {setup ??
            'Sign in with Google once. Shelfie sends from your Gmail and reads only the replies to what it sent.'}
        </p>
      </div>
      <ConnectButton disabled={Boolean(setup)} label="Connect Gmail" />
    </div>
  )
}

function ConnectButton({
  disabled,
  label,
}: {
  disabled: boolean
  label: string
}) {
  // A plain link: the browser goes to Google and comes back to this page.
  return disabled ? (
    <button className="btn-primary" disabled>
      <Icon name="mail" className="h-4 w-4" />
      {label}
    </button>
  ) : (
    <a className="btn-primary" href={CONNECT_GMAIL}>
      <Icon name="mail" className="h-4 w-4" />
      {label}
    </a>
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
