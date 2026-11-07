// Every prompt in one file. Each returns JSON validated by a zod schema in schemas.ts.

export const P1_INVOICE_EXTRACTION = `You read supplier invoices for small food businesses in Ireland.
Extract every product line exactly as printed.
Rules:
- description: copy the printed text exactly, including abbreviations and pack sizes. Do not expand or tidy it.
- quantity: the number of packs or cases bought on that line.
- pack_price: the price for ONE pack or case as sold, as printed on the invoice.
- line_total: the line total as printed, or null if there is none. Never compute it yourself.
- Parse sizes from the description: '12x2LTR' = units_per_case 12, pack_size 2, pack_unit 'l'.
  '500G' = pack_size 500, pack_unit 'g', units_per_case 1. '3KG BAG' = pack_size 3, pack_unit 'kg'.
  'X30' or 'TRAY 30' of countable items = pack_size 30, pack_unit 'each'. A single countable item = pack_size 1, pack_unit 'each'.
  '6 x 2L' = units_per_case 6, pack_size 2, pack_unit 'l'. 'CS24 330ML' = units_per_case 24, pack_size 330, pack_unit 'ml'.
- barcode: the EAN/UPC if printed on the line, else null.
- Discounts, deposits, delivery charges and surcharges go in adjustments, never in lines.
- prices_include_vat: true only if the unit prices printed already include VAT. If true and a single VAT rate is shown, set vat_rate_percent.
- subtotal_ex_vat: the goods subtotal before VAT, as printed, or null.
- invoice_date: YYYY-MM-DD. Irish invoices write dates day first (03/08/2026 is 3 August 2026).
- If a value is unreadable, use null and lower confidence. Never guess a price.
- confidence: 0 to 1, how sure you are the whole line is read correctly. Use under 0.7 for anything blurry, handwritten and unclear, or partly hidden.`

export const P2_PRODUCT_MATCHING = `You match supplier invoice lines to a product catalogue for a cafe owner in Ireland.
A match means the owner would happily swap one for the other.
- Same type and spec must match: whole milk is not low-fat or semi-skimmed; free-range eggs are not caged eggs; oat milk is not dairy milk.
- Pack size may differ: 1L and 2L of the same milk are one product.
- Brand matters only for branded drinks and snacks customers ask for by name (e.g. Coca-Cola is never matched to own-brand cola). For staples (milk, flour, sugar, butter, eggs, bread, vegetables, coffee beans of the same style, disposables), brands can match.
- If unsure, return product_id null and propose new_product. A missed match is better than a wrong one.
- Common abbreviations: WHL = whole, FF = free range, SM/S/SKIM = semi-skimmed, LGE = large, BTL = bottle, CS = case, PK = pack, DZ = dozen, CHED = cheddar, TOM = tomato.
Input: lines, each with line_id, description, supplier and up to 8 candidates {product_id, name}.
For each line return line_id, then either a candidate's product_id, or product_id null and new_product
{canonical_name (short, generic, Title case, no pack size unless it defines the product), brand (only for brand-sensitive products, else null), category (dairy, bakery, drinks, dry goods, produce, deli, disposables, other), base_unit ('ml' for liquids, 'g' for weighed goods, 'each' for counted items)}.
confidence: 0 to 1. reason: at most 12 words.`

export const P3_PHOTO_IDENTIFY = `A cafe owner photographed a product in their shop.
Pick which catalogue product it is. The catalogue is given as [{product_id, name}].
Return product_id (or null), confidence 0 to 1, and what_you_see (max 10 words).
Return null if the product is not in the catalogue. Do not pick the closest lookalike if the type or variant differs.`

export const P4_COLUMN_DETECTION = `These are the first rows (and the last few rows) of a stock list a small food business uploaded.
Rows are given as arrays, row index first, then the cells.
Work out:
- is_stock_list: false if nothing here looks like a list of products.
- header_row_index: the row index holding column headers, or null if there is none.
- columns: the cell position (0-based, not counting the row index) of product_name, quantity, unit, price and supplier. Use null for any that is missing. product_name must not be null when is_stock_list is true.
- quantity_period: 'week' or 'month' if the quantity column or a title says so (e.g. 'Qty per week', 'amt/mth'), else 'unknown'.
- skip_rows: row indexes that are titles, totals, subtotals, notes or blank, and are not products.`

export const P5_PHOTO_LIST = `Transcribe this photographed stock list into rows.
Return rows: one array per line, keeping the columns as written. Copy text exactly. Use '' for blank cells.
If a word is unreadable, write your best reading followed by '(?)'.`

export const P2B_STOCK_MATCHING = `${P2_PRODUCT_MATCHING}

These lines come from the owner's own stock list, not an invoice, so there is no supplier and you must not propose new products: return product_id null when nothing matches.
Each line also has raw_quantity and raw_unit. Interpret them:
- packs_per_period: how many of the counted unit they use per period, as a number. '2 cases' = 2, 'half case' = 0.5, '6 btl' = 6, '' = null.
- pack_size, pack_unit, units_per_case: what ONE counted unit holds, if the quantity or unit text says it (e.g. unit '2L' = pack_size 2, pack_unit 'l', units_per_case 1; '1 case (6x2L)' = units_per_case 6, pack_size 2, pack_unit 'l'; 'kg' = pack_size 1, pack_unit 'kg'; 'tray of 30' = pack_size 30, pack_unit 'each'). Use null for all three when the text gives no size, such as a bare 'case' or 'box'.`

export const P6_NEGOTIATION_EMAIL = `Write a short email from a cafe owner to their supplier asking them to match lower prices found elsewhere.
Friendly and firm, under 150 words, plain English, no subject line inside the body.
Value the relationship. Name each product, the current price and the price found, using the exact figures given.
Do NOT name the other supplier. Ask for a reply by a date: write the literal placeholder {reply_by_date} where the date goes, and it will be filled in.
Sign off as {owner_name}, {business_name}.
Return subject and body.`

export const BUSINESS = {
  name: 'The Corner Café',
  owner: 'Aoife',
  town: 'Cork',
}
