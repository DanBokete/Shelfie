// Owner settings for emails and reply scanning (the /settings page). One row in the
// settings table; the inbound address and webhook secret fall back to .env when unset.
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { db, mustOne } from './supabase.server'

export interface Settings {
  business_name: string
  owner_name: string
  town: string
  reply_by_days: number
  cc_shelfie: boolean
  bcc_email: string | null
  reply_scanning: boolean
  /** Null: use INBOUND_EMAIL_ADDRESS. */
  inbound_address: string | null
  /** Null: use INBOUND_WEBHOOK_SECRET. */
  webhook_secret: string | null
  match_by_sender: boolean
  alerts_enabled: boolean
  alert_min_saving: number
  updated_at: string
}

const COLS =
  'business_name, owner_name, town, reply_by_days, cc_shelfie, bcc_email, reply_scanning, inbound_address, webhook_secret, match_by_sender, alerts_enabled, alert_min_saving, updated_at'

export async function getSettings(): Promise<Settings> {
  const row = mustOne(
    await db()
      .from('settings')
      .select(COLS)
      .eq('id', true)
      .maybeSingle<Settings>(),
    'load settings',
  )
  return { ...row, alert_min_saving: Number(row.alert_min_saving) }
}

/** The Shelfie reply address in use: the saved one, else .env. Null when neither is set. */
export function inboundAddress(s: Settings): string | null {
  return s.inbound_address || process.env.INBOUND_EMAIL_ADDRESS || null
}

/** The webhook secret in use: the saved one, else .env. */
export function webhookSecret(s: Settings): string | null {
  return s.webhook_secret || process.env.INBOUND_WEBHOOK_SECRET || null
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

const optionalEmail = z
  .string()
  .trim()
  .transform((v) => v || null)
  .pipe(z.email('Enter a valid email address').nullable())

export const SettingsInput = z.object({
  business_name: z.string().trim().min(1, 'Business name is required').max(80),
  owner_name: z.string().trim().min(1, 'Your name is required').max(60),
  town: z.string().trim().min(1, 'Town is required').max(60),
  reply_by_days: z.number().int().min(1).max(60),
  cc_shelfie: z.boolean(),
  bcc_email: optionalEmail,
  reply_scanning: z.boolean(),
  inbound_address: optionalEmail,
  match_by_sender: z.boolean(),
  alerts_enabled: z.boolean(),
  alert_min_saving: z.number().min(0).max(100_000),
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

/** What the settings page shows: everything except the secret, plus where each value comes from. */
export async function settingsView() {
  const s = await getSettings()
  const { webhook_secret: _secret, ...rest } = s
  const address = inboundAddress(s)
  const secret = webhookSecret(s)
  return {
    ...rest,
    env_inbound_address: process.env.INBOUND_EMAIL_ADDRESS || null,
    inbound_address_in_use: address,
    webhook_secret_source: s.webhook_secret
      ? ('settings' as const)
      : process.env.INBOUND_WEBHOOK_SECRET
        ? ('env' as const)
        : null,
    // Replies can only arrive when there is an address to CC and a secret to check.
    reply_scanning_ready: s.reply_scanning && Boolean(address && secret),
  }
}
export type SettingsView = Awaited<ReturnType<typeof settingsView>>
