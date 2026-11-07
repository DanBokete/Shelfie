// Alerts to the owner. Another session is building this file (Telegram sending).
// Only notifyBetterQuote exists here, as a stub that logs, so reply scanning can call it.
export interface BetterQuote {
  supplier_name: string
  product_name: string
  your_ppu: number // EUR per base unit the owner pays now
  quote_ppu: number // EUR per base unit quoted
  base_unit: 'ml' | 'g' | 'each'
  annual_saving: number // EUR a year, from lib/savings
  product_id: string
}

export async function notifyBetterQuote(q: BetterQuote): Promise<void> {
  console.info(
    `[alerts] better quote: ${q.supplier_name} quotes ${q.product_name} at ${q.quote_ppu} per ${q.base_unit} (you pay ${q.your_ppu}), saves about EUR ${q.annual_saving} a year`,
  )
}
