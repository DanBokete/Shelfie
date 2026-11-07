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

## Writing request emails

"Ask to match" and "Ask for a quote" emails are written from the owner's template (the default) or by Claude.
Settings, "Writing emails", sets the default; the email window has a switch to redo one email the other way, keeping the To and the reply address.
Templates make no model call, so they work with no `ANTHROPIC_API_KEY` and in `DEMO_MODE`.
Either way, every figure comes from our code; each saved draft records its `writer` (`template` or `ai`).

Template syntax (`src/lib/templates.ts`):

- `{name}` is a placeholder: `{supplier_name}`, `{owner_name}`, `{business_name}`, `{town}`, `{reply_by_date}`.
- A line holding only `{items}` starts the products list and a line holding only `{/items}` ends it.
  The lines between repeat once per product, and only there can `{product}`, `{pack}`, `{price_found}` and `{weekly_quantity}` be used.
  "Ask to match" also has `{your_price}`, `{target_price}` and `{reduction_percent}`; a quote request never can, so the seller never sees what the owner pays.
- Money is formatted as euro with cents. A line whose value is missing (for example no weekly quantity) is left out.
- Settings refuses to save a template with an unknown placeholder, a stray `{` or `}`, or a broken products list, and shows a live preview with sample figures.
  A template saved unchanged from the default is stored as null, so better default wording reaches it.

The quote request still looks up the seller's contact details on the web; without a key or internet the draft is written anyway and the owner adds the address.

## Reading supplier replies

When a supplier or seller replies to an "Ask to match" or "Ask for a quote" email with a quote, price list or invoice, Shelfie reads it and updates prices.
Everything goes through the owner's own Gmail account: Shelfie sends the request from it and reads the replies from it.
The owner presses "Connect Gmail" in Settings and signs in with Google once (see "Connect Gmail" below); Shelfie then uses the Gmail API.
Without a connection, a Gmail app password still works (SMTP and IMAP), and Postmark still works for an address on the owner's own domain.

- While the app is open, it checks Gmail every 2 minutes; "Check Gmail now" on the Invoices page and "Check now" in Settings run a check at once.
- Only replies to requests Shelfie sent are opened: emails in the same thread, and, if "Also read emails from the supplier's address" is on, new emails from the address the request went to. Nothing else in the mailbox is fetched, and emails stay unread.
- With Gmail connected, each request's Gmail thread is read with `users.threads.get`, using the thread id saved when it was sent. The history API was not used: it needs a stored `historyId` that Gmail expires after about a week, and it reports every change in the mailbox, while `threads.get` reads exactly the threads Shelfie started. Requests sent over SMTP before connecting are found once by their Message-ID (`rfc822msgid:`).
- With the app password, IMAP finds emails whose `In-Reply-To` or `References` names the request's Message-ID.
- A Gmail "could not deliver" notice is not a reply: it is noted on the request and shown at the top of Replies (for example a mistyped address).
- Requests are watched for 45 days. The code is in `src/lib/gmail-replies.server.ts`.

### Connect Gmail

Google needs an OAuth client for Shelfie, once per project (free):

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (for example "Shelfie").
2. Enable the Gmail API: APIs & Services, Library, "Gmail API", Enable.
3. Set up the consent screen (Google Auth Platform, called "OAuth consent screen" in older consoles): app name "Shelfie", user type External, your email as support and developer contact.
   Leave the publishing status on **Testing**, and under Audience add the demo Gmail address as a **test user**.
   Under Data Access, add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/gmail.send` and `.../auth/gmail.readonly`.
4. Create the client: Clients (or Credentials), Create client, type **Web application**.
   Add these Authorized redirect URIs, exactly:
   - `http://localhost:3000/api/auth/google/callback`
   - `http://localhost:3100/api/auth/google/callback` if you run the dev server on port 3100
   - `https://<your tunnel or deployed host>/api/auth/google/callback` for the phone or the deployed app
5. In `.env`, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the client, and `TOKEN_ENCRYPTION_KEY` to the output of `openssl rand -base64 32`. Restart.
6. In Settings, press "Connect Gmail", sign in as the test user, and leave both Gmail permissions ticked. Settings shows "Connected as <address>"; sending and reading replies both show "Ready".

Good to know:

- In Testing mode, Google shows a "Google hasn't verified this app" warning: press Continue. Only test users can sign in.
- In Testing mode, Google ends the sign-in after 7 days. Settings and Replies then show "Reconnect Gmail"; press it and sign in again. The same happens if access is removed at myaccount.google.com/permissions.
- A public launch needs Google's app verification. `gmail.readonly` is a restricted scope, so it also needs a yearly third-party security assessment.
- Shelfie keeps only the refresh token, encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) in the `email_accounts` table, and never sends it to the browser. Changing the key means connecting again. Disconnect revokes the token with Google and deletes the row.
- A demo reset (`/admin/reset`) keeps the connection.
- The app has no login: anyone who can open it can connect or disconnect Gmail. That is fine on the demo laptop, but not on a public URL.

Without connecting, with an app password instead: turn on 2-Step Verification for the Google account, create an app password at myaccount.google.com/apppasswords, put it in `GMAIL_APP_PASSWORD` and restart, then enter that Gmail address in Settings.

What happens to a reply:

- Invoice attachments go through the normal invoice reader.
- Quotes and price lists (an attachment or the email body) become prices with source `quote`. They are matched to products like any other price, so the item screen and savings use them straight away.
- A line that is hard to read, or has no usable pack size, waits in "Check matches" and stays out of savings until you confirm it.
- When a quote is below what the owner pays now, `notifyBetterQuote` in `src/lib/alerts.server.ts` sends a Telegram alert (see below).
- Each email is read once, however many times Gmail is checked.

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
barcode/photo ─────┘   (Claude)   (aliases,         └─> email draft (template or Claude, our numbers)
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
- `src/lib/email.server.ts`, `src/lib/templates.ts`, `src/components/EmailModal.tsx`: Feature 5 (negotiation email and Fix all).
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
