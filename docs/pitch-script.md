# Shelfie - 2-minute demo pitch

The app is on the big screen from the first second to the last.
Nobody touches slides.

## Roles

- **A** opens and closes, and plays the supplier: in the middle, A replies to Shelfie's email live from their phone.
- **B** drives the laptop for the whole pitch, and talks through the invoices and "Ask to match".
  One driver means no laptop handovers.
- **C** talks through the web prices and the alerts, and holds up the phone when Telegram buzzes.

Each beat has **Screen** (what B clicks) and **Say** (the lines).
Fill every `[€___]` from the app after `/admin/reset`, so what you say matches the screen.

## 0:00 - 0:12 · A - Hook

**Screen:** Home page, already open. Big number: "You could save `[€___]` a year".

**Say (A):**

> This is the Corner Café in Cork.
> Nineteen hundred euro a week to three suppliers.
> Shelfie read their invoices and found `[€___]` a year they're overpaying.
> Let us show you how.

## 0:12 - 0:30 · B - Invoices in

**Screen:**

1. Scroll to "Prices creeping up" on Home. Milk is at the top.
2. Click **Invoices** in the nav. Scroll "All invoices" so the phone photo and handwritten docket are visible.

**Say (B):**

> Milk went up eleven percent since August, in five small steps nobody noticed.
> Shelfie reads every invoice - PDFs, phone photos, even this handwritten docket.
> "AVONM WHL 2LTR" and "Milk Full Fat 2 Litre"? Same milk. Shelfie knows.

## 0:30 - 0:55 · B - Ask to match

**Screen:**

1. Click **Savings** in the nav ("Check your whole stock list"). The last report is already there.
2. Click **Fix all: one email per supplier**.
3. In the email window, point at the products and prices, then click **Send**.

**Say (B):**

> Here's their whole stock list: `[___]` products where they pay too much.
> One tap, and Shelfie writes to each supplier: "a competitor charges this - can you match it?"
> Every number comes from our code, not the AI.
> And it goes out from the owner's own Gmail.

*A quietly replies to the Lee Valley email on their phone (see "The live reply" below).*

## 0:55 - 1:25 · C - Check the web, ask for a quote

**Screen:**

1. Click **Live prices**. The coffee row shows "You pay" next to "Cheapest online".
2. Click the coffee row to open the product.
3. Click **Ask for a quote**. Show the seller's address filled in, then click **Send**.

**Say (C):**

> Their suppliers aren't the only ones selling coffee.
> Shelfie checks the web for everything they buy.
> They pay `[€___]` a kilo - online it's `[€___]`.
> One tap asks that seller for a quote.
> Shelfie finds the contact details itself, and never tells the seller what you pay now.

## 1:25 - 1:45 · C - The deal comes back

**Screen:**

1. Click **Invoices**, then **Check Gmail now**.
2. C holds up the phone as the Telegram alert arrives.
3. B clicks **Emails**, opens the reply under "Replies to review": "What they answered" shows **Accepted**.
4. Click **Apply all better prices**.

**Say (C):**

> The owner doesn't sit checking any of this.
> When a supplier replies, or the web finds a deal five percent cheaper, their phone buzzes.
> Lee Valley said yes. One tap, and that's the new price.
> If the next invoice doesn't honour it, Shelfie flags it.

## 1:45 - 2:00 · A - Close

**Screen:** B clicks back to **Home**.

**Say (A):**

> Big chains have procurement teams checking every invoice and shopping every price.
> The café down the road has the owner, at midnight, with a calculator.
> Shelfie is that procurement team, for `[€___]` a year back in their pocket.
> Shelfie: stop overpaying, in one tap.

## The live reply

The "Accepted" moment is real: Shelfie reads an actual reply from Gmail.

- Before the pitch, set Lee Valley Wholesale's email to an address A can reply from on their phone.
- Have the reply text ready to paste, for example: "Hi, yes, we can match those prices from next week. Thanks, Lee Valley."
- A replies during C's web segment (about 0:55), in the same thread as the email B just sent.
- B presses **Check Gmail now** at 1:25 rather than waiting: the app only checks by itself every 2 minutes.
- Backup if the reply is late: keep talking through the Live prices page for a few seconds, then press **Check Gmail now** again.

## Before going on stage

- Run `/admin/reset`, then upload the stock list once so the **Savings** report is already there.
- Run the web check on **Live prices** beforehand: each search can take up to a minute.
  On stage, only show the results.
- Do the "Ask for a quote" once in rehearsal with internet: without it the draft is written but the To is empty.
- Test Telegram with "Send test message" on `/admin/reset`.
  Phone volume up; laptop notifications off.
- Zoom the browser to about 125% so the back row can read the numbers.
- Have every page you need cached by clicking through once after the reset.
- Record a 2-minute screen capture of the whole flow as a backup in case Wi-Fi or a device fails.
- Rehearse with a timer at least three times.
  If you're over, cut "If the next invoice doesn't honour it" first, then the "AVONM" line.
