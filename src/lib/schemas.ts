// zod schemas for every AI output. Malformed output never reaches the database.
import { z } from 'zod'

const confidence = z.number().min(0).max(1)

// P1: invoice extraction
export const InvoiceLine = z.object({
  description: z.string(), // exactly as printed
  quantity: z.number().nullable(), // packs or cases bought
  pack_price: z.number(), // price per pack/case, as printed (ex VAT unless prices_include_vat)
  line_total: z.number().nullable(),
  pack_size: z.number().nullable(), // e.g. 2 for '2L'
  pack_unit: z.enum(['ml', 'cl', 'l', 'g', 'kg', 'each']).nullable(),
  units_per_case: z.number().int().nullable(), // e.g. 12 for '12x2L'
  barcode: z.string().nullable(),
  confidence,
})
export type InvoiceLine = z.infer<typeof InvoiceLine>

export const InvoiceExtraction = z.object({
  supplier_name: z.string(),
  invoice_number: z.string().nullable(),
  invoice_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'invoice_date must be YYYY-MM-DD'),
  prices_include_vat: z.boolean(),
  vat_rate_percent: z.number().nullable(), // only when prices include VAT and a single rate is shown
  subtotal_ex_vat: z.number().nullable(),
  adjustments: z.array(
    z.object({ description: z.string(), amount: z.number() }),
  ), // discounts, delivery
  lines: z.array(InvoiceLine),
})
export type InvoiceExtraction = z.infer<typeof InvoiceExtraction>

// P2: product matching
export const NewProduct = z.object({
  canonical_name: z.string(),
  brand: z.string().nullable(),
  category: z.string(),
  base_unit: z.enum(['ml', 'g', 'each']),
})
export const MatchResult = z.object({
  line_id: z.string(),
  product_id: z.string().nullable(),
  new_product: NewProduct.nullable(),
  confidence,
  reason: z.string(),
})
export const MatchResponse = z.object({ results: z.array(MatchResult) })
export type MatchResult = z.infer<typeof MatchResult>

// P3: photo identify
export const PhotoIdentify = z.object({
  product_id: z.string().nullable(),
  confidence,
  what_you_see: z.string(),
})
export type PhotoIdentify = z.infer<typeof PhotoIdentify>

// P4: stock list column detection
export const ColumnDetection = z.object({
  is_stock_list: z.boolean(),
  header_row_index: z.number().int().nullable(),
  columns: z.object({
    product_name: z.number().int().nullable(),
    quantity: z.number().int().nullable(),
    unit: z.number().int().nullable(),
    price: z.number().int().nullable(),
    supplier: z.number().int().nullable(),
  }),
  quantity_period: z.enum(['week', 'month', 'unknown']),
  skip_rows: z.array(z.number().int()),
})
export type ColumnDetection = z.infer<typeof ColumnDetection>

// P5: photographed list
export const PhotoRows = z.object({ rows: z.array(z.array(z.string())) })

// Stock-list matching: P2 plus quantity and pack interpretation per row
export const StockMatchResult = z.object({
  line_id: z.string(),
  product_id: z.string().nullable(),
  confidence,
  reason: z.string(),
  packs_per_period: z.number().nullable(), // "2 cases" -> 2, "half case" -> 0.5
  pack_size: z.number().nullable(), // what one counted unit holds, e.g. case of 6 x 2L
  pack_unit: z.enum(['ml', 'cl', 'l', 'g', 'kg', 'each']).nullable(),
  units_per_case: z.number().int().nullable(),
})
export const StockMatchResponse = z.object({
  results: z.array(StockMatchResult),
})
export type StockMatchResult = z.infer<typeof StockMatchResult>

// P6: negotiation email
export const EmailDraft = z.object({ subject: z.string(), body: z.string() })
export type EmailDraft = z.infer<typeof EmailDraft>

// P7/P8: live competitor prices, read from web research notes
export const WebOffer = z.object({
  seller: z.string(), // shop name only, e.g. 'Tesco'
  title: z.string(), // product name as listed on the page
  url: z.string(), // the product page, copied from the notes
  price: z.number(), // EUR for one listing as sold, as shown on the page
  vat_included: z.boolean(),
  vat_rate_percent: z.number().nullable(), // Irish rate for this product when vat_included
  pack_size: z.number().nullable(),
  pack_unit: z.enum(['ml', 'cl', 'l', 'g', 'kg', 'each']).nullable(),
  units_per_case: z.number().int().nullable(),
  match: z.enum(['exact', 'equivalent', 'different']),
  match_note: z.string(), // at most 12 words
  promo: z.boolean(),
  confidence,
})
export type WebOffer = z.infer<typeof WebOffer>
export const WebOffers = z.object({ offers: z.array(WebOffer) })

// P10: how to reach a seller found online
export const SellerContact = z.object({
  sells_to_trade: z.enum(['yes', 'no', 'unknown']),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  contact_page_url: z.string().nullable(),
  note: z.string(),
})
export type SellerContact = z.infer<typeof SellerContact>
