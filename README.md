# Shelfie

Shelfie tells independent food businesses where they are overpaying their suppliers, and helps them fix it in one tap.
It reads the owner's own supplier invoices, then answers "am I overpaying?" for one scanned item or a whole stock list.

This is TanStack Start (React, Vite, Tailwind), not Next.js.
Data lives in Supabase (Postgres and storage), and Claude reads documents and matches products.
Every number shown to the owner comes from `src/lib/units.ts` and `src/lib/savings.ts`, never from the model.

## Setup

Requirements: Node 22+, Docker (for local Supabase) and the Supabase CLI.

```bash
npm install
npx playwright install chromium   # only needed to regenerate mock invoices
supabase start                    # local Postgres, storage and API on ports 553xx
cp .env.example .env              # then fill in the two keys below
```

In `.env`:

- `ANTHROPIC_API_KEY`: your Claude API key.
- `SUPABASE_SERVICE_ROLE_KEY`: printed by `supabase status`.

```bash
npm run dev                       # http://localhost:3000
```

The phone camera needs HTTPS, so scan on the deployed Vercel URL (or an HTTPS tunnel) rather than `http://<laptop-ip>`.

## Demo data

```bash
npm run mock:generate     # regenerate data/ (invoices, price lists, stock lists, ground truth)
npm run demo:load         # wipe, then ingest all 25 invoices through Claude (3 at a time) and both price lists
npm run demo:accuracy     # extraction and matching accuracy against data/ground_truth.json
npm run demo:snapshot     # save the current database as the demo starting point
npm run demo -- seed-truth  # load ground truth directly, no AI (for UI work without an API key)
```

`/admin/reset` restores the snapshot in one tap.
Reset before every rehearsal and before going on stage.

### The fictional business

The Corner Café in Cork buys from Lee Valley Wholesale (weekly), Munster Fresh Foods (fortnightly) and Harbour Catering Supplies (occasional), August to October 2026.
Spend is about €1,900 a week ex VAT across 45 products.
The catalogue and every planted story are in `scripts/mock/catalogue.ts`:

| Story                   | Where                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Price creep             | Milk at Lee Valley rises 11% in five steps; butter rises 5%                           |
| Cheaper elsewhere       | Coffee beans 15% cheaper per kg at Munster Fresh, in a 3kg bag                        |
| Two prices, one product | Eggs from Lee Valley and Harbour in September and October                             |
| Name chaos              | `AVONM WHL 2LTR`, `Whole Milk 2L x6`, `Milk Full Fat 2 Litre`                         |
| Bad maths               | Coffee beans on the 14 Sept Lee Valley invoice (12 x 24.00 printed as 312.00)         |
| Unknown item            | Matcha powder on the stock lists only                                                 |
| Must not match          | Harbour's own-brand cola and tea vs Coca-Cola and Barry's; whole vs semi-skimmed milk |

Two invoices are rendered as phone photos and one as a handwritten docket.
Real crumpled photos are still worth adding by hand before the pitch.

### Before the pitch

- Put the real barcodes of the products you will scan into `barcode` in `scripts/mock/catalogue.ts`, or scan each one once on the phone and pick the product: the barcode is learned and every later scan is instant.
- Run the whole flow once with the API key, then set `DEMO_MODE=true` to serve every Claude answer from `data/cache` with no network.
  Photo identification of a new photo can't be cached, so rehearse scanning with barcodes.

## Reading supplier replies

When a supplier or seller replies to an "Ask to match" or "Ask for a quote" email with a quote, price list or invoice, Shelfie reads it and updates prices.
The email still goes out from the owner's own mail app (a `mailto:` link), so the link also CCs a per-request Shelfie address.
Reply-all copies Shelfie, and the address names the request, so the reply is tied to the right supplier and product.
If the supplier hits plain Reply instead, Shelfie falls back to the sender's email address, then their company domain.
A reply nothing matches is kept and shown under "Replies" on the Invoices page, where you pick the supplier to read it.

Setup (Postmark inbound):

1. In Postmark, open a server's Inbound stream. Its inbound address looks like `abc123@inbound.postmarkapp.com`. Put it in `INBOUND_EMAIL_ADDRESS`.
2. Set `INBOUND_WEBHOOK_SECRET` to a long random string.
3. Set the Inbound webhook URL to `https://<your-host>/api/email/inbound?secret=<that string>`. Locally, expose port 3000 with a tunnel (for example `cloudflared tunnel --url http://localhost:3000`) and use the tunnel URL.

What happens to a reply:

- Invoice attachments go through the normal invoice reader.
- Quotes and price lists (an attachment or the email body) become prices with source `quote`. They are matched to products like any other price, so the item screen and savings use them straight away.
- A line that is hard to read, or has no usable pack size, waits in "Check matches" and stays out of savings until you confirm it.
- When a quote is below what the owner pays now, `notifyBetterQuote` in `src/lib/alerts.server.ts` is called.
- Postmark may retry a webhook: each message is read once.

## How it works

```
invoice PDF/photo ─┐                       ┌─> item screen (scan)
stock list ────────┼─> extract ─> match ─> savings ─> audit report
barcode/photo ─────┘   (Claude)   (aliases,         └─> email draft (Claude writes, our numbers)
                                   barcode,
                                   shortlist,
                                   Claude)
```

- `src/lib/claude.server.ts`: the one wrapper for every Claude call.
  Structured outputs constrain the JSON to each zod schema in `src/lib/schemas.ts`, zod validates again, invalid output retries once then fails visibly.
  Server-side refusal fallback is on.
  Responses are cached to `data/cache` for demo mode.
- `src/lib/prompts.ts`: every prompt (P1 to P6 from the plan).
- `src/lib/invoices.server.ts`: Feature 1.
  Upload, extract, maths checks (`src/lib/checks.ts`), supplier lookup, duplicate detection, store, match.
- `src/lib/match.server.ts`: Feature 2.
  Alias lookup, barcode, token shortlist (`src/lib/tokens.ts`), one Claude call per invoice, 0.85 / 0.60 thresholds, aliases remembered.
- `src/routes/scan.tsx`, `src/routes/item.$productId.tsx`: Feature 3.
- `src/lib/stocklist.ts`, `src/lib/audit.server.ts`, `src/routes/audit.tsx`: Feature 4.
- `src/lib/email.server.ts`, `src/components/EmailModal.tsx`: Feature 5 (negotiation email and Fix all).
- `src/routes/api/*`: the plan's `/api/...` endpoints.
  Page reads and small writes are server functions in `src/server/fns.ts`.

### Decisions that differ from the plan

- The browser never talks to Supabase.
  Uploads go through `/api/invoices/extract`, all tables have RLS on with no policies, and `anon` has no grants.
  So there are no `VITE_SUPABASE_*` variables.
- Each invoice upload is one request that returns when extraction is done, so there is no realtime or polling.
- Lines with a reading or maths problem are left out of savings until the owner confirms them.
  Lines flagged only for a 60 to 85% match are used, as the matching rules say.
- Column detection sees the first 10 and last 5 rows, so totals and notes at the bottom of a sheet are skipped too.
- Local Supabase uses ports 553xx so it doesn't clash with other local projects.

### Not built yet

- Telegram weekly alert, price history chart (stretch goals).
- Vercel deployment.
  On Vercel, `data/cache` and `data/snapshot` are read-only, so demo mode and reset are meant for the local laptop setup.
