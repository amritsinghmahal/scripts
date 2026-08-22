# Spinny Card Enricher

A userscript that fixes two things about every car card on [spinny.com](https://www.spinny.com).

**It removes two adverts.**

1. The pink discount pill straddling the top of the photo — `₹9,000 · Ends today`.
2. The `Save extra ₹30.4K on` banner wrapped around the EMI figure.

**And it adds five facts.**

3. **What the car actually costs all-in** — and how much of that is fees rather than car.
4. **How much is still owed on top** of the price printed on the card.
5. **How hard it has been driven** — kilometres per year, not just total odometer.
6. **How long it has been listed** — from the field Spinny's own "Newest First" sort runs on.
7. **Whether the price has been cut**, how many owners it has had, and when it will be ready if it
   is still in refurbishment.

![what it looks like](docs/preview.png)

---

## Why bother?

Spinny quotes you **₹5.73 Lakh** for a 2020 Baleno. You will pay **₹5,84,048**.

Nothing on the card says so. The card prints the *second* of five figures Spinny computes:

```
base_listing_price                    ₹5,54,944    the car
+ base_add_on_data_list                 ₹17,635    servicing, warranty, FASTag, fuel
= listing_price_without_tax           ₹5,72,579    ← WHAT THE CARD SHOWS
+ mandatory_paid_add_ons_data_list       ₹8,421    RC transfer, insurance
+ tax_add_on_data_list                       ₹0    TCS, and a transfer_tax in Gujarat
= listing_price_without_gst            ₹5,81,000   ← what the heart carries in data-price
+ gst                                    ₹3,048    GST on the whole lot
= listing_price                       ₹5,84,048    ← WHAT YOU ACTUALLY PAY
```

So the card understates by ₹11,469, and of the ₹5.73 Lakh it *does* quote, ₹17,635 is a servicing
bundle and a warranty rather than the car.

The script does that arithmetic on every card:

```
before      2020 Maruti Baleno                     5.73 Lakh
            Zeta        Save extra ₹19.8K on  EMI ₹ 9,468
            (62K km) (Petrol) (Manual) (MH12)

after       2020 Maruti Baleno                     5.73 Lakh
            Zeta                             EMI ₹ 9,468
            (62K km) (Petrol) (Manual) (MH12)
            ₹5.84L all-in · ₹29.1k fees · ₹11.5k on top
            (5.3K km/yr) (listed 1d)
```

Hover the price line for the itemised version:

> Car ₹5,54,944 + ₹29,104 in fees = ₹5,84,048 all-in.
> The card shows ₹5,72,579, so ₹11,469 is still owed on top — RC transfer facilitation ₹4,000,
> Insurance ₹4,421, GST (govt. taxes) ₹3,048.
> Already inside the price shown: Servicing, FASTag, fuel & more ₹9,700, Warranty (Protect) ₹7,935,
> Fixes & upgrades (included).
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

## Spinny ships two different cards, and that is what broke this twice

This is the important part, because it is why version 2 of this script did nothing at all.

Spinny runs an A/B experiment on the listing page — `my_city_my_plp_exp`, a 50/50 split in their
GrowthBook config — and the two arms render **completely different card components that share not
one selector**:

| selector | `legacy` arm | `ds` arm |
|---|---|---|
| `carListingCardV2Root` | **22** | 0 |
| `productDetailContainer` | **22** | 0 |
| `priceWithRupeeSymbol` | **22** | 0 |
| `[data-id="shortlist_icon"]` | **42** | 0 |
| `[data-base-component="card"]` | 0 | **22** |
| `[id="listing-detail-card-v2"]` | 0 | **22** |
| `[id="shortlist_icon"]` | 0 | **22** |

Version 2 was written and tested entirely against the `ds` arm, because a **headless browser gets
bucketed differently from a real one** — and their config even contains a rule that forces bots into
a specific variant (`plp_inline_filter_modules` has `{"condition": {"isBot": true}, "force": true}`).
Every selector it used returned zero in a real Chrome. It found no cards, drew nothing, and there was
no symptom to read.

There is also a **third** card, which neither arm's selectors match: the "You Might Like" carousel at
the foot of a listing page, built from generic `styles__carContainer` / `styles__carDetailContainer`
names.

So version 3 does not pick a layout. It knows both, and it has a fallback for the next one:

1. **Named layouts** — `legacy` and `ds`, each with its own card, detail-box and heart selector.
2. **Grow from the heart** — for any heart not inside a card found in step 1, walk outwards until
   the subtree covers a second car, then step back. That node is the card, whatever it is called.
   This is what picks up the carousel, and it needs no class name, id or data attribute.
3. **Grow from the car link** — same idea, for a card with no heart at all. Last resort.

A candidate is only accepted if it holds **exactly one shortlist heart** and is no wider than 700px
(the legacy stylesheet caps the card at `max-width: 560px`). Both guards are load-bearing:

- Without the heart test, `[data-id-componentname]` matches **338** nodes on the home page, most of
  them page furniture, and the script draws a price line onto whole sections.
- Without the width test — and a specific exclusion for `data-category="product-page"` — the hero on
  a car's own page is treated as a card. It carries a heart, and 70 of that page's links point at its
  own car, so it collected three price lines in a box containing five hearts.

---

## The two things it removes

### The discount pill

`CarListingCardV2__specialOfferBadgeWrapper` — a pink pill absolutely positioned to straddle the top
edge of the photo. It is driven by `discount_v3.value` and it is the same number as the gap between
the struck-through price and the headline, so it is the third time one fact appears on one card.

It is hidden in CSS, not deleted. React re-renders these cards on scroll, hover and pagination, so a
removed node comes straight back.

### The "Save extra" banner

`LoanDiscountSavings__savingsWithLoanCampaign`. This one needs care, because it is **not** an
overlay — it is the first child of the `<li>` that also contains the EMI figure:

```html
<li class="ListingPricingDetail__emi" style="background: linear-gradient(white,white) padding-box,
        linear-gradient(to right, rgb(241,81,114) 60%, transparent 90%) border-box;">
  <span class="LoanDiscountSavings__savingsWithLoanCampaign">Save extra ₹19.8K on</span>
  EMI <span class="ListingPricingDetail__emiRupeeSymbol">₹</span>9,468
</li>
```

Hide the `<li>` and you lose the EMI. So the script hides only the banner, then clears the pink
gradient border, the left-rounded corner and the promo text colour Spinny paints onto that row to
match it — an *inline* gradient, so the override depends on `!important` outranking it. Otherwise you
get a pink box with nothing in it.

Worth knowing what the number was: `finance.best.details.savings`, the interest you would save over
the loan term at Spinny's campaign rate versus their standard one. It is not money off the car, and it
only exists if you finance through them.

The struck-through pre-sale price is left alone. Set `hideSlashedPrice: true` if you want it gone too.

On the `ds` arm none of these three exist, in which case the rules match nothing and cost nothing.

---

## The five things it adds

### 1. The all-in price and the fee split

On **every** card, from the same itemised breakdown the site's own price popup reads.

Spinny ships two breakdowns, `price_breakdown_v2` and `price_breakdown_v3`, and they use the same
field names for different quantities: v2 folds RC transfer and insurance into the servicing bundle,
v3 gives them their own list. They agree on the payable total and disagree on everything between, so
**only v3 can say what the card is printing**. Where v3 is missing the script prices the car but
claims no on-top figure, which is the failure mode you want.

Both identities above — `base + inside = listing_price_without_tax` and
`base + inside + mandatory + tax + gst = listing_price` — hold on **420 of 420** cars sampled across
Pune, Delhi, Bangalore, Mumbai, Hyderabad, Ahmedabad and Chennai, and the figure the card prints is
`listing_price_without_tax` on **both** arms. So the stated totals are treated as authoritative and
the line items only itemise the tooltip.

Fee line names are **not** fixed nationally: alongside TCS there is a `transfer_tax` in Gujarat. They
are summed rather than named for that reason.

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
is only fetched for cards you actually scroll to. Set `showDaysListed: false` and the script costs
one request per 40 cards and nothing else.

**Do not substitute `latest_publish_date`.** It is a republish stamp and it fails bimodally: on most
cars it lands within seconds of the true date, so a spot-check looks perfect, and then a car listed
232 days reports 38. On the car this was verified against it reads *today* while `added_on` reads
three days earlier. `added_on` is the real thing, and the proof is that Spinny's own "Newest First"
sort is literally `o=-added_on`.

Spinny rounds this up; the script rounds down. A car added four hours ago was listed today.

### 4. Price cut

`price cut ₹90k` when Spinny has marked the car down, at a ₹5,000 floor. It fires on 25 of 420 cars.

`price_breakdown_v2` keeps the previous price alongside the current one, and it moved the car's own
*base* price rather than the fees, so this is a genuine markdown rather than a coupon. Nothing on the
site displays it.

Two things earlier versions got wrong here, both fixed:

- **`is_same_listing_price_update` is not the gate it looks like.** It reads `false` on **400 of 420**
  cars, cut or not, so gating on it does nothing. Cuts occur where it is true as well.
- **The subtraction needs both operands checked.** `listing_price_without_gst` is absent on the odd
  car, and treating a missing current price as zero reports the *entire price* as a discount.

Read it next to days-listed, because the cut is largely a function of how long the car has been
sitting. Measured over 199 cards that had both values on screen at once:

| listed | cars | cut | rate |
|---|---|---|---|
| under 15 days | 158 | 9 | 5% |
| 15–30 days | 21 | 4 | 19% |
| 30–60 days | 12 | 5 | 41% |
| over 60 days | 8 | 5 | **62%** |

The largest cut found was **₹5.80L off a 2020 Mercedes C-Class listed 336 days**. Because the default
sort is newest-first, you will see almost no cuts on the first screenful and plenty by the last.

**No date is claimed.** `current_price_data.created_on` dates the last repricing, not the cut, and its
distribution is identical on cars that were cut and cars that never were. So it cannot carry the
claim and isn't used.

### 5. Owners and ready-by

**`2nd owner`** — shown only above one owner, so on about a quarter of cards. The card is *passed*
`no_of_owners` and uses it for exactly one thing: printing "Unregistered" instead of the RTO when the
count is zero. The number itself is never displayed, though it moves resale value more than most of
what is.

**`ready 25 Aug`** — for the ~17% of cars still in refurbishment. Spinny badges these `UPCOMING` and
tells you the car isn't ready, never when. `available_on` is an exact datetime.

---

## What it deliberately does *not* show

### The shortlist count

Removed at the owner's request — it is on the car's own page if you want it — and it was the weakest
thing here anyway: across a whole city it correlates with days-listed at rho 0.89, so it was largely
an age proxy wearing a demand costume. 532 saves on a car listed 303 days means a lot of people looked
and passed.

Worth recording that it was **not** the cause of either breakage it was blamed for. `shortlist_count`
is still populated on 385 of 420 cars and still serves fine. The causes were a lost network-tap race,
then the wrong card layout.

### "% off new"

The Cars24 version of this script shows how much cheaper a car is than that model new. Spinny appears
to hand you the same thing for free, in a per-car field called `on_road_price`. It is not, and finding
out took 5,086 cars across 21 cities plus archived price lists.

The field is keyed to the **variant name**, and its vintage is whenever that name was last priced. If
the name is still on sale the value is *today's* new price; if the name was retired the value is
frozen at retirement. That is fatal, because for half the inventory the field is today's price against
a car up to fifteen years old, with no per-card signal telling you which half you are in. **22 of 65**
populated cards would print above the 40% ceiling the Cars24 script enforces.

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

### Two other tempting fields

- **`market_price`** is `price × 1.10`–`1.13` — a fixed markup, not a valuation. Printing "₹40k below
  market" would launder marketing as signal, which is what this script exists to strip.
- **`base_warranty_cost`** varies from ₹3,193 to ₹32,490 and looks like a risk signal. It correlates
  with age at **−0.33** — the wrong sign. It prices brand and engine, not this car.

---

## Installing

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge or Safari).
2. Open [`spinny-card-enricher.user.js`](spinny-card-enricher.user.js), click **Raw**, and
   Tampermonkey will offer to install it.
3. Go to [spinny.com](https://www.spinny.com) and browse.

Nothing to configure. Upgrading from an earlier version is safe: the cache schema changed, so old
entries are swept on first run.

---

## Things worth knowing

**It asks for the data rather than eavesdropping on it.** Version 1 patched
`window.XMLHttpRequest` at `document-start` to read Spinny's own listing calls, which meant winning a
race it could not be guaranteed to win, and required `@grant none` to stay in the page realm. This one
calls the API itself: `api.spinny.com` honours an undocumented `?ids=` filter and returns
`access-control-allow-origin: https://www.spinny.com`, so 40 cars cost one ~18 KB request and
**nothing depends on when the script loaded**. Injected into a page that has already finished
rendering, it still enriches all 122 cards.

**It only reads.** No clicking, no forms, no account — `credentials` are omitted from every request on
purpose. Everything comes from public endpoints and the same breakdown the site's own price popup uses.
It never sends your data anywhere.

**It is polite.** Four requests in flight at most with a gap between them, and results cached in your
browser. Only days-listed costs a request per car, and only for cards you actually scroll to.
Scrolling back over cars you have already seen costs nothing — a warm cache draws a whole page with
zero network requests.

**Priority is deliberate.** The days-listed fetch waits for the card's record to arrive first. Without
that wait, four concurrent 200 KB fetches starve the 18 KB batch that every card's price line depends
on, and the whole grid prices late.

**The cache stores what gets drawn, not what arrived.** A distilled record is 525 bytes against the
15.9 KB it came from, which is what lets a month of browsing fit in localStorage. If the quota fills,
car records are evicted before listing dates, because a listing date costs 200 KB to rebuild and a car
record costs one fortieth of an 18 KB call.

**Nothing is overwritten.** Spinny's card is not height-locked, so the block is *appended* rather than
written over the top of something. Every card grows by two lines and the grid stays even.

**One strip is not clickable.** Spinny catches card clicks with a transparent overlay covering the
whole card at `z-index: 2` — `Ripple__container` on the legacy card — which also swallows every hover.
The block is lifted above it so its tooltips work; the cost is that this one strip does not open the
car. That seemed like the right trade for being able to read the breakdown.

**Discovery is a sweep, not an `IntersectionObserver`.** Spinny mounts the grid lazily — on a filtered
page cards can appear twenty seconds in and at zero height — and an observer's first callback then
reports every one of them as not intersecting, after which nothing calls it again and the page stays
bare. A plain sweep over the cards that exist right now, re-run on scroll, resize, navigation, DOM
mutation, tab focus and a 1.5s backstop timer, cannot get wedged that way.

**It redraws itself.** React replaces card subtrees as you scroll and paginate, so a block that was
drawn can vanish. Each sweep notices and redraws from the record already in hand, with no request.

**The sweep stays cheap as the page grows.** Infinite scroll through a whole city leaves ~680 cards
mounted at once, and the expensive part of a sweep — a rect read and two subtree walks per candidate,
to decide whether it is a card and where its detail box is — never changes once answered. Those
answers are memoised per node, and the innermost-candidate de-duplication walks ancestors rather than
testing every pair, which at 676 cards is the difference between 450,000 `contains()` calls per sweep
and a few thousand. Measured over a session scrolled to 676 cards, that took the sweep from **42 ms to
12 ms**; at 202 cards it is 4.6 ms. Only acceptances are cached, never rejections — a card React has
not finished mounting has no heart and zero width, and remembering *that* would blank it for good.

**If it can't reach the network, it gets out of the way.** No error toasts, no broken layout. It
survives a `localStorage` that throws on every access, and falls back to `GM_xmlhttpRequest` if plain
`fetch` is ever blocked.

---

## When it breaks

Spinny is a live site, it will change, and it is running experiments while it does.

**First question: is it running at all?** In the console on a listing page:

```js
document.documentElement.dataset.spceVersion    // "3.0.0" if the script started
spinnyEnricher.probe()                          // what it can see
```

The attribute is checked first on purpose: with any `@grant`, Tampermonkey runs the script in a
sandbox whose `window` the page console cannot see, so `spinnyEnricher` can be missing even when the
script is working. `probe()` reports the version, how many cards each layout can see, how many
candidates were found, which discovery paths are in use, how many blocks are drawn, the batch
request tally, and whether `fetch`, `GM_xmlhttpRequest` and `localStorage` are available.

**It complains by itself.** If nothing has been drawn eight seconds after start, the script prints one
line to the console with that same diagnostic. "It does nothing at all" has been the reported symptom
twice now, and both times the cause was invisible without asking the page.

`spinnyEnricher.rescan()` forces a sweep; `spinnyEnricher.clearCache()` empties the cache.

Likely failure modes:

- **Nothing anywhere, and `probe()` shows `card: 0` for both layouts.** Spinny has shipped a third
  card component. The heart-growing fallback should still find it — if it hasn't, check whether the
  cards still carry a `shortlist_icon` heart, because that is the one thing discovery insists on.
- **`cardsFound` is right but `blocksDrawn` is 0.** No detail box was recognised. Add the new box's
  selector to `HOSTS`; the title-column fallback should be drawing it somewhere in the meantime.
- **`cardsFound` is right, blocks drawn, but no prices.** `probe().batches` will say: `failed` counts
  network errors, `missed` means the API returned nothing for those ids. `listApiFallback` already
  points at v7 for when v3 retires.
- **Price lines appear on whole page sections rather than cards.** A guard has been outgrown — either
  the one-heart rule or `maxCardWidth`. See the two-layouts section above for what each one prevents.
- **The fee split looks wrong.** The breakdown changed shape. The two identities in §1 are the test:
  if `base + inside` no longer equals `listing_price_without_tax`, the card prints a different figure
  and `shown` needs re-deriving.
- **The EMI row is pink and empty.** The banner is being hidden but the row's promo skin is not.
  Spinny paints that as an *inline* gradient, so the override depends on `!important` outranking it.
- **Days-listed stops appearing.** The page-data route moved or dropped `added_on`. Nothing else
  depends on it. Do not "fix" it with `latest_publish_date` — see §3.

One quirk worth recording, because it looks like a bug and isn't: Spinny's own check for whether a sale
is still running splits `end_time` on a `"T"` that its own space-separated timestamps do not contain,
so the expiry test never fires. The script does not copy the bug, but it does not enforce the intent
either — if a discount is in the price the card is showing, that price is the one that needs
explaining.

---

## A note on the numbers

Everything factual here was checked against live data, not assumed:

- The price model was verified on **420 cars across 7 cities**. Both identities hold on 420 of 420,
  and every car has fees inside the headline *and* money owed on top of it.
- **58 unit assertions** cover the formatting, the id extraction, the IST timestamp handling, the
  price decomposition, the price-cut guards and every chip — including the `"included"` fee line whose
  value is a string rather than a number.
- Run against the live site in a real browser on the `legacy` arm: **122 of 122** cards enriched on a
  Pune listing page with none missed and every block verified to sit in a box about exactly one car;
  **122 of 122** on a brand-filtered page; **122 of 122** on a budget-filtered Bangalore page;
  **21 of 21** on the home page; **4 of 4** in the similar-cars strip on a car's own page, with the
  page's own hero correctly left alone.
- Adverts, same page: **88 of 88** discount pills hidden, **102 of 102** loan banners hidden,
  **102 of 102** EMI figures still intact, and **0** rows left showing the pink gradient.
- Injected *after* the page had fully rendered, it still enriched **122 of 122**.
- All three card components were then built into one synthetic page and enriched together — `legacy`,
  `ds` and the carousel, 3 of 3, every all-in figure matching the API exactly — because the A/B arm a
  browser gets is not something the test can choose.

And it was run with every thrown error, unhandled promise rejection and `console.error` on the page
captured and attributed by stack trace, so faults in this script could be told apart from Spinny's own:

- **Zero** errors and **zero** unhandled rejections across a 22-second session on a listing page —
  deep scroll, scroll back, scroll forward, resize, `visibilitychange`, `popstate` — ending at
  **222 of 222** cards drawn, none empty, none duplicated.
- **Zero** on a session scrolled to **676 of 676** cards, and again after 40 forced re-sweeps.
- **Zero** while being actively broken: the API returning HTTP 500, returning HTML instead of JSON,
  returning valid JSON full of nulls and wrong types (`base_listing_price: "abc"`,
  `listing_price: {}`, `mileage: "lots"`, `available_on: "nonsense"`), rejecting outright with no
  `GM_xmlhttpRequest` to fall back to, and `localStorage` starting to throw on every access
  mid-session. Blocks already drawn stayed drawn, `probe()` kept answering, and the batch counters
  correctly reported `missed: 40, failed: 6`.
- **Zero** across SPA navigation: clicking into a car page, `history.back()`, `history.forward()`, and
  a synthetic `pushState` — with the listing grid re-enriching to 42 of 42 on the way back.
- **Zero** on the home page, a brand-filtered page, a budget-filtered page, a car's own page, and
  `/sell-used-car/` (a page with no cars at all, where it correctly does nothing and says nothing).
- **Zero** with plain `fetch` blocked so the `GM_xmlhttpRequest` path had to carry all 77 requests.
- Every drawn node checked for a parsed inline style and a resolved text colour: 0 failures across
  2,482 nodes. One `#spce-css` tag, never two. Tooltips confirmed reachable above Spinny's
  `z-index: 2` click overlay.
- A static pass for unused names and dead code: none.

---

## Licence

MIT. Do what you like with it.
