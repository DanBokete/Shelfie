// Ground truth for The Corner Café, Cork. Every supplier, product, name and price the mock
// invoices and price lists are generated from. Planted stories are marked STORY.
//
// A = Lee Valley Wholesale (main supplier, weekly)
// B = Munster Fresh Foods (fresh produce and bakery, fortnightly)
// C = Harbour Catering Supplies (disposables, occasional)

export type SupplierKey = 'A' | 'B' | 'C'
export type Unit = 'ml' | 'l' | 'g' | 'kg' | 'each'

export const SUPPLIERS: Record<
  SupplierKey,
  { name: string; email: string; phone: string; address: string; vat: string }
> = {
  A: {
    name: 'Lee Valley Wholesale',
    email: 'orders@leevalleywholesale.ie',
    phone: '021 430 1188',
    address: 'Unit 4, Kinsale Road Business Park, Cork T12 X2N7',
    vat: 'IE 6388047V',
  },
  B: {
    name: 'Munster Fresh Foods',
    email: 'accounts@munsterfresh.ie',
    phone: '021 455 2290',
    address: 'Market Yard, Mallow, Co. Cork P51 K2C4',
    vat: 'IE 9811324H',
  },
  C: {
    name: 'Harbour Catering Supplies',
    email: 'sales@harbourcatering.ie',
    phone: '021 481 7735',
    address: 'Harbour Row, Cobh, Co. Cork P24 W8T3',
    vat: 'IE 3307719M',
  },
}

/** How a supplier sells a product: [printed name, pack size, pack unit, units per case, pack price]. */
export type Listing = [
  desc: string,
  size: number,
  unit: Unit,
  perCase: number,
  price: number,
]

export interface ProductDef {
  key: string
  name: string // the canonical name we expect matching to converge on
  category: string
  vat: number // VAT % on invoices
  buyFrom: SupplierKey // where the café actually buys it
  weekly: number // packs per week from buyFrom
  A?: Listing
  B?: Listing
  C?: Listing
  /** Price steps over time at buyFrom: [from date, pack price]. STORY: price creep. */
  steps?: Array<[string, number]>
  /** Last date bought from buyFrom (inclusive). */
  until?: string
  /** For the on-stage scan: a real product barcode. Fill in with the products you buy. */
  barcode?: string
  note?: string
}

export const PRODUCTS: Array<ProductDef> = [
  {
    key: 'milk',
    name: 'Whole milk',
    category: 'dairy',
    vat: 0,
    buyFrom: 'A',
    weekly: 40,
    // STORY name chaos: three names for the same milk.
    A: ['AVONM WHL 2LTR', 2, 'l', 1, 3.78],
    B: ['Whole Milk 2L x6', 2, 'l', 6, 21.3], // EUR 3.55 a carton
    C: ['Milk Full Fat 2 Litre', 2, 'l', 1, 3.95],
    // STORY price creep: +11% at Lee Valley in small steps.
    steps: [
      ['2026-08-03', 3.78],
      ['2026-08-17', 3.89],
      ['2026-09-07', 3.99],
      ['2026-09-28', 4.09],
      ['2026-10-12', 4.2],
    ],
  },
  {
    key: 'semi',
    name: 'Semi-skimmed milk',
    category: 'dairy',
    vat: 0,
    buyFrom: 'A',
    weekly: 14,
    A: ['AVONM SEMI SKM 2LTR', 2, 'l', 1, 3.55],
    B: ['Semi Skimmed Milk 2L x6', 2, 'l', 6, 20.4],
    note: 'Must never match whole milk.',
  },
  {
    key: 'oat',
    name: 'Oatly Barista oat drink',
    category: 'dairy',
    vat: 0,
    buyFrom: 'A',
    weekly: 6,
    A: ['OATLY BARISTA 1L X6', 1, 'l', 6, 15.9],
    B: ['Oatly Barista Edition 1L (6)', 1, 'l', 6, 15.3],
  },
  {
    key: 'beans',
    name: 'Espresso coffee beans',
    category: 'dry goods',
    vat: 0,
    buyFrom: 'A',
    weekly: 12,
    A: ['ESPRESSO BEANS HOUSE BLEND 1KG', 1, 'kg', 1, 24.0],
    // STORY cheaper elsewhere: 15% cheaper per kg in a bigger bag.
    B: ['Espresso Coffee Beans 3kg Bag', 3, 'kg', 1, 61.2],
  },
  {
    key: 'butter',
    name: 'Salted butter',
    category: 'dairy',
    vat: 0,
    buyFrom: 'A',
    weekly: 20,
    A: ['IRISH BUTTER SALTED 454G', 454, 'g', 1, 3.1],
    B: ['Salted Butter 1kg Block', 1, 'kg', 1, 6.4],
    steps: [
      ['2026-08-03', 3.1],
      ['2026-09-21', 3.26],
    ],
  },
  {
    key: 'eggs',
    name: 'Free range eggs, large',
    category: 'dairy',
    vat: 0,
    buyFrom: 'A',
    weekly: 10,
    A: ['EGGS FF LGE X30', 30, 'each', 1, 8.4],
    // STORY two prices, one product: also bought from Harbour in Sept and Oct.
    C: ['free range eggs large tray 30', 30, 'each', 1, 7.5],
    until: '2026-10-19',
  },
  {
    key: 'flour',
    name: 'Plain flour',
    category: 'dry goods',
    vat: 0,
    buyFrom: 'A',
    weekly: 1,
    A: ['FLOUR PLAIN 16KG SACK', 16, 'kg', 1, 14.5],
    B: ['Plain Flour 16kg Sack', 16, 'kg', 1, 15.1],
  },
  {
    key: 'caster',
    name: 'Caster sugar',
    category: 'dry goods',
    vat: 0,
    buyFrom: 'A',
    weekly: 2,
    A: ['SUGAR CASTER 5KG', 5, 'kg', 1, 6.2],
    C: ['caster sugar 2kg', 2, 'kg', 1, 2.7],
  },
  {
    key: 'sachets',
    name: 'White sugar sticks',
    category: 'dry goods',
    vat: 0,
    buyFrom: 'A',
    weekly: 0.5,
    A: ['SUGAR STICKS WHITE X1000', 1000, 'each', 1, 9.8],
    C: ['sugar sticks white x1000', 1000, 'each', 1, 8.9],
  },
  {
    key: 'tea',
    name: "Barry's Tea catering bags",
    category: 'drinks',
    vat: 0,
    buyFrom: 'A',
    weekly: 0.5,
    A: ['BARRYS TEA GOLD BLEND 1100 BAGS', 1100, 'each', 1, 38.5],
    note: "Brand matters to Irish customers: must not match Harbour's own-brand tea (EXTRA_PRICE_LIST).",
  },
  {
    key: 'hotchoc',
    name: 'Hot chocolate powder',
    category: 'drinks',
    vat: 0,
    buyFrom: 'A',
    weekly: 1,
    A: ['HOT CHOC POWDER 2KG TUB', 2, 'kg', 1, 16.4],
  },
  {
    key: 'sourdough',
    name: 'Sourdough loaf',
    category: 'bakery',
    vat: 0,
    buyFrom: 'B',
    weekly: 35,
    B: ['Sourdough Loaf 800g', 800, 'g', 1, 3.2],
  },
  {
    key: 'pan',
    name: 'White sliced pan',
    category: 'bakery',
    vat: 0,
    buyFrom: 'A',
    weekly: 25,
    A: ['WHITE SLICED PAN 800G', 800, 'g', 1, 1.65],
    B: ['White Sliced Pan 800g', 800, 'g', 1, 1.55],
  },
  {
    key: 'scones',
    name: 'Fruit scones',
    category: 'bakery',
    vat: 0,
    buyFrom: 'B',
    weekly: 4,
    B: ['Fruit Scones (12)', 12, 'each', 1, 6.0],
  },
  {
    key: 'croissant',
    name: 'Butter croissants, frozen',
    category: 'bakery',
    vat: 0,
    buyFrom: 'A',
    weekly: 3,
    A: ['CROISSANT BUTTER FRZ X60', 60, 'each', 1, 21.0],
    B: ['All Butter Croissants Frozen (48)', 48, 'each', 1, 17.9],
  },
  {
    key: 'brownie',
    name: 'Chocolate brownies, frozen',
    category: 'bakery',
    vat: 0,
    buyFrom: 'A',
    weekly: 1,
    A: ['BROWNIE CHOC FRZ X24', 24, 'each', 1, 19.8],
  },
  {
    key: 'cheddar',
    name: 'Mature cheddar',
    category: 'deli',
    vat: 0,
    buyFrom: 'A',
    weekly: 2,
    A: ['CHED MATURE 5KG BLOCK', 5, 'kg', 1, 38.5],
    B: ['Mature Cheddar 2.5kg', 2.5, 'kg', 1, 18.1],
  },
  {
    key: 'mozz',
    name: 'Grated mozzarella',
    category: 'deli',
    vat: 0,
    buyFrom: 'A',
    weekly: 2,
    A: ['MOZZARELLA GRATED 2KG', 2, 'kg', 1, 15.8],
    B: ['Grated Mozzarella 2kg', 2, 'kg', 1, 16.4],
  },
  {
    key: 'ham',
    name: 'Cooked ham, sliced',
    category: 'deli',
    vat: 0,
    buyFrom: 'A',
    weekly: 5,
    A: ['HAM COOKED SLICED 1KG', 1, 'kg', 1, 11.9],
    C: ['cooked ham sliced 500g', 500, 'g', 1, 6.3],
  },
  {
    key: 'bacon',
    name: 'Back bacon rashers',
    category: 'deli',
    vat: 0,
    buyFrom: 'A',
    weekly: 3,
    A: ['RASHERS BACK 2.27KG', 2.27, 'kg', 1, 13.6],
  },
  {
    key: 'sausages',
    name: 'Pork sausages',
    category: 'deli',
    vat: 0,
    buyFrom: 'A',
    weekly: 2,
    A: ['SAUSAGES PORK X60', 60, 'each', 1, 14.2],
  },
  {
    key: 'salmon',
    name: 'Smoked salmon, sliced',
    category: 'deli',
    vat: 0,
    buyFrom: 'A',
    weekly: 5,
    A: ['SMOKED SALMON SLICED 500G', 500, 'g', 1, 12.8],
    B: ['Irish Smoked Salmon Sliced 1kg', 1, 'kg', 1, 24.6],
  },
  {
    key: 'chicken',
    name: 'Chicken breast fillets',
    category: 'deli',
    vat: 0,
    buyFrom: 'B',
    weekly: 3,
    B: ['Chicken Breast Fillets 2kg', 2, 'kg', 1, 17.8],
    C: ['chicken breast fillets 5kg', 5, 'kg', 1, 42.5],
  },
  {
    key: 'yogurt',
    name: 'Greek style yogurt',
    category: 'dairy',
    vat: 0,
    buyFrom: 'A',
    weekly: 6,
    A: ['GREEK STYLE YOG 1KG', 1, 'kg', 1, 4.6],
    B: ['Greek Style Yogurt 1kg', 1, 'kg', 1, 4.2],
  },
  {
    key: 'granola',
    name: 'Granola',
    category: 'dry goods',
    vat: 0,
    buyFrom: 'A',
    weekly: 1,
    A: ['GRANOLA HONEY 2.5KG', 2.5, 'kg', 1, 14.9],
  },
  {
    key: 'mayo',
    name: 'Mayonnaise',
    category: 'dry goods',
    vat: 0,
    buyFrom: 'A',
    weekly: 0.5,
    A: ['MAYONNAISE 5LTR', 5, 'l', 1, 12.9],
    C: ['mayonnaise 10 litre', 10, 'l', 1, 24.0],
  },
  {
    key: 'tomatoes',
    name: 'Vine tomatoes',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 2,
    B: ['Vine Tomatoes 6kg Box', 6, 'kg', 1, 13.8],
    C: ['tomatoes vine 5kg', 5, 'kg', 1, 12.25],
  },
  {
    key: 'lettuce',
    name: 'Baby gem lettuce',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 3,
    B: ['Baby Gem Lettuce (12)', 12, 'each', 1, 7.2],
  },
  {
    key: 'avocado',
    name: 'Hass avocados',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 3,
    B: ['Hass Avocados Ready to Eat x20', 20, 'each', 1, 17.0],
    C: ['avocados hass ripe tray 22', 22, 'each', 1, 17.6],
  },
  {
    key: 'spinach',
    name: 'Baby spinach',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 2,
    B: ['Baby Spinach 1kg', 1, 'kg', 1, 6.8],
  },
  {
    key: 'bananas',
    name: 'Bananas',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 14,
    B: ['Bananas (per kg)', 1, 'kg', 1, 1.6],
  },
  {
    key: 'lemons',
    name: 'Lemons',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 30,
    B: ['Lemons (each)', 1, 'each', 1, 0.32],
  },
  {
    key: 'onions',
    name: 'Red onions',
    category: 'produce',
    vat: 0,
    buyFrom: 'B',
    weekly: 0.5,
    B: ['Red Onions 10kg Sack', 10, 'kg', 1, 9.5],
  },
  {
    key: 'coke',
    name: 'Coca-Cola cans 330ml',
    category: 'drinks',
    vat: 23,
    buyFrom: 'A',
    weekly: 3,
    A: ['COCA COLA 330ML CAN X24', 330, 'ml', 24, 17.8],
    B: ['Coca-Cola Original 330ml Can (24)', 330, 'ml', 24, 16.9],
    // Own-brand cola on Harbour's price list must NOT match (see EXTRA_PRICE_LIST below).
  },
  {
    key: 'oj',
    name: 'Orange juice',
    category: 'drinks',
    vat: 0,
    buyFrom: 'A',
    weekly: 2,
    A: ['OJ SMOOTH 1LTR X12', 1, 'l', 12, 19.2],
  },
  {
    key: 'water',
    name: 'Still water 500ml',
    category: 'drinks',
    vat: 23,
    buyFrom: 'A',
    weekly: 5,
    A: ['STILL WATER 500ML X24', 500, 'ml', 24, 7.2],
    C: ['still water 500ml x 24', 500, 'ml', 24, 6.5],
  },
  {
    key: 'sparkling',
    name: 'Sparkling water 500ml',
    category: 'drinks',
    vat: 23,
    buyFrom: 'A',
    weekly: 2,
    A: ['SPARKLING WATER 500ML X24', 500, 'ml', 24, 8.1],
  },
  {
    key: 'cups',
    name: 'Double wall cups 12oz',
    category: 'disposables',
    vat: 23,
    buyFrom: 'C',
    weekly: 1,
    C: ['12oz double wall cups 500', 500, 'each', 1, 62.0],
    B: ['Double Wall Coffee Cups 12oz x 1000', 1000, 'each', 1, 118.0],
  },
  {
    key: 'lids',
    name: 'Lids for 12oz cups',
    category: 'disposables',
    vat: 23,
    buyFrom: 'C',
    weekly: 0.5,
    C: ['lids for 12oz cups 1000', 1000, 'each', 1, 29.0],
  },
  {
    key: 'napkins',
    name: 'Napkins 2-ply white',
    category: 'disposables',
    vat: 23,
    buyFrom: 'C',
    weekly: 0.25,
    C: ['napkins 2ply white 4000', 4000, 'each', 1, 38.0],
    B: ['Napkins 2-Ply White (2000)', 2000, 'each', 1, 21.5],
  },
  {
    key: 'boxes',
    name: 'Kraft takeaway boxes',
    category: 'disposables',
    vat: 23,
    buyFrom: 'C',
    weekly: 0.5,
    C: ['kraft food boxes medium 200', 200, 'each', 1, 34.0],
  },
  {
    key: 'cling',
    name: 'Cling film 450mm',
    category: 'disposables',
    vat: 23,
    buyFrom: 'C',
    weekly: 0.25,
    C: ['cling film 450mm x 300m', 1, 'each', 1, 8.5],
  },
  {
    key: 'sacks',
    name: 'Refuse sacks',
    category: 'disposables',
    vat: 23,
    buyFrom: 'C',
    weekly: 0.25,
    C: ['refuse sacks black x200', 200, 'each', 1, 19.0],
  },
]

/** Price-list lines that must NOT match anything the café buys. */
export const EXTRA_PRICE_LIST: Partial<Record<SupplierKey, Array<Listing>>> = {
  C: [
    ['harbour cola 330ml can x24', 330, 'ml', 24, 9.6],
    ['catering tea bags 1100', 1100, 'each', 1, 19.0],
  ],
}

/** STORY unknown item: on the stock list, never on any invoice or price list. */
export const UNKNOWN_STOCK_ITEM = {
  name: 'Matcha powder 100g',
  qty: 2,
  unit: 'tin',
  price: 18.5,
}

/** One-off purchases outside the regular pattern. */
export const EXTRA_PURCHASES: Array<{
  supplier: SupplierKey
  date: string
  product: string
  qty: number
}> = [
  // STORY two prices, one product: eggs from Harbour while still buying from Lee Valley.
  { supplier: 'C', date: '2026-09-10', product: 'eggs', qty: 4 },
  { supplier: 'C', date: '2026-10-24', product: 'eggs', qty: 10 },
  // STORY name chaos: an emergency milk run at Harbour.
  { supplier: 'C', date: '2026-09-10', product: 'milk', qty: 6 },
]
