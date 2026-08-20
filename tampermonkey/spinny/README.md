# Spinny Card Enricher

A userscript that adds five facts to every car card on [spinny.com](https://www.spinny.com):

1. **What the car actually costs all-in** — and how much of that is fees rather than car.
2. **How much is still owed on top** of the price printed on the card.
3. **How hard it has been driven** — kilometres per year, not just total odometer.
4. **How long it has been listed** — from the field Spinny's own "Newest First" sort runs on.
5. **Whether the price has been cut**, how many owners it has had, and when it will be ready if
   it is still in refurbishment.

![what it looks like](docs/preview.png)

---

## Why bother?

Spinny quotes you **₹7.06 Lakh** for a 2018 Swift. You will pay **₹7,17,885**.

Nothing on the card says so. The card is printing the *third* of five figures Spinny computes:

```
base_listing_price                    ₹6,83,294    the car
+ base_add_on_data_list                 ₹22,285    servicing, warranty, FASTag, fuel
= listing_price_without_tax           ₹7,05,579    ← WHAT THE CARD SHOWS
+ mandatory_paid_add_ons_data_list       ₹8,421    RC transfer, insurance
+ tax_add_on_data_list                       ₹0    TCS, and a transfer_tax in Gujarat
= listing_price_without_gst           ₹7,14,000
+ gst                                    ₹3,885    GST on the whole lot
= listing_price                       ₹7,17,885    ← WHAT YOU ACTUALLY PAY
```

So the card understates the price by ₹12,306, and of the ₹7.06 Lakh it *does* quote, ₹22,285 is a
servicing bundle and a warranty rather than the car.

The script does that arithmetic on every card:

```
before      2018 Maruti Swift                      7.06 Lakh
            ZDi Plus AMT                    EMI ₹ 12,159/m*
            (57K km) (Diesel) (Automatic) (MH14)

after       2018 Maruti Swift                      7.06 Lakh
            ZDi Plus AMT                    EMI ₹ 12,159/m*
            (57K km) (Diesel) (Automatic) (MH14)
            ₹7.18L all-in · ₹34.6k fees · ₹12.3k on top
            (7.1K km/yr) (listed 1d)
```

Hover the price line for the itemised version:

> Car ₹6,83,294 + ₹34,591 in fees = ₹7,17,885 all-in.
> The card shows ₹7,05,579, so ₹12,306 is still owed on top — RC transfer facilitation ₹4,000,
> Insurance ₹4,421, GST (govt. taxes) ₹3,885.
> Already inside the price shown: Servicing, FASTag, fuel & more ₹11,700, Warranty (Protect)
> ₹10,585, Fixes & upgrades (included).
> All of it is mandatory. Same numbers as Spinny's own price popup.

This is not one unlucky listing. Across **420 cars in 7 cities**, every single one had fees baked
into the headline *and* more money owed on top of it — 420 of 420, both:

| | min | p25 | median | p75 | max |
|---|---|---|---|---|---|
| fees, total | ₹18,592 | ₹24,107 | **₹28,541** | ₹34,591 | ₹67,042 |
| of which owed on top of the price shown | ₹6,119 | ₹7,402 | **₹10,360** | ₹12,567 | ₹37,298 |
| fees as % of the price shown | 2% | 3% | **5%** | 6% | 13% |

Spinny does admit this on a car's own page, where the price carries a small
`+On-road charges & taxes`. On the listing grid it says nothing at all.

---

## The five things it adds

### 1. The all-in price and the fee split

On **every** card, from the same itemised breakdown the site's own price popup reads.

Spinny ships two breakdowns, `price_breakdown_v2` and `price_breakdown_v3`, and they use the same
field names for different quantities: v2 folds RC transfer and insurance into the servicing bundle,
v3 gives them their own list. They agree on the payable total and disagree on everything between,
so **only v3 can say what the card is printing**. Where v3 is missing the script prices the car but
claims no on-top figure, which is the failure mode you want.

Both identities above — `base + inside = listing_price_without_tax` and
`base + inside + mandatory + tax + gst = listing_price` — hold on **420 of 420** cars sampled
across Pune, Delhi, Bangalore, Mumbai, Hyderabad, Ahmedabad and Chennai. The stated totals are
therefore treated as authoritative and the line items are only used to itemise the tooltip.

Fee line names are **not** fixed nationally: alongside TCS there is a `transfer_tax` in Gujarat.
They are summed rather than named for that reason.

### 2. km per year

`58,032 km` means very different things on a 2013 car and a 2021 one, so the chip divides by age:

- **green** — under ~9,000 km/yr, an easy life
- **grey** — normal, around the 12,000 km/yr mark
- **red** — over ~17,000 km/yr, this one has worked

It divides by `registration_year`, not `make_year`, for two reasons: the odometer starts running at
registration, and registration year is what the card itself prints at the top.

### 3. Days listed

`listed today` / `listed 32d` / `listed 107d`, green under 14 days and amber over 60.

The field is `added_on`, and it is the one thing here that costs a request. It is on **none** of the
batched endpoints — listing `v3`, `v4`, `v5`, `v6`, `v7` and `light/v5` all omit it, and none of them
honour a `fields=` filter — so it comes from the per-car page-data route, about 200 KB. A first
listing date cannot change, so it is cached for a month and the day count recomputed locally, and it
is only fetched for cards you actually scroll to. Set `showDaysListed: false` if you would rather
not pay for it at all; everything else then costs one request per 40 cards.

**Do not substitute `latest_publish_date`.** It is a republish stamp and it fails bimodally: on most
cars it lands within seconds of the true date, so a spot-check looks perfect, and then a car that has
been listed 232 days reports 38. On the car this rewrite was verified against it reads *today* while
`added_on` reads three days earlier. `added_on` is the real thing, and the proof is that Spinny's own
"Newest First" sort is literally `o=-added_on`.

Spinny rounds this up; the script rounds down. A car added four hours ago was listed today.

### 4. Price cut

`price cut ₹90k` when Spinny has marked the car down, at a ₹5,000 floor.

`price_breakdown_v2` keeps the previous price alongside the current one, and it moved the car's own
*base* price rather than the fees, so this is a genuine markdown rather than a coupon. Nothing on the
site displays it.

Two things the previous version of this script got wrong here, both fixed:

- **`is_same_listing_price_update` is not the gate it looks like.** It reads `false` on **400 of 420**
  cars, cut or not, so gating on it does nothing. Cuts occur on cars where it is true as well.
- **The subtraction needs both operands checked.** `listing_price_without_gst` is absent on the odd
  car, and treating a missing current price as zero reports the *entire price* as a discount.

It fires on 22 of 420 cars. Read it next to days-listed, because the cut is largely a function of how
long the car has been sitting. Measured over 199 cards that had both values on screen at once:

| listed | cars | cut | rate |
|---|---|---|---|
| under 15 days | 158 | 9 | 5% |
| 15–30 days | 21 | 4 | 19% |
| 30–60 days | 12 | 5 | 41% |
| over 60 days | 8 | 5 | **62%** |

The largest cut found was **₹5.80L off a 2020 Mercedes C-Class that had been listed 336 days**.
Because the default sort is newest-first, you will see almost no cuts on the first screenful and
plenty by the last.

**No date is claimed.** `current_price_data.created_on` dates the last repricing, not the cut, and
its distribution is identical on cars that were cut and cars that never were. So it cannot carry the
claim and isn't used.

### 5. Owners and ready-by

**`2nd owner`** — shown only above one owner, so on about a quarter of cards. The card is *passed*
`no_of_owners` and uses it for exactly one thing: printing "Unregistered" instead of the RTO when the
count is zero. The number itself is never displayed, though it moves resale value more than most of
what is.

**`ready 23 Aug`** — for the ~17% of cars still in refurbishment. Spinny badges these `UPCOMING` and
tells you the car isn't ready, never when. `available_on` is an exact datetime.

---

## What it deliberately does *not* show

### "% off new"

The Cars24 version of this script shows how much cheaper a car is than that model new. Spinny appears
to hand you the same thing for free, in a per-car field called `on_road_price`. It is not, and finding
out took 5,086 cars across 21 cities plus archived price lists.

The field is keyed to the **variant name**, and its vintage is whenever that name was last priced. If
the name is still on sale the value is *today's* new price; if the name was retired the value is
frozen at retirement. That is fatal, because for half the inventory the field is today's price
against a car up to fifteen years old, with no per-card signal telling you which half you are in.
**22 of 65** populated cards would print above the 40% ceiling the Cars24 script enforces.

The corroborating damage, all measured:

- **Not keyed to the trim.** Of groups sharing one make, model, variant and year, **31.5%** have the
  field populated on some cars and `null` on their identical twins.
- **The denominator depends on capitalisation.** An Alto 800 `"Lxi"` is measured against ₹3,90,000 and
  an `"LXi"` against ₹3,63,000.
- **It is trim-inverted.** 2021 Tata Tiago: `XT` = ₹7,15,000 but `XZ` = ₹6,41,000. XZ is the *higher* trim.
- **It moves the wrong way with year.** Alto 800 LXi reads ₹3,90,000 for 2013–2016 and ₹3,63,000 for
  2016–2019. New cars do not get cheaper.
- **The error has no stable sign.** A 2025 Fronx reads 8.8% *above* Spinny's own current price.

Worst provable case: a 2016 Honda Amaze 1.5 VX i-DTEC would print **"61.4% off new"** against
₹11,02,900, when a March 2016 press report caps the *entire* Amaze range at ₹8.19 lakh ex-showroom.

Gating it honestly — provably frozen figure, canonical variant string, live catalogue match on fuel
and gearbox, plus an age ceiling — keeps **0 of 626** cards in Pune. There is no version of this pill
that survives its own suppression rules. No number is better than a wrong number, so that slot
carries the price cut instead, which is exact.

### The shortlist count

Removed at the owner's request, and it was the weakest thing here anyway: across a whole city it
correlates with days-listed at rho 0.89, so it was largely an age proxy wearing a demand costume. 532
saves on a car listed 303 days means a lot of people looked and passed.

Worth recording that it was **not** the cause of the breakage it was blamed for — `shortlist_count`
is still populated on 385 of 420 cars and still served fine. The real cause is below.

### Two other tempting fields

- **`market_price`** is `price × 1.10`–`1.13` — a fixed markup, not a valuation. Printing "₹40k below
  market" would launder marketing as signal, which is what this script exists to strip.
- **`base_warranty_cost`** varies from ₹3,193 to ₹32,490 and looks like a risk signal. It correlates
  with age at **−0.33** — the wrong sign. It prices brand and engine, not this car.

---

## Why version 2 is a rewrite

Version 1.2.1 stopped working entirely, and not because of anything it did. **Spinny rebuilt the
listing card.** The page moved off Next.js onto React Router and a `ds-*` design system, and every
anchor the old script depended on returned zero on the live page:

| selector | v1 relied on it for | now on the page |
|---|---|---|
| `carListingCardV2Root` | finding cards | **0** |
| `productDetailContainer` | where to draw | **0** |
| `priceWithRupeeSymbol` | reading the shown price | **0** |
| `data-id="shortlist_icon"` | reading the car's id | **0** |
| `ListingPricingDetail` | the EMI row | **0** |
| `__reactFiber$` on the card | the fallback data source | **absent** |

Ironically the replacements are *better* anchors: semantic ids and data attributes
(`#listing-detail-card-v2`, `#shortlist_icon`, `[data-base-component="card"]`) rather than
CSS-module names.

Two architectural things changed with it.

**It asks for the data instead of eavesdropping on it.** v1 patched `window.XMLHttpRequest` at
`document-start` to read Spinny's own listing calls, which meant winning a race it could not be
guaranteed to win, and required `@grant none` to stay in the page realm. v2 calls the API itself:
`api.spinny.com` honours an undocumented `?ids=` filter and returns
`access-control-allow-origin: https://www.spinny.com`, so 40 cars cost one ~18 KB request and
**nothing depends on when the script loaded**. Injected into a page that has already finished
rendering, it still enriches all 102 cards.

**The adverts are gone, so the code that hid them is too.** v1's headline feature was removing the
pink discount pill and the "Save extra ₹26.6K" loan banner. On the current site there are **0**
discount pills, **0** loan banners and **0** struck-through prices — Spinny removed all of it in the
redesign. Hiding things that no longer exist is dead code, so it went.

---

## Installing

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge or Safari).
2. Open [`spinny-card-enricher.user.js`](spinny-card-enricher.user.js), click **Raw**, and
   Tampermonkey will offer to install it.
3. Go to [spinny.com](https://www.spinny.com) and browse.

Nothing to configure. If you are upgrading from 1.x, the cache schema changed, so old entries are
swept on first run.

---

## Things worth knowing

**It only reads.** No clicking, no forms, no account — `credentials` are omitted from every request
on purpose. Everything comes from public endpoints and the same breakdown the site's own price popup
uses. It never sends your data anywhere.

**It is polite.** Four requests in flight at most with a gap between them, and results cached in your
browser. Only days-listed costs a request per car, and only for cards you actually scroll to.
Scrolling back over cars you have already seen costs nothing — a warm cache draws 62 cards with zero
network requests.

**Priority is deliberate.** The days-listed fetch waits for the card's record to arrive first.
Without that wait, four concurrent 200 KB fetches starve the 18 KB batch that every card's price line
depends on, and the whole grid prices late.

**The cache stores what gets drawn, not what arrived.** A distilled record is 523 bytes against the
15.5 KB it came from, which is what lets a month of browsing fit in localStorage. If the quota fills,
car records are evicted before listing dates, because a listing date costs 200 KB to rebuild and a
car record costs one fortieth of an 18 KB call.

**Nothing is overwritten.** Spinny's card is not height-locked, so the block is *appended* rather
than written over the top of something. Every card grows by one or two lines and the grid stays even.

**One strip is not clickable.** Spinny catches card clicks with a transparent overlay covering the
whole card at `z-index: 2`, which also swallows every hover. The block is lifted above it so its
tooltips work; the cost is that this one strip does not open the car. That seemed like the right trade
for being able to read the breakdown.

**Discovery is a sweep, not an `IntersectionObserver`.** Spinny mounts the grid lazily — on a filtered
page cards can appear twenty seconds in and at zero height — and an observer's first callback then
reports every one of them as not intersecting, after which nothing calls it again and the page stays
bare. A plain sweep over the cards that exist right now, re-run on scroll, resize, navigation, DOM
mutation, tab focus and a 1.5s backstop timer, cannot get wedged that way. A sweep is a `WeakSet`
lookup per card, so running it unconditionally costs nothing.

**It redraws itself.** React replaces card subtrees as you scroll and paginate, so a block that was
drawn can vanish. Each sweep notices and redraws from the record already in hand, with no request.
Heavy scrolling over 142 cards produced 142 blocks, no duplicates and no gaps.

**If it can't reach the network, it gets out of the way.** No error toasts, no broken layout. In
private mode Spinny's own app renders zero cards before this script gets a look in, and the script
survives a `localStorage` that throws on every access.

---

## When it breaks

Spinny is a live site and it will change.

**If something looks wrong, ask the script.** Open the console on a listing page and run:

```js
spinnyEnricher.status()
```

`ReferenceError: spinnyEnricher is not defined` means the script is not running at all — check it is
enabled in Tampermonkey and hard-reload. Otherwise it reports how many cards are on the page, how
many got drawn, how many have a record, whether the first card resolves to an id and a place to draw,
and how many entries are cached. That separates "not running" from "running but finding nothing".
`spinnyEnricher.rescan()` forces a sweep and `spinnyEnricher.clearCache()` empties the cache.

Likely failure modes:

- **Nothing appears anywhere, `cardsOnPage: 0`.** Card discovery, not the price logic. The script
  finds cards by `#shortlist_icon` and `[id^="listing-detail-card"]`; if both were renamed it finds
  nothing. Check what the card's outermost `data-base-component` / `data-id-componentname` is now.
- **`cardsOnPage` is right but `cardsWithRecord` is 0.** The API changed. Check
  `api.spinny.com/v3/api/listing/v3/?ids=<id>&size=1` in a tab; `listApiFallback` already points at
  v7 for when v3 retires.
- **Cards found and recorded but nothing drawn.** `hostOf()` found no place to put the block, or
  `priceOf()` declined. Turn on `debug: true` and it will name each card it skipped.
- **The price line appears but the fee split looks wrong.** The breakdown changed shape. The two
  identities in §1 are the test — if `base + inside` no longer equals `listing_price_without_tax`,
  the card is printing a different figure and `shown` needs re-deriving.
- **Days-listed stops appearing.** The page-data route moved or dropped `added_on`. Nothing else
  depends on it. Do not "fix" it with `latest_publish_date` — see §3.
- **The block is there but the tooltip won't show.** The click overlay's `z-index` went above 3.

One quirk worth recording, because it looks like a bug and isn't: Spinny's own check for whether a
sale is still running splits `end_time` on a `"T"` that its own space-separated timestamps do not
contain, so the expiry test never fires. The script does not copy the bug, but it does not enforce the
intent either — if a discount is in the price the card is showing, that price is the one that needs
explaining.

---

## A note on the numbers

Everything factual here was checked against live data, not assumed:

- The price model was verified on **420 cars across 7 cities**. Both identities hold on 420 of 420,
  and every car has fees inside the headline *and* money owed on top of it.
- The script was run against the live site in a real browser at every stage. On a Pune listing page it
  drew on **162 of 162** cards with none missing, none malformed and none overflowing; **82 of 82** on
  a brand-filtered page; **82 of 82** on a budget-filtered Bangalore page; **20 of 20** on the home
  page; **3 of 3** in the similar-cars strip on a car's own page.
- Injected *after* the page had fully loaded, it still drew **102 of 102** — the case v1's network tap
  could not recover from.
- With plain `fetch` blocked to force the `GM_xmlhttpRequest` fallback, 60 blocked attempts became 58
  GM requests and **62 of 62** cards were still drawn.
- 51 unit assertions cover the formatting, the IST timestamp handling, the price decomposition, the
  price-cut guards and every chip, including the `"included"` fee line whose value is a string.

---

## Licence

MIT. Do what you like with it.
