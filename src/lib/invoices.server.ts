// Feature 1: invoice ingestion.
import { randomUUID } from 'node:crypto'
import { AIError, askJSON } from './claude.server'
import { exVat, lineChecks } from './checks'
import { applyOutcomes, matchLines, observationPpu } from './match.server'
import { mediaTypeFor, toContentBlock } from './media.server'
import { P1_INVOICE_EXTRACTION } from './prompts'
import { InvoiceExtraction } from './schemas'
import { INVOICE_BUCKET, db, downloadFile, must } from './supabase.server'

export interface SupplierRow {
  id: string
  name: string
  email: string | null
  phone: string | null
}

/** Lower-case and trim, then look for a supplier whose name contains it or vice versa. */
export async function findOrCreateSupplier(name: string): Promise<SupplierRow> {
  const wanted = name.toLowerCase().replace(/\s+/g, ' ').trim()
  const all = must(
    await db().from('suppliers').select('id, name, email, phone'),
    'load suppliers',
  ) as Array<SupplierRow>
  const strip = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(ltd|limited|t\/a|teo|plc)\b\.?/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const w = strip(wanted)
  const hit = all.find((s) => {
    const n = strip(s.name)
    return n === w || n.includes(w) || w.includes(n)
  })
  if (hit) return hit
  return must(
    await db()
      .from('suppliers')
      .insert({ name: name.trim() })
      .select('id, name, email, phone')
      .single(),
    'create supplier',
  ) as SupplierRow
}

/** Stores the file and creates the invoice row. */
export async function storeInvoiceFile(file: {
  name: string
  type: string
  bytes: Uint8Array
}): Promise<string> {
  const mediaType = mediaTypeFor(file.name, file.type)
  const id = randomUUID()
  const ext = file.name.includes('.')
    ? file.name.split('.').pop()!.toLowerCase()
    : 'bin'
  const filePath = `${id}.${ext}`
  must(
    await db()
      .storage.from(INVOICE_BUCKET)
      .upload(filePath, file.bytes, { contentType: mediaType, upsert: false }),
    'upload invoice file',
  )
  must(
    await db().from('invoices').insert({
      id,
      file_path: filePath,
      file_name: file.name,
      status: 'uploaded',
    }),
    'create invoice',
  )
  return id
}

export type ExtractResult =
  | { status: 'done'; invoice_id: string }
  | { status: 'duplicate'; invoice_id: string; duplicate_of: string }
  | { status: 'failed'; invoice_id: string; error: string }

export async function extractInvoice(
  invoiceId: string,
): Promise<ExtractResult> {
  const inv = must(
    await db()
      .from('invoices')
      .select('id, file_path, file_name')
      .eq('id', invoiceId)
      .single(),
    'load invoice',
  ) as { id: string; file_path: string; file_name: string | null }
  await db()
    .from('invoices')
    .update({ status: 'extracting', error: null })
    .eq('id', invoiceId)

  try {
    const blob = await downloadFile(INVOICE_BUCKET, inv.file_path)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const block = await toContentBlock(
      bytes,
      mediaTypeFor(inv.file_path, blob.type),
    )

    const x = await askJSON({
      name: 'extract',
      system: P1_INVOICE_EXTRACTION,
      content: [block, { type: 'text', text: 'Extract this invoice.' }],
      schema: InvoiceExtraction,
      effort: 'medium',
    })

    const supplier = await findOrCreateSupplier(x.supplier_name)

    // Duplicate upload: same supplier, number and date.
    if (x.invoice_number) {
      const dup = must(
        await db()
          .from('invoices')
          .select('id')
          .eq('supplier_id', supplier.id)
          .eq('invoice_number', x.invoice_number)
          .eq('invoice_date', x.invoice_date)
          .eq('status', 'done')
          .neq('id', invoiceId)
          .limit(1),
        'duplicate check',
      ) as Array<{ id: string }>
      if (dup.length > 0) {
        await db()
          .from('invoices')
          .update({
            status: 'duplicate',
            supplier_id: supplier.id,
            invoice_number: x.invoice_number,
            invoice_date: x.invoice_date,
            raw_json: x,
            error: 'Already added',
          })
          .eq('id', invoiceId)
        return {
          status: 'duplicate',
          invoice_id: invoiceId,
          duplicate_of: dup[0].id,
        }
      }
    }

    const reasons = lineChecks(x)
    const vatRate = x.prices_include_vat ? x.vat_rate_percent : null
    const rows = x.lines.map((l, i) => {
      const pack_price = exVat(l.pack_price, vatRate)
      const spec = {
        pack_price,
        pack_size: l.pack_size,
        pack_unit: l.pack_unit,
        units_per_case: l.units_per_case ?? 1,
      }
      const { ppu, reason } = observationPpu(spec, null)
      const r = [...reasons[i], ...(reason ? [reason] : [])]
      return {
        id: randomUUID(),
        invoice_id: invoiceId,
        supplier_id: supplier.id,
        line_index: i,
        raw_description: l.description,
        quantity: l.quantity,
        pack_price,
        line_total: l.line_total == null ? null : exVat(l.line_total, vatRate),
        pack_size: l.pack_size,
        pack_unit: l.pack_unit,
        units_per_case: l.units_per_case ?? 1,
        price_per_base_unit: ppu,
        observed_on: x.invoice_date,
        source: 'invoice' as const,
        extraction_confidence: l.confidence,
        needs_review: r.length > 0,
        review_reasons: r,
      }
    })
    if (rows.length > 0)
      must(await db().from('price_observations').insert(rows), 'store lines')

    const outcomes = await matchLines(
      rows.map((r, i) => ({
        id: r.id,
        description: r.raw_description,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        barcode: x.lines[i].barcode,
      })),
    )
    await applyOutcomes(outcomes)

    const confidence = x.lines.length
      ? x.lines.reduce((s, l) => s + l.confidence, 0) / x.lines.length
      : null
    must(
      await db()
        .from('invoices')
        .update({
          status: 'done',
          supplier_id: supplier.id,
          invoice_number: x.invoice_number,
          invoice_date: x.invoice_date,
          confidence,
          raw_json: x,
        })
        .eq('id', invoiceId),
      'finish invoice',
    )
    return { status: 'done', invoice_id: invoiceId }
  } catch (err) {
    const message =
      err instanceof AIError
        ? err.message
        : `Couldn't read this one: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[extract] ${inv.file_name ?? invoiceId}:`, err)
    // Remove partial lines so a retry starts clean.
    await db().from('price_observations').delete().eq('invoice_id', invoiceId)
    await db()
      .from('invoices')
      .update({ status: 'failed', error: message })
      .eq('id', invoiceId)
    return { status: 'failed', invoice_id: invoiceId, error: message }
  }
}
