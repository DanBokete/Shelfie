// Owner settings for emails and reply scanning (the /settings page). One row in the
// settings table; the inbound address and webhook secret fall back to .env when unset.
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { gmailLink, googleSetupProblem } from './google-auth.server'
import type { GmailLink } from './google-auth.server'
import { DEFAULT_TEMPLATES, templateFor, templateProblems } from './templates'
import type { EmailKind, EmailTemplate, Writer } from './templates'
import { db, mustOne } from './supabase.server'

export interface Settings {
  business_name: string
  owner_name: string
  town: string
  reply_by_days: number
  cc_shelfie: boolean
  bcc_email: string | null
  /** How requests are sent: the owner's Gmail account, or Postmark (needs a domain). */
  send_via: SendVia
  /** The address request emails are sent from: the Gmail account, or a Postmark sender. */
  from_email: string | null
  reply_scanning: boolean
  /** Null: use INBOUND_EMAIL_ADDRESS. */
  inbound_address: string | null
  /** Null: use INBOUND_WEBHOOK_SECRET. */
  webhook_secret: string | null
  match_by_sender: boolean
  alerts_enabled: boolean
  alert_min_saving: number
  /** Who writes request emails by default: the owner's templates, or Claude. */
  email_writer: Writer
  /** The owner's templates. Null: the default wording in templates.ts. */
  match_template_subject: string | null
  match_template_body: string | null
  quote_template_subject: string | null
  quote_template_body: string | null
  /** When Gmail was last checked for replies, and what went wrong if it failed. */
  replies_checked_at: string | null
  replies_check_error: string | null
  updated_at: string
  /** The Gmail account connected with "Connect Gmail", if any. Never the token. */
  gmail: GmailLink | null
}

export type SendVia = 'gmail' | 'postmark'

const COLS =
  'business_name, owner_name, town, reply_by_days, cc_shelfie, bcc_email, send_via, from_email, reply_scanning, inbound_address, webhook_secret, match_by_sender, alerts_enabled, alert_min_saving, email_writer, match_template_subject, match_template_body, quote_template_subject, quote_template_body, replies_checked_at, replies_check_error, updated_at'

export async function getSettings(): Promise<Settings> {
  const [res, gmail] = await Promise.all([
    db()
      .from('settings')
      .select(COLS)
      .eq('id', true)
      .maybeSingle<Omit<Settings, 'gmail'>>(),
    gmailLink(),
  ])
  const row = mustOne(res, 'load settings')
  return { ...row, alert_min_saving: Number(row.alert_min_saving), gmail }
}

/** The address requests come from: the connected Gmail account, else the one in Settings. */
export function senderEmail(s: Settings): string | null {
  return s.send_via === 'gmail' && s.gmail ? s.gmail.email : s.from_email
}

/** The Shelfie reply address in use: the saved one, else .env. Null when neither is set. */
export function inboundAddress(s: Settings): string | null {
  return s.inbound_address || process.env.INBOUND_EMAIL_ADDRESS || null
}

/** The webhook secret in use: the saved one, else .env. */
export function webhookSecret(s: Settings): string | null {
  return s.webhook_secret || process.env.INBOUND_WEBHOOK_SECRET || null
}

/** Whether Shelfie can send, and if not, what the owner has to do. */
export function sendingStatus(s: Settings): {
  ready: boolean
  problem: string | null
} {
  if (s.send_via === 'gmail') {
    // Connected with Google: the Gmail API. Otherwise the app password, if there is one.
    if (s.gmail?.needs_reconnect)
      return {
        ready: false,
        problem: `Google stopped Shelfie’s access to ${s.gmail.email}. Press "Reconnect Gmail" in Settings.`,
      }
    if (s.gmail) return { ready: true, problem: null }
    if (!process.env.GMAIL_APP_PASSWORD)
      return {
        ready: false,
        problem: 'Sending is not set up: press "Connect Gmail" in Settings.',
      }
    if (!s.from_email)
      return {
        ready: false,
        problem: 'Enter your Gmail address under "Send emails from".',
      }
    return { ready: true, problem: null }
  }
  if (!process.env.POSTMARK_SERVER_TOKEN)
    return {
      ready: false,
      problem:
        'Sending is not set up: add POSTMARK_SERVER_TOKEN to .env and restart the app.',
    }
  if (!s.from_email)
    return {
      ready: false,
      problem: 'Set the address emails come from in Settings.',
    }
  if (/@(gmail|googlemail)\.com$/i.test(s.from_email))
    return {
      ready: false,
      problem:
        'Postmark cannot send from a Gmail address. Choose "My Gmail account" instead, or use an address on your own domain.',
    }
  return { ready: true, problem: null }
}

/** The address a request should CC so its reply comes back to Shelfie, or null. */
export function replyCc(
  s: Settings,
  addressFor: (base: string, draftId: string) => string | null,
  draftId: string,
): string | null {
  const base = inboundAddress(s)
  if (!s.cc_shelfie || !s.reply_scanning || !base) return null
  return addressFor(base, draftId)
}

/** Puts the owner's details into a prompt's {owner_name}, {business_name} and {town}. */
export function withBusiness(prompt: string, s: Settings): string {
  return prompt
    .replaceAll('{owner_name}', s.owner_name)
    .replaceAll('{business_name}', s.business_name)
    .replaceAll('{town}', s.town)
}

/** The template for an email kind: the owner's own, else the default. */
export function emailTemplate(s: Settings, kind: EmailKind): EmailTemplate {
  return kind === 'match'
    ? templateFor('match', {
        subject: s.match_template_subject,
        body: s.match_template_body,
      })
    : templateFor('quote', {
        subject: s.quote_template_subject,
        body: s.quote_template_body,
      })
}

/** Saved as null when it is the default wording, so a better default reaches it later. */
function templatePart(kind: EmailKind, part: keyof EmailTemplate) {
  return z
    .string()
    .max(5000)
    .transform((v) => v.replace(/\r\n/g, '\n'))
    .transform((v) => (v === DEFAULT_TEMPLATES[kind][part] ? null : v))
}

const optionalEmail = z
  .string()
  .trim()
  .transform((v) => v || null)
  .pipe(z.email('Enter a valid email address').nullable())

export const SettingsInput = z
  .object({
    business_name: z
      .string()
      .trim()
      .min(1, 'Business name is required')
      .max(80),
    owner_name: z.string().trim().min(1, 'Your name is required').max(60),
    town: z.string().trim().min(1, 'Town is required').max(60),
    reply_by_days: z.number().int().min(1).max(60),
    cc_shelfie: z.boolean(),
    bcc_email: optionalEmail,
    send_via: z.enum(['gmail', 'postmark']),
    from_email: optionalEmail,
    reply_scanning: z.boolean(),
    inbound_address: optionalEmail,
    match_by_sender: z.boolean(),
    alerts_enabled: z.boolean(),
    alert_min_saving: z.number().min(0).max(100_000),
    email_writer: z.enum(['template', 'ai']),
    match_template_subject: templatePart('match', 'subject'),
    match_template_body: templatePart('match', 'body'),
    quote_template_subject: templatePart('quote', 'subject'),
    quote_template_body: templatePart('quote', 'body'),
  })
  .superRefine((v, ctx) => {
    // Templates with unknown placeholders or a broken products list are not saved.
    for (const kind of ['match', 'quote'] as const) {
      const label = kind === 'match' ? '"Ask to match"' : '"Ask for a quote"'
      const tpl = templateFor(kind, {
        subject: v[`${kind}_template_subject`],
        body: v[`${kind}_template_body`],
      })
      for (const p of templateProblems(kind, tpl))
        ctx.addIssue({
          code: 'custom',
          path: [`${kind}_template_${p.field}`],
          message: `${label} template: ${p.message}`,
        })
    }
  })
export type SettingsInput = z.input<typeof SettingsInput>

export async function saveSettings(input: z.output<typeof SettingsInput>) {
  mustOne(
    await db()
      .from('settings')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', true)
      .select('updated_at')
      .maybeSingle(),
    'save settings',
  )
  return settingsView()
}

/** A new random webhook secret. The old webhook URL stops working at once. */
export async function rotateWebhookSecret() {
  mustOne(
    await db()
      .from('settings')
      .update({
        webhook_secret: randomBytes(24).toString('base64url'),
        updated_at: new Date().toISOString(),
      })
      .eq('id', true)
      .select('updated_at')
      .maybeSingle(),
    'save webhook secret',
  )
  return settingsView()
}

/** The secret itself, only fetched when the owner copies the webhook URL. */
export async function revealWebhookSecret(): Promise<string | null> {
  return webhookSecret(await getSettings())
}

/** What the settings page shows: everything except the secret, plus whether each part is ready. */
export async function settingsView() {
  const s = await getSettings()
  const { webhook_secret: _secret, ...rest } = s
  const sending = sendingStatus(s)
  return {
    ...rest,
    sending,
    /** What .env lacks for "Connect Gmail", or null when it can be used. */
    google_setup_problem: googleSetupProblem(),
    /** Whether the app-password fallback (SMTP and IMAP) is set up. */
    has_app_password: Boolean(process.env.GMAIL_APP_PASSWORD),
    // Replies are read from the same Gmail account emails are sent from.
    reply_scanning_ready: s.reply_scanning && sending.ready,
  }
}
export type SettingsView = Awaited<ReturnType<typeof settingsView>>
