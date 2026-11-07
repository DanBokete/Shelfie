// Cheap, deterministic candidate shortlisting for product matching.
// Lower-case, strip numbers and units, expand trade abbreviations, then score word overlap.

const ABBREVIATIONS: Record<string, string> = {
  whl: 'whole',
  wh: 'whole',
  ff: 'free range',
  fr: 'free range',
  sm: 'semi skimmed',
  semi: 'semi skimmed',
  skm: 'skimmed',
  lge: 'large',
  lrg: 'large',
  med: 'medium',
  btl: 'bottle',
  btls: 'bottle',
  ched: 'cheddar',
  chdr: 'cheddar',
  tom: 'tomato',
  toms: 'tomato',
  tomatoes: 'tomato',
  avo: 'avocado',
  avos: 'avocado',
  avocados: 'avocado',
  choc: 'chocolate',
  org: 'organic',
  sw: 'sweet',
  veg: 'vegetable',
  bns: 'beans',
  bean: 'beans',
  esp: 'espresso',
  expr: 'espresso',
  crsnt: 'croissant',
  croissants: 'croissant',
  mlk: 'milk',
  btr: 'butter',
  sug: 'sugar',
  flr: 'flour',
  pln: 'plain',
  sr: 'self raising',
  brd: 'bread',
  sdough: 'sourdough',
  napkin: 'napkins',
  serviettes: 'napkins',
  cup: 'cups',
  lid: 'lids',
  coke: 'coca cola',
  cocacola: 'coca cola',
  eggs: 'egg',
  egg: 'egg',
  lettuces: 'lettuce',
  oatly: 'oat',
}

// Pack and unit words that say nothing about what the product is.
const STOP = new Set([
  'x',
  'ml',
  'l',
  'ltr',
  'ltrs',
  'litre',
  'litres',
  'liter',
  'g',
  'gr',
  'grm',
  'kg',
  'kgs',
  'cl',
  'pk',
  'pack',
  'packs',
  'cs',
  'case',
  'cases',
  'ea',
  'each',
  'box',
  'bag',
  'tray',
  'dz',
  'doz',
  'dozen',
  'of',
  'the',
  'and',
  'a',
  'per',
  'unit',
  'units',
  'tub',
  'tin',
  'can',
  'cans',
  'pcs',
  'pc',
  'piece',
  'pieces',
  'loaf',
  'roll',
  'rolls',
  'sleeve',
  'sleeves',
  'carton',
  'ctn',
])

export function tokens(text: string): Array<string> {
  const words = text
    .toLowerCase()
    .replace(/[0-9]+([.,][0-9]+)?(ml|ltr|l|cl|kg|g|oz|pk|x)?\b/g, ' ')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const out: Array<string> = []
  for (const w of words) {
    const expanded = ABBREVIATIONS[w] ?? w
    for (const part of expanded.split(' ')) {
      if (!STOP.has(part) && part.length > 1) out.push(part)
    }
  }
  return [...new Set(out)]
}

/** Overlap score in [0, 1]: shared words over the smaller set, lightly penalising size gaps. */
export function similarity(a: Array<string>, b: Array<string>): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let shared = 0
  for (const t of a) if (setB.has(t)) shared++
  // Prefix matches catch truncations like 'sourd' vs 'sourdough'.
  for (const t of a) {
    if (setB.has(t) || t.length < 4) continue
    if (b.some((u) => u.length >= 4 && (u.startsWith(t) || t.startsWith(u))))
      shared += 0.6
  }
  const overlap = shared / Math.min(a.length, b.length)
  const jaccard = shared / (a.length + b.length - shared)
  return 0.7 * overlap + 0.3 * jaccard
}

export interface Candidate {
  product_id: string
  name: string
  /** All names this product is known by: canonical name plus aliases. */
  names: Array<string>
}

export function shortlist(
  description: string,
  catalogue: Array<Candidate>,
  k = 8,
): Array<Candidate> {
  const q = tokens(description)
  return catalogue
    .map((c) => ({
      c,
      score: Math.max(...c.names.map((n) => similarity(q, tokens(n)))),
    }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x) => x.c)
}
