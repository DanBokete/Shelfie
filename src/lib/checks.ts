// Sanity checks on extracted invoices. Pure, so they are unit-tested.
import type { InvoiceExtraction } from './schemas'

export const MATHS_TOLERANCE = 0.02
export const LOW_CONFIDENCE = 0.7

function close(a: number, b: number): boolean {
  if (b === 0) return Math.abs(a) < 0.01
  return Math.abs(a - b) / Math.abs(b) <= MATHS_TOLERANCE
}

/** Per-line review reasons, index-aligned with extraction.lines. */
export function lineChecks(x: InvoiceExtraction): Array<Array<string>> {
  const reasons = x.lines.map((l) => {
    const r: Array<string> = []
    if (
      l.quantity != null &&
      l.line_total != null &&
      !close(l.quantity * l.pack_price, l.line_total)
    ) {
      r.push(
        `Maths: ${l.quantity} x ${l.pack_price.toFixed(2)} = ${(l.quantity * l.pack_price).toFixed(2)}, but the line total says ${l.line_total.toFixed(2)}`,
      )
    }
    if (l.confidence < LOW_CONFIDENCE)
      r.push(`Extraction: hard to read (${Math.round(l.confidence * 100)}%)`)
    if (x.prices_include_vat && x.vat_rate_percent == null) {
      r.push('VAT: prices include VAT but no rate is shown')
    }
    return r
  })

  // Do the line totals add up to the subtotal? If not, flag the lines that don't add up on their own.
  if (
    x.subtotal_ex_vat != null &&
    x.lines.length > 0 &&
    !x.prices_include_vat
  ) {
    const sum = x.lines.reduce(
      (s, l) => s + (l.line_total ?? (l.quantity ?? 0) * l.pack_price),
      0,
    )
    const withAdjustments =
      sum + x.adjustments.reduce((s, a) => s + a.amount, 0)
    if (
      !close(sum, x.subtotal_ex_vat) &&
      !close(withAdjustments, x.subtotal_ex_vat)
    ) {
      const msg = `Maths: lines add up to ${sum.toFixed(2)}, but the subtotal says ${x.subtotal_ex_vat.toFixed(2)}`
      const suspects = reasons
        .map((r, i) => (r.some((m) => m.startsWith('Maths')) ? i : -1))
        .filter((i) => i >= 0)
      // No single line is to blame: flag them all so the owner checks the invoice.
      for (const i of suspects.length ? [] : reasons.keys())
        reasons[i].push(msg)
    }
  }
  return reasons
}

/** Converts a VAT-inclusive price to ex-VAT. */
export function exVat(price: number, ratePercent: number | null): number {
  if (ratePercent == null) return price
  return Math.round((price / (1 + ratePercent / 100)) * 10000) / 10000
}
