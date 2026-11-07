// Compares the database with data/ground_truth.json and prints extraction and matching accuracy.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db, must } from '../src/lib/supabase.server'
import { baseUnitsPerPack, isRawUnit } from '../src/lib/units'
import { EXTRA_PRICE_LIST, PRODUCTS } from './mock/catalogue'
import type { TruthInvoice } from './generate'

interface DbLine {
  invoice_id: string | null
  supplier_id: string
  raw_description: string
  quantity: number | null
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  product_id: string | null
  match_confidence: number | null
  needs_review: boolean
  review_reasons: Array<string>
  source: string
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function units(
  size: number | null,
  unit: string | null,
  perCase: number | null,
): number | null {
  if (!isRawUnit(unit)) return null
  return (
    baseUnitsPerPack({
      pack_size: size,
      pack_unit: unit,
      units_per_case: perCase,
    })?.amount ?? null
  )
}

export async function checkAccuracy(): Promise<boolean> {
  const truth = JSON.parse(
    await readFile(
      path.join(process.cwd(), 'data', 'ground_truth.json'),
      'utf8',
    ),
  ) as {
    invoices: Array<TruthInvoice>
  }
  const invoices = must(
    await db().from('invoices').select('id, file_name, status'),
    'invoices',
  ) as Array<{
    id: string
    file_name: string
    status: string
  }>
  const lines: Array<DbLine> = []
  for (let from = 0; ; from += 1000) {
    const page = must(
      await db()
        .from('price_observations')
        .select(
          'invoice_id, supplier_id, raw_description, quantity, pack_price, pack_size, pack_unit, units_per_case, product_id, match_confidence, needs_review, review_reasons, source',
        )
        .order('id')
        .range(from, from + 999),
      'lines',
    ) as Array<DbLine>
    lines.push(...page)
    if (page.length < 1000) break
  }

  // ---- extraction ----
  let total = 0
  let correct = 0
  const problems: Array<string> = []
  const keyOfLine = new Map<DbLine, string>()
  let badMathsFlagged = false
  for (const inv of truth.invoices) {
    const dbInv = invoices.find((i) => i.file_name === inv.file)
    const mine = lines.filter((l) => l.invoice_id === dbInv?.id)
    for (const t of inv.lines) {
      total++
      const l = mine.find(
        (x) =>
          norm(x.raw_description) === norm(t.description) && !keyOfLine.has(x),
      )
      if (!l) {
        problems.push(`${inv.file}: missing "${t.description}"`)
        continue
      }
      keyOfLine.set(l, t.product_key)
      const okQty = l.quantity === t.quantity
      const okPrice = Math.abs(Number(l.pack_price) - t.pack_price) < 0.005
      const okPack =
        units(l.pack_size, l.pack_unit, l.units_per_case) ===
        units(t.pack_size, t.pack_unit, t.units_per_case)
      if (okQty && okPrice && okPack) correct++
      else
        problems.push(
          `${inv.file}: "${t.description}" got qty ${l.quantity}/${t.quantity}, price ${l.pack_price}/${t.pack_price}, pack ${l.pack_size}${l.pack_unit}x${l.units_per_case} vs ${t.pack_size}${t.pack_unit}x${t.units_per_case}`,
        )
      if (t.bad_maths && l.review_reasons.some((r) => r.startsWith('Maths')))
        badMathsFlagged = true
    }
    if (!dbInv) problems.push(`${inv.file}: not in database`)
    else if (dbInv.status !== 'done')
      problems.push(`${inv.file}: status ${dbInv.status}`)
  }
  const extraLines = lines.filter(
    (l) => l.source === 'invoice' && !keyOfLine.has(l),
  )
  for (const l of extraLines)
    problems.push(`extra line not on the invoice: "${l.raw_description}"`)

  // ---- price lists: key each line by its catalogue listing ----
  for (const l of lines.filter((x) => x.source === 'price_list')) {
    const p = PRODUCTS.find((x) =>
      [x.B?.[0], x.C?.[0]].some(
        (d) => d && norm(d) === norm(l.raw_description),
      ),
    )
    if (p) keyOfLine.set(l, p.key)
    else if (
      Object.values(EXTRA_PRICE_LIST)
        .flat()
        .some((e) => norm(e[0]) === norm(l.raw_description))
    )
      keyOfLine.set(l, `extra:${l.raw_description}`)
  }

  // ---- matching: each true product should map to exactly one database product, and vice versa ----
  const byKey = new Map<string, Map<string, number>>()
  for (const [l, k] of keyOfLine) {
    if (!l.product_id) continue
    const m = byKey.get(k) ?? new Map<string, number>()
    m.set(l.product_id, (m.get(l.product_id) ?? 0) + 1)
    byKey.set(k, m)
  }
  const owner = new Map<string, string>() // product_id -> key that owns it
  const keyProduct = new Map<string, string>()
  for (const [k, m] of byKey) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]
    keyProduct.set(k, best)
  }
  for (const [k, pid] of keyProduct) {
    if (owner.has(pid))
      problems.push(`MERGED: "${owner.get(pid)}" and "${k}" share one product`)
    else owner.set(pid, k)
  }
  let matched = 0
  let matchedNoReview = 0
  let wrongConfident = 0
  for (const [l, k] of keyOfLine) {
    const right =
      l.product_id != null &&
      keyProduct.get(k) === l.product_id &&
      owner.get(l.product_id) === k
    if (right) {
      matched++
      if (!l.review_reasons.some((r) => r.startsWith('Match:')))
        matchedNoReview++
    } else {
      if ((l.match_confidence ?? 0) >= 0.85) wrongConfident++
      problems.push(
        `WRONG MATCH (${l.match_confidence}): "${l.raw_description}" (${k})`,
      )
    }
  }

  for (const p of problems.slice(0, 60)) console.log(' -', p)
  if (problems.length > 60) console.log(` ... and ${problems.length - 60} more`)
  const pct = (a: number, b: number) =>
    `${((100 * a) / Math.max(1, b)).toFixed(1)}%`
  const n = keyOfLine.size
  console.log(
    `\nextraction: ${correct}/${total} lines correct (${pct(correct, total)}), ${extraLines.length} extra lines`,
  )
  console.log(`bad-maths line flagged: ${badMathsFlagged ? 'yes' : 'NO'}`)
  console.log(
    `matching: ${matched}/${n} right (${pct(matched, n)}), ${matchedNoReview}/${n} right without review (${pct(matchedNoReview, n)})`,
  )
  console.log(`wrong matches at >= 0.85 confidence: ${wrongConfident}`)
  return (
    correct / total >= 0.95 &&
    badMathsFlagged &&
    matchedNoReview / n >= 0.9 &&
    wrongConfident === 0
  )
}
