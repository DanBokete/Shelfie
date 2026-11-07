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
import {
  lastAlert,
  notifyNotHonoured,
  telegramStatus,
} from '#/lib/alerts.server'
import { latestStockReport } from '#/lib/audit.server'
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
import { notHonouredText } from '#/lib/reply-review'
import {
  findByBarcode,
  homeSummary,
  invoiceLines,
  invoiceList,
  notHonoured,
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
import {
  addHeldInvoice,
  addReplyLine,
  applyBetterLines,
  applyReplyLine,
  editReplyLine,
  rejectAllLines,
  rejectHeldInvoice,
  rejectReplyLine,
  replyReview,
  setOutcome,
  undoHeldInvoice,
  undoReplyLine,
} from '#/lib/reply-review.server'
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

/** Agreed prices a later invoice charged more than, with the sentence to show. */
export const getNotHonoured = createServerFn({ method: 'GET' }).handler(
  async () =>
    (await notHonoured()).map((b) => ({
      ...b,
      text: notHonouredText(b, b.product_name),
    })),
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
  .validator(
    z.object({
      id: z.uuid(),
      supplier_id: z.uuid().optional(),
      /** Read one part again: 'email body' or an attachment's file name. */
      only: z.string().min(1).max(200).optional(),
    }),
  )
  .handler(({ data }) => reprocessInbound(data.id, data.supplier_id, data.only))

// --- Reviewing a reply -------------------------------------------------------------------

const RawUnitSchema = z.enum(['ml', 'cl', 'l', 'g', 'kg', 'each'])
const NewProductSchema = z.object({
  canonical_name: z.string().trim().min(2).max(120),
  base_unit: z.enum(['ml', 'g', 'each']),
})
const LineEditSchema = z.object({
  product_id: z.uuid().nullable().optional(),
  new_product: NewProductSchema.nullable().optional(),
  pack_price: z.number().positive().max(100000).optional(),
  pack_size: z.number().positive().nullable().optional(),
  pack_unit: RawUnitSchema.nullable().optional(),
  units_per_case: z.number().int().positive().max(1000).optional(),
})

export const getReplyReview = createServerFn({ method: 'GET' })
  .validator(id)
  .handler(({ data }) => replyReview(data.id))

export const reviewReplyLine = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.uuid(),
      action: z.enum(['apply', 'reject', 'undo', 'edit']),
      edit: LineEditSchema.optional(),
    }),
  )
  .handler(async ({ data }) => {
    if (data.action === 'apply') await applyReplyLine(data.id, data.edit)
    else if (data.action === 'reject') await rejectReplyLine(data.id)
    else if (data.action === 'undo') await undoReplyLine(data.id)
    else await editReplyLine(data.id, data.edit ?? {})
    return { ok: true }
  })

export const reviewReplyAll = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: z.uuid(), action: z.enum(['apply_better', 'reject_all']) }),
  )
  .handler(async ({ data }) => {
    if (data.action === 'apply_better')
      return { applied: await applyBetterLines(data.id) }
    await rejectAllLines(data.id)
    return { applied: 0 }
  })

export const addReplyLineByHand = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      reply_id: z.uuid(),
      raw_description: z.string().trim().min(1).max(200),
      product_id: z.uuid().nullable(),
      new_product: NewProductSchema.nullable(),
      pack_price: z.number().positive().max(100000),
      pack_size: z.number().positive().nullable(),
      pack_unit: RawUnitSchema.nullable(),
      units_per_case: z.number().int().positive().max(1000),
    }),
  )
  .handler(async ({ data }) => {
    const { reply_id, ...line } = data
    if (!line.product_id && !line.new_product)
      throw new Error('Pick the product this price is for.')
    return { id: await addReplyLine(reply_id, line) }
  })

export const setReplyOutcome = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      reply_id: z.uuid(),
      request_item: z.number().int().min(0).nullable(),
      outcome: z.enum([
        'accepted',
        'counter_offer',
        'declined',
        'needs_info',
        'unclear',
      ]),
    }),
  )
  .handler(async ({ data }) => {
    await setOutcome(data.reply_id, data.request_item, data.outcome)
    return { ok: true }
  })

export const reviewHeldInvoice = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: z.uuid(), action: z.enum(['add', 'reject', 'undo']) }),
  )
  .handler(async ({ data }) => {
    if (data.action === 'add') {
      const r = await addHeldInvoice(data.id)
      if (r.invoice_id && !r.error) await notifyNotHonoured(r.invoice_id)
      return r
    }
    if (data.action === 'reject') await rejectHeldInvoice(data.id)
    else await undoHeldInvoice(data.id)
    return { invoice_id: null, error: null }
  })

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

/** The Savings page's last stock list, so it survives a refresh. */
export const getLatestStockReport = createServerFn({ method: 'GET' }).handler(
  () => latestStockReport(),
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
