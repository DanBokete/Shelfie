// Generates the demo data for The Corner Café from scripts/mock/catalogue.ts:
//   data/ground_truth.json            every invoice, line, price and date
//   data/mock-invoices/*.pdf|*.jpg    rendered invoices, a different layout per supplier,
//                                     3 "photographed" and 1 handwritten
//   data/price-lists/*.csv            price lists for Munster Fresh and Harbour
//   data/mock-stock-lists/*           clean CSV, messy Excel, photographed list
// Run: npm run mock:generate
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import * as XLSX from 'xlsx'
import {
  EXTRA_PRICE_LIST,
  EXTRA_PURCHASES,
  PRODUCTS,
  SUPPLIERS,
  UNKNOWN_STOCK_ITEM,
} from './mock/catalogue'
import type { Listing, ProductDef, SupplierKey } from './mock/catalogue'

const OUT = path.join(process.cwd(), 'data')

// ---------- deterministic randomness ----------
let seed = 20261107
function rand(): number {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const jitter = () => 0.85 + rand() * 0.3
const round2 = (n: number) => Math.round(n * 100) / 100

// ---------- schedule ----------
function addDays(d: string, n: number): string {
  const x = new Date(`${d}T12:00:00Z`)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
const SCHEDULE: Record<SupplierKey, Array<string>> = {
  A: Array.from({ length: 13 }, (_, i) => addDays('2026-08-03', i * 7)), // Mondays
  B: Array.from({ length: 7 }, (_, i) => addDays('2026-08-05', i * 14)), // every other Wednesday
  C: ['2026-08-20', '2026-09-10', '2026-09-24', '2026-10-08', '2026-10-24'],
}
const FIRST_GAP_WEEKS: Record<SupplierKey, number> = { A: 1, B: 2, C: 2.5 }

const PHOTO_INVOICES = new Set(['A:2026-08-24', 'B:2026-09-16'])
const HANDWRITTEN_INVOICE = 'C:2026-08-20'
const BAD_MATHS = {
  supplier: 'A' as SupplierKey,
  date: '2026-09-14',
  product: 'beans',
  error: 24,
}

export interface TruthLine {
  product_key: string
  description: string
  quantity: number
  pack_price: number
  line_total: number // as printed
  pack_size: number
  pack_unit: string
  units_per_case: number
  vat: number
  bad_maths?: boolean
}
export interface TruthInvoice {
  file: string
  supplier: SupplierKey
  supplier_name: string
  invoice_number: string
  invoice_date: string
  format: 'pdf' | 'photo' | 'handwritten'
  lines: Array<TruthLine>
  adjustments: Array<{ description: string; amount: number }>
  subtotal_ex_vat: number
  vat_total: number
  total: number
}

function priceAt(p: ProductDef, s: SupplierKey, date: string): number {
  const listing = p[s]!
  if (s === p.buyFrom && p.steps) {
    let price = listing[4]
    for (const [from, v] of p.steps) if (from <= date) price = v
    return price
  }
  return listing[4]
}

function line(
  p: ProductDef,
  s: SupplierKey,
  date: string,
  qty: number,
): TruthLine {
  const l = p[s]!
  const price = priceAt(p, s, date)
  return {
    product_key: p.key,
    description: l[0],
    quantity: qty,
    pack_price: price,
    line_total: round2(qty * price),
    pack_size: l[1],
    pack_unit: l[2],
    units_per_case: l[3],
    vat: p.vat,
  }
}

function buildInvoices(): Array<TruthInvoice> {
  const invoices: Array<TruthInvoice> = []
  const acc = new Map<string, number>()
  const numbers: Record<SupplierKey, number> = { A: 24113, B: 8802, C: 1407 }
  for (const s of ['A', 'B', 'C'] as Array<SupplierKey>) {
    SCHEDULE[s].forEach((date, i) => {
      const weeks =
        i === 0
          ? FIRST_GAP_WEEKS[s]
          : (Date.parse(date) - Date.parse(SCHEDULE[s][i - 1])) /
            (7 * 86_400_000)
      const lines: Array<TruthLine> = []
      for (const p of PRODUCTS) {
        if (p.buyFrom !== s || (p.until && date > p.until)) continue
        const k = `${s}:${p.key}`
        const a = (acc.get(k) ?? 0) + p.weekly * weeks * jitter()
        const qty = a >= 0.5 ? Math.round(a) : 0
        acc.set(k, a - qty)
        if (qty > 0) lines.push(line(p, s, date, qty))
      }
      for (const x of EXTRA_PURCHASES) {
        if (x.supplier === s && x.date === date) {
          lines.push(
            line(
              PRODUCTS.find((p) => p.key === x.product)!,
              s,
              date,
              x.qty,
            ),
          )
        }
      }
      if (s === BAD_MATHS.supplier && date === BAD_MATHS.date) {
        const l = lines.find((x) => x.product_key === BAD_MATHS.product)!
        l.line_total = round2(l.line_total + BAD_MATHS.error)
        l.bad_maths = true
      }
      const adjustments: Array<{ description: string; amount: number }> = []
      if (s === 'B')
        adjustments.push({ description: 'Delivery charge', amount: 6.5 })
      if (s === 'C' && date === '2026-09-24')
        adjustments.push({ description: 'Loyalty discount', amount: -3 })
      const goods = round2(lines.reduce((t, l) => t + l.line_total, 0))
      const subtotal = round2(
        goods + adjustments.reduce((t, a) => t + a.amount, 0),
      )
      const vat = round2(
        lines.reduce((t, l) => t + (l.line_total * l.vat) / 100, 0),
      )
      const key = `${s}:${date}`
      const format =
        key === HANDWRITTEN_INVOICE
          ? 'handwritten'
          : PHOTO_INVOICES.has(key)
            ? 'photo'
            : 'pdf'
      const number =
        s === 'A'
          ? `LVW-${numbers.A + i * 7}`
          : s === 'B'
            ? `MFF/${numbers.B + i * 3}`
            : `${numbers.C + i}`
      const slug = SUPPLIERS[s].name.toLowerCase().replace(/[^a-z]+/g, '-')
      invoices.push({
        file: `${date}_${slug}${format === 'pdf' ? '.pdf' : '.jpg'}`,
        supplier: s,
        supplier_name: SUPPLIERS[s].name,
        invoice_number: number,
        invoice_date: date,
        format,
        lines,
        adjustments,
        subtotal_ex_vat: subtotal,
        vat_total: vat,
        total: round2(subtotal + vat),
      })
    })
  }
  return invoices.sort((a, b) => (a.invoice_date < b.invoice_date ? -1 : 1))
}

// ---------- rendering ----------
const eur = (n: number) => n.toFixed(2)
const irishDate = (d: string) =>
  `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const code = (key: string) =>
  `LV${(key.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9000, 7) + 1000).toString()}`

function htmlA(inv: TruthInvoice): string {
  const s = SUPPLIERS.A
  return `<html><head><style>
  body{font-family:Helvetica,Arial,sans-serif;color:#1d2a3a;margin:36px;font-size:12px}
  .top{display:flex;justify-content:space-between;border-bottom:4px solid #1f4e8c;padding-bottom:12px}
  h1{color:#1f4e8c;margin:0;font-size:26px;letter-spacing:1px} .muted{color:#5b6b7f}
  table{width:100%;border-collapse:collapse;margin-top:18px} th{background:#1f4e8c;color:#fff;text-align:left;padding:6px}
  td{padding:5px 6px;border-bottom:1px solid #d5dde8} td.n,th.n{text-align:right}
  .tot{width:260px;margin-left:auto;margin-top:14px} .tot td{border:none;padding:3px 6px} .grand td{font-weight:bold;font-size:14px;border-top:2px solid #1f4e8c}
  </style></head><body>
  <div class="top"><div><h1>LEE VALLEY WHOLESALE</h1><div class="muted">${s.address}<br>Tel ${s.phone} · ${s.email}<br>VAT No. ${s.vat}</div></div>
  <div style="text-align:right"><h2 style="margin:0">TAX INVOICE</h2><div>Invoice No: <b>${inv.invoice_number}</b></div><div>Date: ${irishDate(inv.invoice_date)}</div><div>Account: CORN-0117</div></div></div>
  <p><b>Deliver to:</b> The Corner Café, 12 Oliver Plunkett St, Cork</p>
  <table><tr><th>Code</th><th>Description</th><th class="n">Qty</th><th class="n">Unit Price</th><th class="n">VAT %</th><th class="n">Amount €</th></tr>
  ${inv.lines.map((l) => `<tr><td>${code(l.product_key)}</td><td>${esc(l.description)}</td><td class="n">${l.quantity}</td><td class="n">${eur(l.pack_price)}</td><td class="n">${l.vat}</td><td class="n">${eur(l.line_total)}</td></tr>`).join('')}
  </table>
  <table class="tot"><tr><td>Goods (ex VAT)</td><td class="n">${eur(inv.subtotal_ex_vat)}</td></tr><tr><td>VAT</td><td class="n">${eur(inv.vat_total)}</td></tr><tr class="grand"><td>TOTAL DUE €</td><td class="n">${eur(inv.total)}</td></tr></table>
  <p class="muted" style="margin-top:28px">Payment terms: 30 days. All prices exclude VAT unless stated. Thank you for your business.</p></body></html>`
}

function htmlB(inv: TruthInvoice): string {
  const s = SUPPLIERS.B
  const goods = round2(inv.lines.reduce((t, l) => t + l.line_total, 0))
  return `<html><head><link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap" rel="stylesheet"><style>
  body{font-family:Merriweather,Georgia,serif;color:#23361f;margin:40px;font-size:11.5px}
  .brand{background:#2f6b2a;color:#fff;padding:16px 20px;border-radius:6px;display:flex;justify-content:space-between;align-items:center}
  .brand h1{margin:0;font-size:22px} table{width:100%;border-collapse:collapse;margin-top:20px}
  th{border-bottom:2px solid #2f6b2a;text-align:left;padding:6px;font-size:11px;text-transform:uppercase;color:#2f6b2a}
  td{padding:6px;border-bottom:1px dotted #9db89a} .n{text-align:right} .box{display:flex;justify-content:space-between;margin-top:16px}
  </style></head><body>
  <div class="brand"><div><h1>Munster Fresh Foods</h1><div>Fresh produce · Bakery · Deli</div></div><div style="text-align:right">Invoice ${inv.invoice_number}<br>${irishDate(inv.invoice_date)}</div></div>
  <div class="box"><div><b>Bill to</b><br>The Corner Café<br>12 Oliver Plunkett St<br>Cork</div><div style="text-align:right">${s.address}<br>${s.phone}<br>VAT ${s.vat}</div></div>
  <table><tr><th>Item</th><th class="n">Price</th><th class="n">Qty</th><th class="n">Total</th></tr>
  ${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">€${eur(l.pack_price)}</td><td class="n">${l.quantity}</td><td class="n">€${eur(l.line_total)}</td></tr>`).join('')}
  </table>
  <table style="width:300px;margin-left:auto"><tr><td>Goods</td><td class="n">€${eur(goods)}</td></tr>
  ${inv.adjustments.map((a) => `<tr><td>${esc(a.description)}</td><td class="n">€${eur(a.amount)}</td></tr>`).join('')}
  <tr><td>Subtotal ex VAT</td><td class="n">€${eur(inv.subtotal_ex_vat)}</td></tr><tr><td>VAT</td><td class="n">€${eur(inv.vat_total)}</td></tr><tr><td><b>Amount due</b></td><td class="n"><b>€${eur(inv.total)}</b></td></tr></table>
  <p style="margin-top:24px;color:#567">Prices shown exclude VAT. Goods remain our property until paid in full.</p></body></html>`
}

function htmlC(inv: TruthInvoice, handwritten: boolean): string {
  const s = SUPPLIERS.C
  const font = handwritten ? "'Caveat',cursive" : "'Courier New',monospace"
  return `<html><head><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap" rel="stylesheet"><style>
  body{font-family:${font};color:${handwritten ? '#1b2a6b' : '#222'};margin:30px 46px;font-size:${handwritten ? 21 : 13}px;background:${handwritten ? '#fffdf3' : '#fff'}}
  h1{font-family:'Courier New',monospace;font-size:20px;margin:0;color:#222} .hdr{font-family:'Courier New',monospace;font-size:12px;color:#333}
  table{border-collapse:collapse;margin-top:14px;width:100%} td{padding:${handwritten ? '2px 6px' : '3px 6px'};${handwritten ? 'border-bottom:1px solid #b9c7e6' : ''}} .n{text-align:right}
  </style></head><body>
  <h1>HARBOUR CATERING SUPPLIES</h1><div class="hdr">${s.address} · ${s.phone} · VAT ${s.vat}</div>
  <div class="hdr" style="margin-top:6px">${handwritten ? 'Docket' : 'INVOICE'} no. ${inv.invoice_number} &nbsp; date ${irishDate(inv.invoice_date)} &nbsp; cust: corner cafe cork</div>
  <table><tr class="hdr"><td>qty</td><td>item</td><td class="n">each</td><td class="n">total</td></tr>
  ${inv.lines.map((l) => `<tr><td>${l.quantity}</td><td>${esc(l.description)}</td><td class="n">${eur(l.pack_price)}</td><td class="n">${eur(l.line_total)}</td></tr>`).join('')}
  ${inv.adjustments.map((a) => `<tr><td></td><td>${esc(a.description.toLowerCase())}</td><td></td><td class="n">${eur(a.amount)}</td></tr>`).join('')}
  </table>
  <table style="width:260px;margin-left:auto"><tr><td>nett</td><td class="n">${eur(inv.subtotal_ex_vat)}</td></tr><tr><td>vat</td><td class="n">${eur(inv.vat_total)}</td></tr><tr><td><b>total</b></td><td class="n"><b>${eur(inv.total)}</b></td></tr></table>
  <p class="hdr" style="margin-top:20px">prices ex vat. thank you!</p></body></html>`
}

function invoiceHtml(inv: TruthInvoice): string {
  if (inv.supplier === 'A') return htmlA(inv)
  if (inv.supplier === 'B') return htmlB(inv)
  return htmlC(inv, inv.format === 'handwritten')
}

/** Makes a clean render look like a phone photo of paper on a table in poor light. */
async function photograph(png: Buffer, angle: number): Promise<Buffer> {
  const meta = await sharp(png).metadata()
  const w = meta.width
  const h = meta.height
  const noise = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = Math.floor(rand() * 60)
    noise.writeUInt32BE(((v << 24) | (v << 16) | (v << 8) | 28) >>> 0, i * 4)
  }
  const shade = Buffer.from(
    `<svg width="${w}" height="${h}"><defs><radialGradient id="g" cx="35%" cy="30%" r="85%"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="100%" stop-color="#2b1d0e" stop-opacity="0.55"/></radialGradient>
    <linearGradient id="f" x1="0" x2="1"><stop offset="0.48" stop-color="#000" stop-opacity="0"/><stop offset="0.5" stop-color="#000" stop-opacity="0.12"/><stop offset="0.53" stop-color="#fff" stop-opacity="0.08"/><stop offset="0.56" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#f)"/></svg>`,
  )
  // sharp applies composites after rotation in a single pipeline, so light the paper first, then rotate.
  const lit = await sharp(png)
    .composite([
      {
        input: noise,
        raw: { width: w, height: h, channels: 4 },
        blend: 'overlay',
      },
      { input: shade, blend: 'multiply' },
    ])
    .modulate({ brightness: 0.86, saturation: 0.8 })
    .blur(0.7)
    .png()
    .toBuffer()
  return sharp(lit)
    .rotate(angle, { background: '#5a4632' })
    .extend({ top: 60, bottom: 60, left: 50, right: 50, background: '#5a4632' })
    .jpeg({ quality: 72 })
    .toBuffer()
}

async function render(
  browser: Browser,
  html: string,
  file: string,
  format: 'pdf' | 'photo' | 'handwritten',
  angle = -2,
  width = 820,
) {
  const page = await browser.newPage({
    viewport: { width, height: 600 },
    deviceScaleFactor: 1.6,
  })
  await page.setContent(html, { waitUntil: 'networkidle' })
  if (format === 'pdf') {
    await page.pdf({ path: file, format: 'A4', printBackground: true })
  } else {
    const png = await page.screenshot({ fullPage: true })
    await writeFile(file, await photograph(png, angle))
  }
  await page.close()
}

// ---------- stock lists ----------
interface StockEntry {
  key: string
  clean: string
  messy: string
  weekly: number
  unit: string
  price: number
  supplier: string
}

const MESSY_NAMES: Record<string, string> = {
  milk: 'Wholemilk 2ltr',
  semi: 'semi skim milk',
  oat: 'OATLY',
  beans: 'Expresso beans',
  butter: 'Butter (salted)',
  eggs: 'eggs FR large',
  caster: 'castor sugar',
  cheddar: 'Chedar mature',
  croissant: 'croissants',
  mozz: 'mozzerella grated',
  avocado: 'avacados',
  coke: 'coke cans',
  salmon: 'smoked salmon',
  tea: "Barry's tea bags",
  hotchoc: 'hot choc',
}

function unitLabel(l: Listing): string {
  const [, size, unit, perCase] = l
  if (perCase > 1)
    return `case ${perCase}x${size}${unit === 'each' ? '' : unit}`
  if (unit === 'each') return size === 1 ? 'each' : `pack of ${size}`
  return `${size}${unit}`
}

function stockEntries(): Array<StockEntry> {
  const lastDate = '2026-10-31'
  return PRODUCTS.map((p) => {
    // Eggs now come from Harbour.
    const s: SupplierKey = p.key === 'eggs' ? 'C' : p.buyFrom
    const l = p[s]!
    const clean = p.name
      .replace(/, /g, ' ')
      .replace(/^./, (c) => c.toUpperCase())
    return {
      key: p.key,
      clean,
      messy: MESSY_NAMES[p.key] ?? clean.toLowerCase(),
      weekly: p.weekly,
      unit: unitLabel(l),
      price: priceAt(p, s, lastDate),
      supplier: SUPPLIERS[s].name.split(' ')[0],
    }
  })
}

async function writeStockLists(browser: Browser, dir: string) {
  const entries = stockEntries()
  const unknown = UNKNOWN_STOCK_ITEM

  // Clean CSV
  const csv = [
    'Product,Qty per week,Unit,Price,Supplier',
    ...entries.map(
      (e) =>
        `"${e.clean}",${e.weekly},"${e.unit}",${e.price.toFixed(2)},${e.supplier}`,
    ),
    `"${unknown.name}",${unknown.qty},${unknown.unit},${unknown.price.toFixed(2)},`,
  ].join('\n')
  await writeFile(path.join(dir, 'stock-list-clean.csv'), csv)

  // Messy Excel: title row, blank row, odd headers, monthly amounts with mixed units, totals and notes.
  const rows: Array<Array<string | number>> = [
    ['CORNER CAFE - STOCK ORDER SHEET (Oct 26)'],
    [],
    ['ITEM', 'amt/mth', 'size', '€', 'who from'],
  ]
  for (const [i, e] of entries.entries()) {
    const monthly = Math.round(e.weekly * 4.33 * 10) / 10
    const word = e.unit.startsWith('case')
      ? 'cases'
      : e.unit.startsWith('pack')
        ? 'pks'
        : e.key === 'oj'
          ? 'btl'
          : ''
    const amt: string | number =
      i % 3 === 0 && word ? `${monthly} ${word}` : monthly
    rows.push([
      e.messy,
      amt,
      i % 4 === 1 ? '' : e.unit,
      i % 5 === 2 ? `€${e.price.toFixed(2)}` : e.price,
      e.supplier.toLowerCase(),
    ])
    if (i === 20) rows.push(['', '', '', '', ''])
  }
  rows.push([
    unknown.name.toLowerCase(),
    Math.round(unknown.qty * 4.33),
    unknown.unit,
    unknown.price,
    '',
  ])
  rows.push([
    'TOTAL',
    '',
    '',
    entries.reduce((t, e) => t + e.price * e.weekly * 4.33, 0).toFixed(0),
    '',
  ])
  rows.push(['notes: prices ex vat. ask Lee Valley about milk going up again'])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Oct order')
  await writeFile(
    path.join(dir, 'stock-list-messy.xlsx'),
    XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  )

  // Photographed handwritten list.
  const items = [
    ...entries.map((e) => ({
      name: e.messy,
      qty: `${e.weekly}/wk`,
      unit: e.unit,
      price: e.price,
    })),
    {
      name: unknown.name,
      qty: `${unknown.qty}/wk`,
      unit: unknown.unit,
      price: unknown.price,
    },
  ]
  const half = Math.ceil(items.length / 2)
  const col = (xs: typeof items) =>
    `<table>${xs.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.qty}</td><td>${esc(x.unit)}</td><td>€${x.price.toFixed(2)}</td></tr>`).join('')}</table>`
  const html = `<html><head><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap" rel="stylesheet"><style>
  body{margin:0;padding:34px 40px;background:#fffef6 repeating-linear-gradient(#fffef6 0 39px,#bcd0ee 39px 40px);font-family:Caveat,cursive;font-size:27px;color:#1d2766}
  h1{font-size:34px;margin:0 0 6px} .cols{display:flex;gap:40px} td{padding:0 14px 0 0;height:40px;white-space:nowrap}</style></head>
  <body><h1>Weekly stock - Corner Café</h1><div class="cols">${col(items.slice(0, half))}${col(items.slice(half))}</div></body></html>`
  await render(
    browser,
    html,
    path.join(dir, 'stock-list-photo.jpg'),
    'photo',
    1.5,
    1260,
  )
}

// ---------- main ----------
async function main() {
  await rm(path.join(OUT, 'mock-invoices'), { recursive: true, force: true })
  for (const d of ['mock-invoices', 'price-lists', 'mock-stock-lists'])
    await mkdir(path.join(OUT, d), { recursive: true })

  const invoices = buildInvoices()

  // Price lists for suppliers B and C, covering what they sell (including what the café doesn't buy there).
  const priceLists: Record<
    string,
    { supplier: SupplierKey; date: string; rows: Array<Listing> }
  > = {
    B: { supplier: 'B', date: '2026-10-01', rows: [] },
    C: { supplier: 'C', date: '2026-10-05', rows: [] },
  }
  for (const s of ['B', 'C'] as const) {
    for (const p of PRODUCTS) {
      const listing = p[s]
      if (listing) priceLists[s].rows.push(listing)
    }
    for (const extra of EXTRA_PRICE_LIST[s] ?? [])
      priceLists[s].rows.push(extra)
    const slug = SUPPLIERS[s].name.toLowerCase().replace(/[^a-z]+/g, '-')
    const csv = [
      'description,pack_price,pack_size,pack_unit,units_per_case',
      ...priceLists[s].rows.map(
        (r) => `"${r[0]}",${r[4].toFixed(2)},${r[1]},${r[2]},${r[3]}`,
      ),
    ].join('\n')
    await writeFile(
      path.join(OUT, 'price-lists', `${slug}-${priceLists[s].date}.csv`),
      csv,
    )
  }

  const browser = await chromium.launch()
  try {
    for (const [i, inv] of invoices.entries()) {
      await render(
        browser,
        invoiceHtml(inv),
        path.join(OUT, 'mock-invoices', inv.file),
        inv.format,
        i % 2 ? -2.2 : 1.8,
      )
    }
    await writeStockLists(browser, path.join(OUT, 'mock-stock-lists'))
  } finally {
    await browser.close()
  }

  const truth = {
    business: { name: 'The Corner Café', town: 'Cork', owner: 'Aoife' },
    suppliers: SUPPLIERS,
    products: PRODUCTS.map((p) => ({
      key: p.key,
      name: p.name,
      category: p.category,
    })),
    invoices,
    price_lists: priceLists,
  }
  await writeFile(
    path.join(OUT, 'ground_truth.json'),
    JSON.stringify(truth, null, 1),
  )

  // Summary for sanity-checking the planted stories.
  const weeks = 13
  const spend = invoices.reduce((t, i) => t + i.subtotal_ex_vat, 0)
  console.log(
    `${invoices.length} invoices, ${invoices.reduce((t, i) => t + i.lines.length, 0)} lines`,
  )
  console.log(
    `spend ex VAT: €${spend.toFixed(0)} total, ~€${(spend / weeks).toFixed(0)} a week`,
  )
  console.log(
    `formats: ${['pdf', 'photo', 'handwritten'].map((f) => `${invoices.filter((i) => i.format === f).length} ${f}`).join(', ')}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
