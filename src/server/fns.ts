// Server functions for page reads and small mutations. The handlers run on the server only;
// the client gets a typed fetch stub. Heavy, multi-step work lives in the /api routes.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  restoreSnapshot,
  saveSnapshot,
  snapshotInfo,
  wipe,
} from '#/lib/admin.server'
import { lastAlert, telegramStatus } from '#/lib/alerts.server'
import { demoMode, model } from '#/lib/claude.server'
import { updateDraft } from '#/lib/email.server'
import { deliveryProblems } from '#/lib/gmail-replies.server'
import { disconnectGmail, gmailLink } from '#/lib/google-auth.server'
import { inboundOverview, reprocessInbound } from '#/lib/inbound.server'
import { livePricesOverview, productPriceChecks } from '#/lib/market.server'
import {
  discardEmail,
  draftReminder,
  pendingCounts,
  pendingEmails,
  savedDraft,
} from '#/lib/pending-emails.server'
import {
  findByBarcode,
  homeSummary,
  invoiceLines,
  invoiceList,
  productDetail,
  reviewQueue,
  searchProducts,
} from '#/lib/queries.server'
import {
  changeProduct,
  confirmLine,
  createProductFor,
  editLine,
} from '#/lib/review.server'
import { setBarcode } from '#/lib/scan.server'
import { setSellingPrice } from '#/lib/selling.server'
import {
  SettingsInput,
  getSettings,
  revealWebhookSecret,
  rotateWebhookSecret,
  saveSettings,
  settingsView,
} from '#/lib/settings.server'

const id = z.object({ id: z.uuid() })

export const getHome = createServerFn({ method: 'GET' }).handler(() =>
  homeSummary(),
)

export const getInvoices = createServerFn({ method: 'GET' }).handler(() =>
  invoiceList(),
)

export const getInvoiceLines = createServerFn({ method: 'GET' })
  .validator(id)
  .handler(({ data }) => invoiceLines(data.id))

export const getReviewQueue = createServerFn({ method: 'GET' }).handler(() =>
  reviewQueue(),
)

export const getProduct = createServerFn({ method: 'GET' })
  .validator(id)
  .handler(({ data }) => productDetail(data.id))

export const getLivePrices = createServerFn({ method: 'GET' }).handler(() =>
  livePricesOverview(),
)

export const getProductPriceChecks = createServerFn({ method: 'GET' })
  .validator(id)
  .handler(({ data }) => productPriceChecks(data.id))

export const lookupBarcode = createServerFn({ method: 'GET' })
  .validator(z.object({ code: z.string().min(4).max(20) }))
  .handler(({ data }) => findByBarcode(data.code))

export const findProducts = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(100) }))
  .handler(({ data }) => searchProducts(data.q))

export const saveBarcode = createServerFn({ method: 'POST' })
  .validator(z.object({ product_id: z.uuid(), barcode: z.string() }))
  .handler(({ data }) => setBarcode(data.product_id, data.barcode))

export const confirmMatch = createServerFn({ method: 'POST' })
  .validator(id)
  .handler(({ data }) => confirmLine(data.id))

export const changeMatch = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), product_id: z.uuid() }))
  .handler(({ data }) => changeProduct(data.id, data.product_id))

export const createProductForLine = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.uuid(),
      canonical_name: z.string().min(2).max(120),
      base_unit: z.enum(['ml', 'g', 'each']),
      category: z.string().max(40).nullable(),
    }),
  )
  .handler(({ data }) => createProductFor(data.id, data))

export const editInvoiceLine = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.uuid(),
      pack_price: z.number().nonnegative(),
      quantity: z.number().nonnegative().nullable(),
      pack_size: z.number().positive().nullable(),
      pack_unit: z.enum(['ml', 'cl', 'l', 'g', 'kg', 'each']).nullable(),
      units_per_case: z.number().int().positive().nullable(),
    }),
  )
  .handler(({ data }) => {
    const { id: lineId, ...fields } = data
    return editLine(lineId, fields)
  })

export const saveDraft = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.uuid(),
      subject: z.string().max(300),
      body: z.string().max(5000),
      to_email: z.string().max(320).nullable(),
      status: z.enum(['draft', 'approved']),
    }),
  )
  .handler(({ data }) => updateDraft(data.id, data))

export const saveSellingPrice = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      product_id: z.uuid(),
      pack_price: z.number().positive().max(100000).nullable(),
    }),
  )
  .handler(({ data }) => setSellingPrice(data.product_id, data.pack_price))

export const getReplies = createServerFn({ method: 'GET' }).handler(
  async () => ({
    ...(await inboundOverview()),
    // Requests Gmail could not deliver, found while checking for replies.
    undelivered: await deliveryProblems(),
    // Whether the connected Gmail needs signing in again (no token, ever).
    gmail: await gmailLink(),
  }),
)

export const retryReply = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), supplier_id: z.uuid().optional() }))
  .handler(({ data }) => reprocessInbound(data.id, data.supplier_id))

/** The Emails page: requests waiting for a reply, drafts, failed sends, replies to review. */
export const getPendingEmails = createServerFn({ method: 'GET' }).handler(() =>
  pendingEmails(),
)

/** How many emails need the owner, for the nav badge and the Home card. */
export const getPendingCounts = createServerFn({ method: 'GET' }).handler(() =>
  pendingCounts(),
)

/** A saved draft (or undelivered request), opened in the email window to edit and send. */
export const openSavedDraft = createServerFn({ method: 'GET' })
  .validator(id)
  .handler(({ data }) => savedDraft(data.id))

/** "Send a reminder": the follow-up draft for a sent request, opened in the email window. */
export const createReminder = createServerFn({ method: 'POST' })
  .validator(id)
  .handler(({ data }) => draftReminder(data.id))

export const discardPendingEmail = createServerFn({ method: 'POST' })
  .validator(id)
  .handler(({ data }) => discardEmail(data.id))

export const getSettingsPage = createServerFn({ method: 'GET' }).handler(() =>
  settingsView(),
)

export const updateSettings = createServerFn({ method: 'POST' })
  .validator(SettingsInput)
  .handler(({ data }) => saveSettings(data))

/** "Disconnect" in Settings: revokes Shelfie's Google access and forgets it. */
export const disconnectGoogle = createServerFn({ method: 'POST' }).handler(
  async () => {
    await disconnectGmail()
    return settingsView()
  },
)

export const newWebhookSecret = createServerFn({ method: 'POST' }).handler(() =>
  rotateWebhookSecret(),
)

/** Only the secret, for the "Copy webhook URL" button. */
export const getWebhookSecret = createServerFn({ method: 'POST' }).handler(() =>
  revealWebhookSecret(),
)

/** The business name and town shown in the app's header and on the home page. */
export const getBusiness = createServerFn({ method: 'GET' }).handler(
  async () => {
    const s = await getSettings()
    return { name: s.business_name, town: s.town }
  },
)

export const getAdminStatus = createServerFn({ method: 'GET' }).handler(
  async () => ({
    snapshot: await snapshotInfo(),
    demo_mode: demoMode(),
    model: model(),
    has_api_key: Boolean(process.env.ANTHROPIC_API_KEY),
    telegram: telegramStatus(),
    last_alert: await lastAlert(),
  }),
)

export const adminAction = createServerFn({ method: 'POST' })
  .validator(z.object({ action: z.enum(['restore', 'wipe', 'snapshot']) }))
  .handler(async ({ data }) => {
    if (data.action === 'restore') return { counts: await restoreSnapshot() }
    if (data.action === 'snapshot') return { counts: await saveSnapshot() }
    await wipe()
    return { counts: {} }
  })
