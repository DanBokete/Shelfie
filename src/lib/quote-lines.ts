// Turning the lines of a quote or price list into price_observations rows. Pure, so it is
// unit-tested. Pack-size rules are the invoice ones (see P1 and P12). The invoice maths
// checks are not used: a quote has no quantities and no line totals.
import { exVat } from './checks'
import type { ReplyDocument } from './schemas'
import { isRawUnit, pricePerBaseUnit } from './units'

export const LOW_CONFIDENCE = 0.7

export interface QuoteRow {
  line_index: number
  raw_description: string
  pack_price: number // EUR ex VAT, per pack
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number
  price_per_base_unit: number | null
  observed_on: string
  extraction_confidence: number
  needs_review: boolean
  review_reasons: Array<string>
}

export function isIsoDate(s: string | null | undefined): s is string {
  return (
    typeof s === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(`${s}T12:00:00Z`))
  )
}

/**
 * Rows for one quote or price list document. Lines with no price are dropped. A line that
 * is hard to read, or has no usable pack size, is flagged so it stays out of savings
 * until the owner checks it (the same rule invoices follow).
 */
export function quoteRows(
  doc: Pick<
    ReplyDocument,
    'lines' | 'prices_include_vat' | 'vat_rate_percent' | 'document_date'
  >,
  fallbackDate: string,
): Array<QuoteRow> {
  const date = isIsoDate(doc.document_date) ? doc.document_date : fallbackDate
  const vatRate = doc.prices_include_vat ? doc.vat_rate_percent : null
  const rows: Array<QuoteRow> = []
  for (const l of doc.lines) {
    if (l.pack_price == null || !(l.pack_price > 0)) continue
    const description = l.description.trim()
    if (!description) continue
    const price = exVat(l.pack_price, vatRate)
    const unitsPerCase =
      l.units_per_case && l.units_per_case > 0 ? l.units_per_case : 1
    const reasons: Array<string> = []
    if (l.confidence < LOW_CONFIDENCE)
      reasons.push(
        `Extraction: hard to read (${Math.round(l.confidence * 100)}%)`,
      )
    if (doc.prices_include_vat && doc.vat_rate_percent == null)
      reasons.push('VAT: prices include VAT but no rate is shown')
    let ppu: number | null = null
    if (isRawUnit(l.pack_unit)) {
      const r = pricePerBaseUnit(price, {
        pack_size: l.pack_size,
        pack_unit: l.pack_unit,
        units_per_case: unitsPerCase,
      })
      ppu = r ? r.price : null
    }
    if (ppu == null) reasons.push('Pack size unknown')
    rows.push({
      line_index: rows.length,
      raw_description: description,
      pack_price: price,
      pack_size: l.pack_size,
      pack_unit: l.pack_unit,
      units_per_case: unitsPerCase,
      price_per_base_unit: ppu,
      observed_on: date,
      extraction_confidence: l.confidence,
      needs_review: reasons.length > 0,
      review_reasons: reasons,
    })
  }
  return rows
}

/** Annual saving of switching to a quoted price, rounded, never negative. */
export function quoteSaving(
  yourPpu: number,
  quotePpu: number,
  annualBaseUnits: number | null,
): number {
  if (annualBaseUnits == null) return 0
  return Math.max(0, Math.round((yourPpu - quotePpu) * annualBaseUnits))
}

/** True when the quote is below what the owner pays now. */
export function beatsCurrent(yourPpu: number, quotePpu: number): boolean {
  return quotePpu < yourPpu
}
