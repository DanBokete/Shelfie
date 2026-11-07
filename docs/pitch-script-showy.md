# Shelfie - 2-minute showtime pitch

The punchy version, built around five "wow" moments.
The calmer, step-by-step version is in [pitch-script.md](pitch-script.md).

Short lines, real pauses, and props.
Every wow is something happening live, not a claim on a slide.

## Roles

- **A** - the storyteller. Opens, closes, and plays the supplier from their phone.
- **B** - the driver. On the laptop the whole time, narrates the invoice and email parts.
- **C** - the showman. Holds the props and the phone, narrates the web and alerts parts.

The phone screen is mirrored onto the big screen (QuickTime or AirPlay), so the whole room sees it.

## 0:00 - 0:15 · A - Cold open

**Prop:** C holds up a real, crumpled, coffee-stained supplier invoice.

**Say (A):**

> This is how a café knows what it pays.
> *(pause)*
> A crumpled piece of paper in a drawer.
> Twenty-five of them, in three months, from three suppliers.
> Nobody reads them.
> So nobody notices the milk went up eleven percent.

## 0:15 - 0:30 · C - WOW 1: the paper comes alive

**Screen:** Phone mirrored. C photographs the crumpled invoice on the Invoices page.
Cut to the laptop as the lines appear.

**Say (C):**

> One photo.
> *(lines appear)*
> Every product, every price, read in seconds.
> "AVONM WHL 2LTR"? That's whole milk. Shelfie knows.

## 0:30 - 0:40 · B - WOW 2: the number

**Screen:** B clicks **Home**. Big white number: "You could save `[€___]` a year".

**Say (B):**

> Here's what's in that drawer.
> *(pause, let the room read it)*
> `[€___]` a year.
> For one small café.

## 0:40 - 0:55 · B - WOW 3: caught red-handed

**Screen:** B opens the 14 September Lee Valley invoice. The coffee line is flagged.

**Say (B):**

> And this one?
> Twelve bags at twenty-four euro.
> That's two eighty-eight.
> They charged three hundred and twelve.
> Shelfie caught it. A human never would.

## 0:55 - 1:15 · B, then C - Three emails, one tap

**Screen:** B clicks **Savings**, then **Fix all: one email per supplier**. Click **Send**.
Then **Live prices**: "You pay" next to "Cheapest online".

**Say (B):**

> One tap. Every supplier gets an email: match this price, or we go elsewhere.
> Sent from the owner's own Gmail.

**Say (C):**

> And we don't stop at their suppliers.
> Shelfie searches the web for everything they buy.
> Coffee: `[€___]` a kilo cheaper, one click from a quote.

*Meanwhile, A replies to the Lee Valley email on their phone.*

## 1:15 - 1:30 · C - WOW 4: the buzz

**Screen:** B presses **Check Gmail now**. The mirrored phone lights up with the Telegram alert.

**Say (C):**

> *(phone buzzes, hold it up)*
> That's Lee Valley.
> They said yes.
> Seconds ago, a supplier just agreed to cut their price - on this stage.

**Screen:** B opens the reply and clicks **Apply all better prices**.

## 1:30 - 1:45 · B - WOW 5: the twist

**Screen:** B drops a new Lee Valley invoice, dated next week, still charging the old milk price.
Shelfie flags that the agreed price was not honoured, and the phone buzzes again.

**Say (B):**

> But a promise is just words.
> Next week's invoice arrives - same old price.
> *(buzz)*
> Shelfie remembers what they agreed. And it tells you.

## 1:45 - 2:00 · A - Close

**Screen:** Back to **Home**, the big number.

**Say (A):**

> Tesco has a procurement team.
> The café down the road has a drawer of paper.
> *(C drops the crumpled invoice on the table)*
> Now they have Shelfie.
> Stop overpaying. In one tap.

## Making the wows safe

Every wow is live, so each one needs a rehearsal and a fallback.

- **WOW 1 (photo):** a new photo can't be served from `data/cache`, so this needs `ANTHROPIC_API_KEY`, internet and HTTPS on the phone (deployed URL or tunnel).
  Fallback: B drops a photo of the same invoice that was read once in rehearsal and is cached.
- **WOW 1, duplicates:** if the crumpled invoice is one of the 25 already loaded, Shelfie may flag it as a duplicate.
  Use a new invoice made for the pitch, or reset to a state without it.
- **WOW 2 (number):** fill the `[€___]` from the Home page after `/admin/reset` and the photo upload, and say the exact figure.
- **WOW 3 (bad maths):** open the 14 Sept invoice once in rehearsal so you know where the flag is and can click straight to it.
- **WOW 4 (buzz):** Lee Valley's email must be an address A can reply from on their phone.
  Have the reply ready to paste: "Yes, we can match those prices from next week."
  Test Telegram with "Send test message" on `/admin/reset`, and turn the phone volume up.
- **WOW 5 (twist):** make one extra Lee Valley invoice dated after today with the old milk price, and read it once in rehearsal so the reading is cached.
  The "not honoured" check is our code, so it fires once the agreed price from WOW 4 exists.
  Fallback: show "Prices not honoured" on the **Emails** page from a rehearsal run.
- Mirror the phone and check it shows on the projector before you start.
- Zoom the browser to about 125%.
- Record the full pitch once as a backup video in case Wi-Fi or a device fails.
- Rehearse with a timer at least three times.
  If you're over, cut WOW 3 first: it's the most skippable.
- The pauses are part of the show. Don't rush the number or the buzz.
