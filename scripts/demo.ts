// Demo data commands. Run with the env loaded, e.g. `npm run demo -- load`.
//   wipe       empty every table
//   load       wipe, then ingest every mock invoice (3 at a time) and both price lists
//   accuracy   compare the database with data/ground_truth.json (extraction and matching)
//   seed-truth wipe, then load ground_truth.json directly (no AI): for UI work without an API key
//   snapshot   save the current database as the demo snapshot (restored by /admin/reset)
//   restore    restore the snapshot
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { restoreSnapshot, saveSnapshot, wipe } from '../src/lib/admin.server'
import { extractInvoice, storeInvoiceFile } from '../src/lib/invoices.server'
import { loadPriceList, parsePriceListCsv } from '../src/lib/pricelists.server'
import { randomUUID } from 'node:crypto'
import { observationPpu } from '../src/lib/match.server'
import { INVOICE_BUCKET, db, must } from '../src/lib/supabase.server'
import { toBase } from '../src/lib/units'
import type { RawUnit } from '../src/lib/units'
import { EXTRA_PRICE_LIST, PRODUCTS, SUPPLIERS } from './mock/catalogue'
import type { SupplierKey } from './mock/catalogue'
import type { TruthInvoice } from './generate'
import { checkAccuracy } from './accuracy'

const DATA = path.join(process.cwd(), 'data')

async function pool<T>(
  items: Array<T>,
  size: number,
  fn: (x: T) => Promise<void>,
) {
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++])
    }),
  )
}

async function load(only?: string) {
  await wipe()
  const dir = path.join(DATA, 'mock-invoices')
  const files = (await readdir(dir))
    .filter((f) => /\.(pdf|jpe?g|png)$/i.test(f) && (!only || f.includes(only)))
    .sort()
  const started = Date.now()
  await pool(files, 3, async (f) => {
    const t = Date.now()
    const bytes = new Uint8Array(await readFile(path.join(dir, f)))
    const id = await storeInvoiceFile({ name: f, type: '', bytes })
    const r = await extractInvoice(id)
    console.log(
      `${r.status.padEnd(9)} ${((Date.now() - t) / 1000).toFixed(1).padStart(5)}s  ${f}${r.status === 'failed' ? `  ${r.error}` : ''}`,
    )
  })
  console.log(
    `invoices: ${files.length} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  )

  const plDir = path.join(DATA, 'price-lists')
  const names: Record<string, string> = {
    munster: 'Munster Fresh Foods',
    harbour: 'Harbour Catering Supplies',
  }
  for (const f of (await readdir(plDir)).filter((x) => x.endsWith('.csv'))) {
    const date = f.match(/(\d{4}-\d{2}-\d{2})/)![1]
    const supplier = names[f.split('-')[0]]
    const r = await loadPriceList(
      supplier,
      date,
      parsePriceListCsv(await readFile(path.join(plDir, f), 'utf8')),
    )
    console.log(`price list ${supplier}: ${r.lines} lines`)
  }
}

async function seedTruth() {
  await wipe()
  const truth = JSON.parse(
    await readFile(path.join(DATA, 'ground_truth.json'), 'utf8'),
  ) as {
    invoices: Array<TruthInvoice>
    price_lists: Record<
      string,
      {
        supplier: SupplierKey
        date: string
        rows: Array<[string, number, RawUnit, number, number]>
      }
    >
  }
  const sup: Record<string, string> = {}
  for (const k of ['A', 'B', 'C'] as const) {
    const r = must(
      await db()
        .from('suppliers')
        .insert({
          name: SUPPLIERS[k].name,
          email: SUPPLIERS[k].email,
          phone: SUPPLIERS[k].phone,
        })
        .select('id')
        .single(),
      'supplier',
    ) as { id: string }
    sup[k] = r.id
  }
  const prod: Record<string, { id: string; unit: 'ml' | 'g' | 'each' }> = {}
  for (const p of PRODUCTS) {
    const l = (p[p.buyFrom] ?? p.A ?? p.B ?? p.C)!
    const unit = toBase(1, l[2]).unit
    const r = must(
      await db()
        .from('products')
        .insert({
          canonical_name: p.name,
          category: p.category,
          base_unit: unit,
          barcode: p.barcode ?? null,
        })
        .select('id')
        .single(),
      'product',
    ) as { id: string }
    prod[p.key] = { id: r.id, unit }
  }
  for (const [s, extras] of Object.entries(EXTRA_PRICE_LIST)) {
    for (const e of extras) {
      const r = must(
        await db()
          .from('products')
          .insert({
            canonical_name: e[0].replace(/^./, (c) => c.toUpperCase()),
            category: 'drinks',
            base_unit: toBase(1, e[2]).unit,
          })
          .select('id')
          .single(),
        'product',
      ) as { id: string }
      prod[`extra:${s}:${e[0]}`] = { id: r.id, unit: toBase(1, e[2]).unit }
    }
  }
  const aliases = new Map<
    string,
    { supplier_id: string; raw_text: string; product_id: string }
  >()
  const obs: Array<Record<string, unknown>> = []
  for (const inv of truth.invoices) {
    const bytes = await readFile(path.join(DATA, 'mock-invoices', inv.file))
    const id = randomUUID()
    const filePath = `${id}.${inv.file.split('.').pop()}`
    await db()
      .storage.from(INVOICE_BUCKET)
      .upload(filePath, bytes, {
        contentType: inv.file.endsWith('.pdf')
          ? 'application/pdf'
          : 'image/jpeg',
      })
    must(
      await db().from('invoices').insert({
        id,
        supplier_id: sup[inv.supplier],
        invoice_date: inv.invoice_date,
        invoice_number: inv.invoice_number,
        file_name: inv.file,
        file_path: filePath,
        status: 'done',
        confidence: 1,
      }),
      'invoice',
    )
    inv.lines.forEach((l, i) => {
      const p = prod[l.product_key]
      const { ppu } = observationPpu(l, p.unit)
      const maths = l.bad_maths
        ? [
            `Maths: ${l.quantity} x ${l.pack_price.toFixed(2)} = ${(l.quantity * l.pack_price).toFixed(2)}, but the line total says ${l.line_total.toFixed(2)}`,
          ]
        : []
      obs.push({
        invoice_id: id,
        supplier_id: sup[inv.supplier],
        line_index: i,
        raw_description: l.description,
        quantity: l.quantity,
        pack_price: l.pack_price,
        line_total: l.line_total,
        pack_size: l.pack_size,
        pack_unit: l.pack_unit,
        units_per_case: l.units_per_case,
        price_per_base_unit: ppu,
        observed_on: inv.invoice_date,
        source: 'invoice',
        extraction_confidence: 1,
        product_id: p.id,
        match_confidence: 1,
        match_reason: 'truth: seeded from ground truth',
        needs_review: maths.length > 0,
        review_reasons: maths,
      })
      aliases.set(`${inv.supplier}|${l.description}`, {
        supplier_id: sup[inv.supplier],
        raw_text: l.description,
        product_id: p.id,
      })
    })
  }
  for (const pl of Object.values(truth.price_lists)) {
    pl.rows.forEach((r, i) => {
      const key =
        PRODUCTS.find((p) => p[pl.supplier]?.[0] === r[0])?.key ??
        `extra:${pl.supplier}:${r[0]}`
      const p = prod[key]
      const row = {
        pack_price: r[4],
        pack_size: r[1],
        pack_unit: r[2],
        units_per_case: r[3],
      }
      obs.push({
        supplier_id: sup[pl.supplier],
        line_index: i,
        raw_description: r[0],
        quantity: null,
        ...row,
        price_per_base_unit: observationPpu(row, p.unit).ppu,
        observed_on: pl.date,
        source: 'price_list',
        product_id: p.id,
        match_confidence: 1,
        match_reason: 'truth: seeded from ground truth',
        needs_review: false,
        review_reasons: [],
      })
      aliases.set(`${pl.supplier}|${r[0]}`, {
        supplier_id: sup[pl.supplier],
        raw_text: r[0],
        product_id: p.id,
      })
    })
  }
  for (let i = 0; i < obs.length; i += 500)
    must(
      await db()
        .from('price_observations')
        .insert(obs.slice(i, i + 500)),
      'observations',
    )
  must(
    await db()
      .from('product_aliases')
      .insert([...aliases.values()]),
    'aliases',
  )
  console.log(
    `seeded ${truth.invoices.length} invoices, ${obs.length} prices, ${Object.keys(prod).length} products`,
  )
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'wipe') await wipe()
  else if (cmd === 'load') await load(arg)
  else if (cmd === 'seed-truth') await seedTruth()
  else if (cmd === 'accuracy') {
    const ok = await checkAccuracy()
    process.exitCode = ok ? 0 : 1
  } else if (cmd === 'snapshot') console.log(await saveSnapshot())
  else if (cmd === 'restore') console.log(await restoreSnapshot())
  else if (cmd === 'review') {
    const rows = must(
      await db()
        .from('price_observations')
        .select('raw_description, review_reasons, suppliers(name)')
        .eq('needs_review', true),
      'review',
    ) as unknown as Array<{
      raw_description: string
      review_reasons: Array<string>
      suppliers: { name: string }
    }>
    for (const r of rows)
      console.log(
        `${r.suppliers.name.padEnd(26)} ${r.raw_description.padEnd(40)} ${r.review_reasons.join(' | ')}`,
      )
  } else {
    console.error(
      'usage: demo <wipe|load [filter]|seed-truth|accuracy|review|snapshot|restore>',
    )
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
