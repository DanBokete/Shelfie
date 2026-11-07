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
Shelfie sends the email itself, through the owner's Gmail account or Postmark (chosen in Settings), and CCs a per-request Shelfie address.
Reply-all copies Shelfie, and the address names the request, so the reply is tied to the right supplier and product.
If the supplier hits plain Reply instead, Shelfie falls back to the sender's email address, then their company domain.
A reply nothing matches is kept and shown under "Replies" on the Invoices page, where you pick the supplier to read it.

Setup. Everything except passwords and tokens is on the Settings page:

1. Sending, with Gmail (a personal `@gmail.com` address): turn on 2-Step Verification, create an app password at myaccount.google.com/apppasswords, put it in `GMAIL_APP_PASSWORD` and restart. In Settings choose "My Gmail account" and enter that Gmail address. Sent emails appear in your Gmail Sent folder.
   Or with Postmark (an address on your own domain; Postmark cannot send from `@gmail.com`): put the server's API token in `POSTMARK_SERVER_TOKEN` and restart, add the address as a confirmed Sender Signature, then choose "Postmark" in Settings. Until Postmark approves the account, it only sends to your own verified domains.
2. Inbound (Postmark, works without a domain): open the server's Inbound stream. Its inbound address looks like `abc123@inbound.postmarkapp.com`. Enter it as the Shelfie reply address in Settings (or `INBOUND_EMAIL_ADDRESS`).
3. In Settings, make a webhook secret and copy the webhook URL into Postmark's Inbound webhook. Locally, expose port 3000 with a tunnel (for example `cloudflared tunnel --url http://localhost:3000`) and use the tunnel URL.

What happens to a reply:

- Invoice attachments go through the normal invoice reader.
- Quotes and price lists (an attachment or the email body) become prices with source `quote`. They are matched to products like any other price, so the item screen and savings use them straight away.
- A line that is hard to read, or has no usable pack size, waits in "Check matches" and stays out of savings until you confirm it.
- When a quote is below what the owner pays now, `notifyBetterQuote` in `src/lib/alerts.server.ts` sends a Telegram alert (see below).
- Postmark may retry a webhook: each message is read once.

## Telegram alerts

The owner hears about better deals on Telegram without opening the app.
Every message is a fixed template in `src/lib/alerts.ts`, never written by a model, and every number in it comes from `src/lib/savings.ts`.

- A supplier's emailed quote is below what the owner pays.
- A web price check finds a price 5% or more below what the owner pays.
- The weekly summary: prices that went up 3% or more on this week's invoices, and the biggest saving not yet acted on (no email drafted about it since the current price).
  With the mock data, "this week" is the 7 days up to the latest invoice date, not up to today.
  The hidden "Send this week's alert" link at the bottom of the home page sends it now (`POST /api/alerts/send`); a real product would send it on a schedule.

Every attempt is recorded in `alerts_sent`, including failed ones.
The same deal (product, seller and price to the cent per litre, kg or item) is only sent once; a failed send can go again.
The weekly summary and test messages can be re-sent on purpose.
Sending never breaks the caller: with Telegram not set up or offline, reply scanning and price checks carry on, and `/admin/reset` shows the last failure.

Setup:

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts.
   It replies with a token like `123456789:AA...`.
   Put it in `TELEGRAM_BOT_TOKEN`.
2. On the demo phone, open the new bot (BotFather links to it) and press Start, or send it any message.
   A bot can only message someone who has started a chat with it.
3. Find the chat id:

   ```bash
   curl -s "https://api.telegram.org/bot<token>/getUpdates" | grep -oE '"chat":\{"id":-?[0-9]+'
   ```

   Put the number in `TELEGRAM_CHAT_ID`.
   If nothing comes back, send the bot another message and try again.

4. Set `APP_URL` to where the owner opens Shelfie, for example the deployed URL or a tunnel.
   Links in alerts point there.
5. Restart the dev server, open `/admin/reset` and press "Send test message".

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

- Price history chart (stretch goal).
- Sending the weekly Telegram summary on a schedule.
- Vercel deployment.
  On Vercel, `data/cache` and `data/snapshot` are read-only, so demo mode and reset are meant for the local laptop setup.
