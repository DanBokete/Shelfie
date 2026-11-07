// "Check matches": owner fixes to flagged lines. Fixes update the alias so they stick.
import { observationPpu } from './match.server'
import { db, must } from './supabase.server'
import type { BaseUnit } from './units'

interface ObsForReview {
  id: string
  supplier_id: string | null
  raw_description: string
  product_id: string | null
  pack_price: number
  pack_size: number | null
  pack_unit: string | null
  units_per_case: number | null
  review_reasons: Array<string>
}

const OBS_COLS =
  'id, supplier_id, raw_description, product_id, pack_price, pack_size, pack_unit, units_per_case, review_reasons'

async function loadObs(id: string): Promise<ObsForReview> {
  return must(
    await db()
      .from('price_observations')
      .select(OBS_COLS)
      .eq('id', id)
      .single(),
    'load line',
  ) as ObsForReview
}

async function baseUnitOf(productId: string | null): Promise<BaseUnit | null> {
  if (!productId) return null
  const p = must(
    await db()
      .from('products')
      .select('base_unit')
      .eq('id', productId)
      .single(),
    'load product',
  ) as {
    base_unit: BaseUnit
  }
  return p.base_unit
}

/** Re-derives unit price and structural reasons, keeping the given non-structural reasons. */
async function save(obs: ObsForReview, keep: Array<string>): Promise<void> {
  const { ppu, reason } = observationPpu(obs, await baseUnitOf(obs.product_id))
  const reasons = [...keep, ...(reason ? [reason] : [])]
  must(
    await db()
      .from('price_observations')
      .update({
        product_id: obs.product_id,
        pack_price: obs.pack_price,
        pack_size: obs.pack_size,
        pack_unit: obs.pack_unit,
        units_per_case: obs.units_per_case,
        price_per_base_unit: ppu,
        review_reasons: reasons,
        needs_review: reasons.length > 0,
      })
      .eq('id', obs.id),
    'save line',
  )
}

/** Owner says the line and its match are right. */
export async function confirmLine(id: string): Promise<void> {
  const obs = await loadObs(id)
  if (obs.product_id) await rememberAlias(obs, obs.product_id)
  await save(obs, [])
}

/** Owner picks a different product. Applies to every line with the same text from the same supplier. */
export async function changeProduct(
  id: string,
  productId: string,
): Promise<void> {
  const obs = await loadObs(id)
  await rememberAlias(obs, productId)
  let q = db()
    .from('price_observations')
    .select(OBS_COLS)
    .eq('raw_description', obs.raw_description)
  q = obs.supplier_id
    ? q.eq('supplier_id', obs.supplier_id)
    : q.is('supplier_id', null)
  const same = must(await q, 'load same lines') as Array<ObsForReview>
  for (const o of same) {
    const keep =
      o.id === id
        ? []
        : o.review_reasons.filter(
            (r) => !r.startsWith('Match:') && !r.startsWith('Unit mismatch'),
          )
    await save({ ...o, product_id: productId }, keep)
    must(
      await db()
        .from('price_observations')
        .update({ match_confidence: 1, match_reason: 'owner: Chosen by owner' })
        .eq('id', o.id),
      'save match',
    )
  }
}

export async function createProductFor(
  id: string,
  np: { canonical_name: string; base_unit: BaseUnit; category: string | null },
): Promise<string> {
  const created = must(
    await db()
      .from('products')
      .insert({
        canonical_name: np.canonical_name.trim(),
        base_unit: np.base_unit,
        category: np.category,
      })
      .select('id')
      .single(),
    'create product',
  ) as { id: string }
  await changeProduct(id, created.id)
  return created.id
}

/** Owner corrects extracted values. */
export async function editLine(
  id: string,
  fields: {
    pack_price: number
    quantity: number | null
    pack_size: number | null
    pack_unit: string | null
    units_per_case: number | null
  },
): Promise<void> {
  const obs = await loadObs(id)
  must(
    await db()
      .from('price_observations')
      .update({ quantity: fields.quantity })
      .eq('id', id),
    'save quantity',
  )
  const keep = obs.review_reasons.filter((r) => r.startsWith('Match:'))
  await save({ ...obs, ...fields }, keep)
}

async function rememberAlias(
  obs: ObsForReview,
  productId: string,
): Promise<void> {
  must(
    await db().from('product_aliases').upsert(
      {
        supplier_id: obs.supplier_id,
        raw_text: obs.raw_description,
        product_id: productId,
        confirmed: true,
      },
      { onConflict: 'supplier_id,raw_text' },
    ),
    'save alias',
  )
}
