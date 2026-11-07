// Browser-side stock list handling: read the sheet, apply the detected columns, build rows.
// Pure functions are unit-tested; readSheet needs SheetJS and runs in the browser.

export interface Mapping {
  header_row_index: number | null
  columns: {
    product_name: number | null
    quantity: number | null
    unit: number | null
    price: number | null
    supplier: number | null
  }
  quantity_period: 'week' | 'month' | 'unknown'
  skip_rows: Array<number>
}

export interface StockRow {
  raw_name: string
  raw_quantity: string | null
  raw_unit: string | null
  raw_price: string | null
  raw_supplier: string | null
}

export const MAX_ROWS = 300

/** First sheet only, as trimmed strings, with fully empty rows and columns dropped. */
export async function readSheet(file: File): Promise<Array<Array<string>>> {
  const XLSX = await import('xlsx')
  const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
  const wb = isCsv
    ? XLSX.read(await file.text(), { type: 'string' })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  return cleanRows(rows.map((r) => r.map((c) => (c == null ? '' : String(c)))))
}

export function cleanRows(rows: Array<Array<string>>): Array<Array<string>> {
  const trimmed = rows
    .map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim()))
    .filter((r) => r.some((c) => c !== ''))
  const width = Math.max(0, ...trimmed.map((r) => r.length))
  const keep = Array.from({ length: width }, (_, i) =>
    trimmed.some((r) => (r[i] ?? '') !== ''),
  )
  return trimmed.map((r) =>
    Array.from({ length: width }, (_, i) => r[i] ?? '').filter(
      (_, i) => keep[i],
    ),
  )
}

/** The rows the column detector sees: the first 10 and the last 5, with their indexes. */
export function sampleRows(
  rows: Array<Array<string>>,
): Array<{ index: number; cells: Array<string> }> {
  const head = rows.slice(0, 10).map((cells, index) => ({ index, cells }))
  const tailStart = Math.max(10, rows.length - 5)
  const tail = rows
    .slice(tailStart)
    .map((cells, i) => ({ index: tailStart + i, cells }))
  return [...head, ...tail]
}

const NOT_A_PRODUCT =
  /^\s*((sub)?totals?|grand total|sum|notes?|n\.?b\.?|comments?)\b/i

export function buildRows(
  rows: Array<Array<string>>,
  m: Mapping,
): { items: Array<StockRow>; truncated: boolean } {
  const skip = new Set(m.skip_rows)
  const start = m.header_row_index == null ? 0 : m.header_row_index + 1
  const cell = (r: Array<string>, i: number | null) =>
    i == null ? null : (r[i] ?? '').trim() || null
  const items: Array<StockRow> = []
  for (let i = start; i < rows.length; i++) {
    if (skip.has(i)) continue
    const r = rows[i]
    const name = cell(r, m.columns.product_name)
    if (!name || NOT_A_PRODUCT.test(name)) continue
    const others = [
      m.columns.quantity,
      m.columns.unit,
      m.columns.price,
      m.columns.supplier,
    ].map((c) => cell(r, c))
    // A long sentence with nothing else on the row is a note, not a product.
    if (others.every((x) => x == null) && name.split(' ').length > 6) continue
    items.push({
      raw_name: name,
      raw_quantity: others[0],
      raw_unit: others[1],
      raw_price: others[2],
      raw_supplier: others[3],
    })
  }
  return { items: items.slice(0, MAX_ROWS), truncated: items.length > MAX_ROWS }
}
