// Feature 3: photo fallback for the scanner, and learning barcodes.
import { askJSON } from './claude.server'
import { mediaTypeFor, toContentBlock } from './media.server'
import { P3_PHOTO_IDENTIFY } from './prompts'
import { allProducts } from './queries.server'
import { PhotoIdentify } from './schemas'
import { db, must } from './supabase.server'

export const IDENTIFY_MIN_CONFIDENCE = 0.5

export async function identifyPhoto(file: {
  name: string
  type: string
  bytes: Uint8Array
}) {
  const products = await allProducts()
  if (products.length === 0)
    return { product: null, confidence: 0, what_you_see: 'No products yet' }
  const catalogue = products.map((p, i) => ({
    product_id: `p${i + 1}`,
    name:
      p.brand && !p.canonical_name.toLowerCase().includes(p.brand.toLowerCase())
        ? `${p.brand} ${p.canonical_name}`
        : p.canonical_name,
  }))
  const block = await toContentBlock(
    file.bytes,
    mediaTypeFor(file.name, file.type),
  )
  const res = await askJSON({
    name: 'identify',
    system: P3_PHOTO_IDENTIFY,
    content: [
      block,
      { type: 'text', text: `Catalogue: ${JSON.stringify(catalogue)}` },
    ],
    schema: PhotoIdentify,
    effort: 'low',
    maxTokens: 2000,
  })
  const idx = res.product_id ? Number(res.product_id.replace(/^p/, '')) - 1 : -1
  const product =
    idx >= 0 &&
    idx < products.length &&
    res.confidence >= IDENTIFY_MIN_CONFIDENCE
      ? products[idx]
      : null
  return { product, confidence: res.confidence, what_you_see: res.what_you_see }
}

/** Saves a scanned barcode to a product so the next scan is instant. */
export async function setBarcode(
  productId: string,
  barcode: string,
): Promise<void> {
  const code = barcode.trim()
  if (!/^\d{8,14}$/.test(code))
    throw new Error('Barcode must be 8 to 14 digits')
  // A barcode belongs to one product: move it if another product had it.
  must(
    await db().from('products').update({ barcode: null }).eq('barcode', code),
    'clear old barcode',
  )
  must(
    await db().from('products').update({ barcode: code }).eq('id', productId),
    'save barcode',
  )
}
