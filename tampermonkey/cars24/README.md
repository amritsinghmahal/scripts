# Cars24 Card Enricher

A userscript that adds three things to every car card on [cars24.com](https://www.cars24.com):

1. **What the car actually costs** — the real drive-away price, not the teaser price.
2. **How much cheaper it is than buying that model new** — but only when that comparison is honest.
3. **How hard the car has been driven** — kilometres per year, not just total odometer.

![what it looks like](docs/preview.png)

---

## Why bother?

Cars24 shows you a price like **₹6.94 lakh**, and just underneath it, in small grey letters,
`+ other charges`.

Those other charges are RC transfer, insurance, a warranty and pre-sale servicing. They are not
optional and they are not small — between **₹33,000 and ₹56,000** on the cars I checked, which is
5–19% on top of the number you were quoted. To see them you have to click into a popup. On every
single car. One at a time.

This script just puts the real total on the card:

```
before        ₹8.06L   ₹6.94 lakh
              + other charges

after         ₹8.06L   ₹6.94 lakh
              ₹7.45L all-in · 5 yrs old
```

Hover it and you get the full breakdown:

> Total ₹7,44,713 — incl. RC transfer price ₹10,000, Third party insurance ₹2,474,
> Extended Warranty – 12 Months ₹27,000, Car Servicing Charges ₹11,000

Same numbers as the popup. You just don't have to go digging for them.

---

## The three things it shows

### 1. The all-in price

Appears on **every** card. It comes from the same place the site's own popup gets it, so it is not
an estimate — it is the price you would actually pay.

### 2. "% off new" — and why it is often missing

This is the honest bit, and it needs explaining, because you will notice it is blank a lot.

The idea sounds simple: look up what that model costs new today, subtract, show the gap. In practice
that produces nonsense, for two reasons.

**Car prices creep up every year.** A 2022 Honda City works out at "53% off" a new City. But a
four-year-old car has not lost half its value — Honda has simply raised the price of a new City a
lot since 2022. Most of that "discount" is inflation wearing a disguise. A 2015 City computes as 73%
off, which is even more meaningless.

**Some catalogue pages are fiction.** `cars24.com/new-cars/volkswagen/polo/` loads perfectly and is
titled "Volkswagen Polo Price in India 2026". Volkswagen stopped selling the Polo in India in 2022.
The page offers two trims — "Base Variant" at ₹8,00,002 and "Top Variant" at ₹14,00,000 — which are
placeholders, not cars you can buy. The page even claims `isDiscontinued: false`. Around 30 models
have pages like this. Trust them and you will confidently tell someone they are getting 58% off a
price that does not exist.

So the script only shows a percentage when it can stand behind it:

- the model is really still on sale (a genuine 404 means it is not — placeholder trims count as
  not-on-sale too);
- a specific trim matches, with the same fuel and gearbox;
- the saving is believable for the car's age — roughly 30% in year one, creeping to a 40% ceiling.
  Anything above that says more about years of price rises than about this particular car, so it is
  dropped.

Fail any of those and you get the plain facts instead — the car's age, or `not sold new`. **No
number is better than a wrong number.** Expect the percentage on recent cars; older stock mostly
shows its age instead.

When it does appear, it compares like with like: your city's on-road price against the used car's
all-in price, both including taxes and registration.

### 3. km per year

`58,802 km` means very different things on a 2013 car and a 2021 one. The pill under the wishlist
heart divides by the car's age so you can judge it at a glance:

- **green** — under ~9,000 km/yr, an easy life
- **grey** — normal, around the 12,000 km/yr Indian average
- **red** — over ~17,000 km/yr, this one has worked

---

## Installing

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge or Safari).
2. Open [`cars24-card-enricher.user.js`](cars24-card-enricher.user.js), click **Raw**, and
   Tampermonkey will offer to install it.
3. Go to [cars24.com](https://www.cars24.com) and browse. Cards fill in as you scroll.

Nothing to configure.

---

## Things worth knowing

**It only reads.** No clicking, no forms, no account. Everything comes from public pages and the
same endpoint the site's own price popup uses. It never sends your data anywhere.

**It is polite.** Four requests in flight at most, with a small gap between them, and results are
cached in your browser — prices for a day, new-car data for a week. Scrolling back over cars you
have already seen costs nothing.

**If it can't reach the network, it gets out of the way.** No error toasts, no broken layout: the
card just looks like it always did, with the site's own `+ other charges` label untouched.

**Nothing moves.** The all-in price is written into the slot the `+ other charges` label already
occupies — a fixed 19px, inside a fixed-height card that clips overflow. Adding a line would push
the location out of view, so it replaces instead of appends. Card heights never change and the grid
never shifts.

**Cards it skips.** Where Cars24 marks a price negotiable (private seller listings), there is no
fixed all-in figure to show, so it leaves those alone.

---

## When it breaks

Cars24 is a live site and it changes. Two likely failure modes:

- **The all-in price stops appearing.** The charges endpoint or its headers changed. The script
  fails quietly by design, so the card just reverts to normal.
- **"% off new" disappears everywhere.** The new-car pages changed shape. Two payload formats exist
  today — some pages inline all their data, some use back-references — and the parser handles both,
  but a third would need work.

Set `debug: true` at the top of the script and the console will tell you why each card decided what
it did (`too-good-to-be-true`, `variant-unmatched`, `discontinued`, and so on).

Model names are the other soft spot. Cars24's used listings and new-car catalogue do not always
agree — used "Wagon R 1.0" versus catalogue `wagon-r`, "Grand i10" versus `grand-i10-nios`. There is
a small alias table near the top of the file; add to it as you spot gaps.

Some misses are deliberate. An "XUV300" listing is the pre-2024 car, before Mahindra renamed it
XUV 3XO — so it is *not* aliased to the new name, because comparing them would compare two different
cars. Same for "Elite i20". These show `not sold new`, which is the truthful answer.

---

## A note on the numbers

Everything factual here was checked against live pages, not assumed:

- The all-in price was verified on 18 cars. In all 18, the API's base price matched the card's
  listed price exactly, and base + charges matched the stated total exactly.
- The percentage's age ceiling was tuned against real listings so that plausible savings (Creta 17%,
  Swift 22%, Kylaq 24%, Punch 27%, i20 38%) pass, and inflated ones (Slavia 47%, City 49%, City 53%)
  are rejected — with margin on both sides rather than a knife-edge fit.
- The "% off new" figure lands on a minority of cards. That is the intended outcome, not a bug.

---

## Licence

MIT. Do what you like with it.
