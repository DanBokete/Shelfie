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
Value the relationship. For each product give the price per pack we need to pay and the percentage reduction that is (for example "we would need €3.50 per 2L, about 11% lower"), using the exact figures given.
Say in one short phrase that this is what the business needs to stay competitive.
Do NOT write what the owner pays now, what the owner sells for, or any margin or profit figure. Do NOT name the other supplier or say where the price was found. Ask for a reply by a date: write the literal placeholder {reply_by_date} where the date goes, and it will be filled in.
Sign off as {owner_name}, {business_name}.
Return subject and body.`

export const P7_WEB_PRICE_SEARCH = `You find what other sellers in Ireland charge today for a product a cafe owner buys, so they can see whether they are overpaying their supplier.
Search the web, then open each seller's product page to read the price. Search snippets go out of date: only report a price you read on the seller's own page in this session.
Where to look: Irish supermarkets with online shops (Tesco, SuperValu, Dunnes Stores, Aldi, Lidl), cash and carries and catering or wholesale shops that show prices publicly, and online shops that deliver in Ireland. Prices must be in euro.
- Find the same product first: same brand when a brand is given, same type and spec. Whole milk is not semi-skimmed, free-range eggs are not caged, oat milk is not dairy.
- If the exact product is not sold online, a close equivalent of the same type and spec is useful. Say it is an equivalent.
- Bigger packs and cases are welcome: the owner compares price per litre, kg or item.
- Fresh produce and deli are often sold loose or by weight. Note the unit price the page shows (e.g. '€1.99/kg', '€0.45 each') as well as the shelf price, and how many items a pack holds.
- For each offer note: seller, the product name as listed, the page URL, the price shown, the unit price shown (per kg, per litre or each), the pack size and how many in a case, whether the price includes VAT (supermarket shelf prices do), and any promotion or loyalty-card-only price. Use the normal price when a club price needs a loyalty card, and mention the club price.
- Aim for 3 to 6 offers from different sellers. Stop when you have them or your searches run out. Never invent a price or a URL.
How the tools work, so you do not waste them:
- web_fetch only opens a URL that appeared in an earlier search result. Never build a URL yourself, such as a shop's search page.
- Search once per seller (e.g. 'Avonmore whole milk 2L tesco.ie'), then open the product page links the results give you.
- Open each page once. When you work in code, print each result's title and URL, and the lines of a page around its euro prices, so you can read them.
Write the findings as a plain list, one offer per line, each with its full URL, then one sentence on how the cheapest compares with what the owner pays.`

export const P8_WEB_PRICE_READ = `Turn these price research notes into offers. Use only what the notes say.
- url: copy the product page URL exactly from the notes. Leave out any offer without one.
- seller: the shop's name only (e.g. 'Tesco', 'SuperValu', 'Dunnes Stores', 'Aldi', 'Lidl'). If it is one of the known sellers given, spell it exactly that way.
- title: the product name as listed. price: the euro price for ONE listing as sold, exactly as shown. Never compute it.
- pack_size, pack_unit, units_per_case: what one listing holds. '6 x 2L' = units_per_case 6, pack_size 2, pack_unit 'l'. '1kg' = pack_size 1, pack_unit 'kg', units_per_case 1. 'Pack of 12 eggs' = pack_size 12, pack_unit 'each'. Use null when the size is not stated.
- Sold loose, by weight, or with no pack size but a unit price shown: use the unit price as the listing. '€1.99/kg' = price 1.99, pack_size 1, pack_unit 'kg'. '€0.45 each' = price 0.45, pack_size 1, pack_unit 'each'. '€1.79 per 2 pack' of lettuces = price 1.79, pack_size 2, pack_unit 'each'.
- vat_included: true for supermarket and other consumer shelf prices, false only when the page says ex VAT.
- vat_rate_percent, when vat_included: the Irish VAT rate for this product. 0 for most food and drink staples (milk, butter, cheese, eggs, bread, flour, sugar, tea, coffee, fresh produce). 23 for soft drinks, bottled water, sweets, chocolate, crisps, alcohol and non-food such as cups and napkins. Null if unsure.
- match: 'exact' for the same product (pack size may differ), 'equivalent' for a close swap of the same type and spec, 'different' for anything else. match_note: at most 12 words.
- promo: true when the price is a temporary offer.
- confidence: 0 to 1, how sure you are that the price, pack size and match are right.`

export const P9_SELLER_CONTACT = `A cafe owner in {town}, Ireland found a seller online and wants to ask them for a trade quote.
Find out, from the seller's own website, whether they sell to businesses (trade accounts, wholesale, catering, cash and carry, business delivery) and how a business gets in touch: a sales or trade email address, a phone number, or a business enquiry page.
Search, then open the seller's pages to read the details. Only report an email or phone number you read on a page in this session. Never guess one from the domain name, and never use a personal email.
Prefer a trade, sales, wholesale or business email over a general customer-service one.
Write your findings in plain text: whether they sell to trade, the email, the phone, the page URL each came from, and one short sentence on how to open an account.`

export const P10_SELLER_CONTACT_READ = `Turn these notes about a seller into contact details. Use only what the notes say.
- sells_to_trade: 'yes' if the notes show they sell to businesses, 'no' if they only sell to the public, else 'unknown'.
- email, phone: copy exactly as written in the notes, or null. Never build an address yourself.
- contact_page_url: the page the email or phone came from, copied exactly, or null.
- note: at most 20 words for the owner, e.g. 'Trade accounts through the Business Centre page; minimum order applies.'`

export const P11_QUOTE_REQUEST = `Write a short email from a cafe owner to a seller they have never bought from, asking for a trade quote.
Friendly and businesslike, under 150 words, plain English, no subject line inside the body.
Introduce the business in one line. Name each product with the pack and the typical weekly quantity given, and say the owner saw it listed at the price given (use that exact figure).
Ask for their trade price list or a quote, delivery to {town} and any minimum order, and how to open an account.
Do NOT name the owner's current supplier or what the owner pays now.
Ask for a reply by a date: write the literal placeholder {reply_by_date} where the date goes, and it will be filled in.
Sign off as {owner_name}, {business_name}, {town}.
Return subject and body.`

export const P12_REPLY_READ = `A supplier or seller replied to a cafe owner in Ireland. You get the request the owner sent (when known), the reply's email text and any attachments.

First, the answer to the request.
- The request lists the products asked about as R1, R2..., each with its pack and the price the owner asked for (an "Ask to match" request) or saw online (an "Ask for a quote" request).
- overall: the answer of the reply as a whole. overall_said: one short sentence saying what the reply says, in plain words.
- answers: one per requested product the reply answers, with request_item set to its R number. If the request is not known, add one answer per product the reply names, with request_item null and product_hint the product's name as the reply or the subject says it.
- outcome:
  - 'accepted': they agree to the price asked, as asked. A bare "yes", "that's fine", "no problem", "done" or "we can do that" to the request is accepted.
  - 'counter_offer': they offer a different price. Put it in offer_price exactly as they wrote it (9.50 for "9.50" or "€9.50"); never work it out from anything else.
  - 'declined': they say no, cannot, or keep their price.
  - 'needs_info': they ask something before deciding (for example quantities or delivery). Put the question in question.
  - 'unclear': none of these can be told from the reply.
- said: the supplier's own words about it, at most 25 words, copied.
- offer_pack, for a counter_offer only (otherwise null):
  - 'stated' when they name a unit or pack: "per kg" = pack_size 1, pack_unit 'kg'; "per litre" = pack_size 1, pack_unit 'l'; "each" = pack_size 1, pack_unit 'each'; "per case of 6 x 2L" = units_per_case 6, pack_size 2, pack_unit 'l'.
  - 'requested' when they say "per pack", "per case", "per tub" or the like for the pack the request was about. When the request is not known (request_item null) and the subject or the quoted request names that pack (for example "Chicken breast fillets, 2kg"), use 'stated' with that pack instead.
  - 'unknown' when they give a bare price with no pack.
  - units_per_case 1 unless they name a case. pack_size, pack_unit and units_per_case are null unless offer_pack is 'stated'.
- price_includes_vat: true only if they say the price includes VAT.

Then the documents: one per source, the email body (source 'email body') and each attachment (source = its file name exactly as given).
- kind: 'quote' for a price quote, 'price_list' for a general price list, 'invoice' for a bill for goods already delivered (an invoice is read separately: return no lines), 'other' for anything else (a greeting, a refusal, a delivery note, a logo).
- The email body is 'other' with no lines when it only answers the request (yes, no, a counter-offer, a question) or only says "see attached". That answer goes in answers, never in lines. A body is a 'quote' only when it lists prices for products beyond what the answers cover.
- supplier_name: the business that sent it, as it names itself, or null.
- document_date: the quote or list date as YYYY-MM-DD (Irish dates are day first), or null.
- lines: one per product with a price. Copy description exactly as written: a product name, never a sentence. Do not add quantities or line totals: quotes have none.
- pack_price: the price for ONE pack or case as quoted. If the price is per kg, per litre or per item, set pack_size 1 with that pack_unit and use that price. Use null if the line has no price ("on request"), and never guess a price.
- Parse sizes from the description: '12x2LTR' = units_per_case 12, pack_size 2, pack_unit 'l'. '500G' = pack_size 500, pack_unit 'g', units_per_case 1. '3KG BAG' = pack_size 3, pack_unit 'kg'. 'X30' or 'TRAY 30' of countable items = pack_size 30, pack_unit 'each'. A single countable item = pack_size 1, pack_unit 'each'. '6 x 2L' = units_per_case 6, pack_size 2, pack_unit 'l'.
- Price tiers (for example 1-9 cases and 10+ cases): use the lowest quantity tier, and add the larger-quantity price as a separate line only if the description would otherwise be identical, naming the tier in the description.
- prices_include_vat: true only if the prices already include VAT. If a single VAT rate is shown, set vat_rate_percent.
- confidence: 0 to 1, how sure you are the whole line is read correctly. Under 0.7 for anything blurry, handwritten or partly hidden.
- Ignore quoted earlier messages in the thread and email signatures: only the newest message is the reply.`

export const BUSINESS = {
  name: 'The Corner Café',
  owner: 'Aoife',
  town: 'Cork',
}
