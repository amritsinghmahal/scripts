// ==UserScript==
// @name         Spinny Card Enricher
// @namespace    https://github.com/amritsinghmahal/scripts
// @version      3.0.0
// @description  Splits out the fees baked into every Spinny price, shows what is still owed on top of the figure printed on the card, adds km/year, days listed, owners, price cuts and ready-by dates - and strips the sale-discount pill and the "Save extra" loan banner.
// @match        https://www.spinny.com/*
// @connect      api.spinny.com
// @connect      www.spinny.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Spinny serves two different listing cards from the same build, chosen by an A/B flag, and
// they share not one selector. Version 2 was written against the wrong one: a headless browser
// gets the ds-* rebuild, a real browser gets the CarListingCardV2 card, so the script found
// zero cards and did nothing at all. Both are supported here, and there is a structural
// fallback for whatever comes third - see LAYOUTS.

(function () {
    'use strict';

    const VERSION = '3.0.0';

    const CONFIG = {
        // Everything except days-listed comes from this one batched call - 40 cars at a time,
        // about 18 KB. ?ids= is undocumented but honoured.
        listApi: 'https://api.spinny.com/v3/api/listing/v3/',
        // v3 carries available_on and the widest record. v7 is what the site itself calls and
        // answers the same query, so it stands in if v3 is retired.
        listApiFallback: 'https://api.spinny.com/v3/api/listing/v7/',
        // added_on lives here and nowhere else. See daysListedOf().
        detailApi: 'https://www.spinny.com/api/product-detail/fetch-page-data/',

        // The one enrichment that costs a request per car. false makes the script pay nothing
        // beyond one call per 40 cards.
        showDaysListed: true,

        // Adverts. The first two are on the CarListingCardV2 card only; the ds-* rebuild
        // dropped all three, in which case these rules match nothing and cost nothing.
        hideSalePill: true,
        hideLoanBanner: true,
        hideSlashedPrice: false,

        ttl: {
            car: 6 * 60 * 60 * 1000,
            carFail: 30 * 60 * 1000,
            // A first-listing date cannot change, so the day count is recomputed locally from
            // a month-old cache rather than re-fetched.
            addedOn: 30 * 24 * 60 * 60 * 1000,
            addedOnFail: 60 * 60 * 1000,
        },

        maxConcurrent: 4,
        requestGapMs: 120,
        batchSize: 40,
        batchWaitMs: 90,

        viewportMargin: 250,
        scanDebounceMs: 150,
        scanMaxWaitMs: 600,
        // Backstop sweep. Every event-driven trigger is a guess about when Spinny changes the
        // grid; this one needs no guess to be right.
        sweepMs: 1500,

        avgKmPerYear: 12000,
        freshDays: 14,
        staleDays: 60,
        minPriceCut: 5000,

        // A card is a card, not a page section. The legacy stylesheet caps the listing card at
        // max-width:560px and the widest measured is 314px, so this only ever excludes whole
        // sections that happen to be about one car - the hero on a car's own page above all.
        maxCardWidth: 700,

        debug: false,
        // Prints one line naming what it found if nothing has been drawn by then. This script
        // has now failed twice in ways that were invisible from the outside; this is cheap.
        complainAfterMs: 8000,
    };

    const LOG = (...a) => { if (CONFIG.debug) console.log('[spce]', ...a); };

    // The two cards Spinny ships. Tried in order; a page may contain both (a listing grid in
    // one layout can carry a similar-cars strip in the other), so all of them are swept.
    //
    // legacy - CarListingCardV2/V3. CSS-module names, derived from filenames rather than
    //          hashed, so they survive deploys. The heart carries the car id in data-label.
    // ds     - the design-system rebuild. Utility classes with no component names, but
    //          semantic ids instead: #shortlist_icon, #listing-detail-card-v2.
    const LAYOUTS = [
        {
            name: 'legacy',
            card: '[class*="carListingCardV2Root"],[class*="carListingCardV3Root"]',
            host: '[class*="productDetailContainer"]',
            heart: '[data-id="shortlist_icon"]',
        },
        {
            name: 'ds',
            card: '[data-base-component="card"],[data-id-componentname]',
            host: '[id^="listing-detail-card"]',
            heart: '[id="shortlist_icon"]',
        },
    ];

    // The padded text box under the photo, per component. A page can carry more than one kind
    // of card - a legacy listing grid also has a "You Might Like" carousel built from a third
    // component again - and the structural discovery below knows no layout at all, so every
    // box we know of is tried on every card.
    const HOSTS = [
        '[class*="productDetailContainer"]',   // legacy listing card
        '[id^="listing-detail-card"]',         // ds card
        '[class*="carDetailContainer"]',       // recommended-cars carousel
    ];

    // Every card in every layout links to its own car, so this is the one anchor that cannot
    // be broken by a rename. It backs both the id lookup and the fallback discovery below.
    // The home page is the exception - its cards carry no href at all - which is why the heart
    // is checked too.
    const CAR_LINK = 'a[href*="/buy-used-cars/"]';
    const CAR_ID = /\/(\d{5,})\/?(?:[?#]|$)/;
    const ANY_HEART = '[data-id="shortlist_icon"],[id="shortlist_icon"]';
    // data-category on the heart is the car's procurement tier on a listing card - assured,
    // budget, luxury, recommended-cars - and this on a car's own page.
    const HERO = 'product-page';

    const BLOCK = 'data-spce';

    /* -- the adverts -------------------------------------------------------- */

    // CSS, not node removal: React re-renders these cards, and !important is the only thing
    // that outranks the inline gradient Spinny paints onto the EMI row.
    function stripPromos() {
        if (document.getElementById('spce-css')) return;

        const rules = [];

        if (CONFIG.hideSalePill) {
            // A pink pill straddling the top edge of the photo, e.g. "₹9,000 / Ends today".
            // It restates the gap between the struck price and the headline, so it is the
            // third time one fact appears on one card.
            rules.push('[class*="specialOfferBadgeWrapper"]{display:none!important}');
        }

        if (CONFIG.hideLoanBanner) {
            // "Save extra ₹30.4K on" - finance.best.details.savings, the interest you would
            // save at Spinny's campaign rate versus their standard one. It is not money off
            // the car and only exists if you finance through them.
            //
            // This needs care: the banner is the first child of the <li> that also holds the
            // EMI figure, so hiding the <li> loses the EMI. Hide the banner alone, then clear
            // the pink gradient border, the rounded corner and the promo text colour Spinny
            // paints onto that row to match it - otherwise you get an empty pink box.
            rules.push('[class*="savingsWithLoanCampaign"]{display:none!important}');
            rules.push(
                'li[class*="ListingPricingDetail__emi"],li[class*="ListingPricingDetail__userEmi"]' +
                '{background:none!important;border-color:transparent!important;' +
                'border-radius:0!important;color:#2e054e!important;padding-left:0!important}'
            );
        }

        if (CONFIG.hideSlashedPrice) {
            rules.push('[class*="slashedPrice"]{display:none!important}');
        }

        if (!rules.length) return;

        const style = document.createElement('style');
        style.id = 'spce-css';
        style.textContent = rules.join('\n');

        const mount = document.head || document.documentElement;
        if (mount) mount.appendChild(style);
    }

    /* -- storage ----------------------------------------------------------- */

    // Every localStorage touch is wrapped: it throws outright in private mode and once the
    // origin's quota is full.
    const store = {
        // Bump when a cached record changes shape; older entries are then swept, not read.
        SCHEMA: 'v3',
        PREFIX: 'spce:',
        key(k) { return this.PREFIX + this.SCHEMA + ':' + k; },

        drop(staleOnly) {
            const mine = this.key('');
            try {
                Object.keys(localStorage)
                    .filter((k) => k.indexOf(this.PREFIX) === 0 && !(staleOnly && k.indexOf(mine) === 0))
                    .forEach((k) => localStorage.removeItem(k));
            } catch (e) { /* private mode */ }
        },

        get(k) {
            try {
                const raw = localStorage.getItem(this.key(k));
                if (!raw) return null;

                const rec = JSON.parse(raw);
                if (!rec || typeof rec.ts !== 'number') return null;
                if (Date.now() - rec.ts > rec.ttl) {
                    localStorage.removeItem(this.key(k));
                    return null;
                }
                return rec.v;
            } catch (e) {
                try { localStorage.removeItem(this.key(k)); } catch (_) {}
                return null;
            }
        },

        set(k, v, ttl) {
            const write = () => localStorage.setItem(this.key(k), JSON.stringify({ v, ts: Date.now(), ttl }));
            try {
                write();
            } catch (e) {
                this.evictCheap();
                try { write(); } catch (_) { /* the cache is only an optimisation */ }
            }
        },

        // A car record costs one fortieth of an 18 KB call to rebuild; a listing date costs a
        // 200 KB one. So the car records go first.
        evictCheap() {
            const dear = this.key('age:');
            try {
                const mine = Object.keys(localStorage).filter((k) => k.indexOf(this.PREFIX) === 0);
                const cheap = mine.filter((k) => k.indexOf(dear) !== 0);
                (cheap.length ? cheap : mine).forEach((k) => localStorage.removeItem(k));
            } catch (e) {}
        },
    };

    /* -- formatting -------------------------------------------------------- */

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const fmt = {
        // 717885 -> "7,17,885"
        grouped(n) {
            const s = String(Math.round(n));
            if (s.length <= 3) return s;
            return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
        },

        // 717885 -> "₹7.18L"
        lakh(n) {
            const l = n / 100000;
            if (l >= 100) return '₹' + (l / 100).toFixed(2) + 'Cr';
            return '₹' + l.toFixed(2) + 'L';
        },

        // 34591 -> "₹34.6k", 8421 -> "₹8.4k", 940 -> "₹940"
        compact(n) {
            if (n >= 100000) return this.lakh(n);
            if (n >= 1000) return '₹' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
            return '₹' + this.grouped(n);
        },

        rupees(n) { return '₹' + this.grouped(n); },

        // 13925 -> "13.9K", to read alongside the card's own "57K km" badge.
        km(n) {
            if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
            return this.grouped(n);
        },

        day(iso) {
            const t = parseIst(iso);
            if (t === null) return '';
            const d = new Date(t);
            return d.getDate() + ' ' + MONTHS[d.getMonth()];
        },

        ordinal(n) {
            const suffix = ['th', 'st', 'nd', 'rd'];
            const v = n % 100;
            return n + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
        },
    };

    // Spinny's timestamps are naive IST strings, so the +05:30 offset has to be stated.
    function parseIst(s) {
        if (!s) return null;
        const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + '+05:30');
        return isFinite(t) ? t : null;
    }

    function daysSince(iso) {
        const t = parseIst(iso);
        if (t === null) return null;
        // Floor here, ceil in daysUntil: a car added four hours ago was listed today.
        return Math.max(0, Math.floor((Date.now() - t) / 86400000));
    }

    function daysUntil(iso) {
        const t = parseIst(iso);
        if (t === null) return null;
        return Math.ceil((t - Date.now()) / 86400000);
    }

    /* -- http -------------------------------------------------------------- */

    const gate = {
        active: 0,
        queue: [],

        run(fn) {
            return new Promise((resolve, reject) => {
                this.queue.push({ fn, resolve, reject });
                this.pump();
            });
        },

        pump() {
            while (this.active < CONFIG.maxConcurrent && this.queue.length) {
                const job = this.queue.shift();
                this.active++;

                const release = () => {
                    this.active--;
                    setTimeout(() => this.pump(), CONFIG.requestGapMs);
                };

                job.fn().then(
                    (v) => { release(); job.resolve(v); },
                    (e) => { release(); job.reject(e); }
                );
            }
        },
    };

    function httpError(status) {
        const e = new Error('HTTP ' + status);
        e.status = status;
        return e;
    }

    // Both hosts send access-control-allow-origin for www.spinny.com, so plain fetch is the
    // fast path. GM_xmlhttpRequest is the fallback for the day that changes, and for any
    // userscript manager that sandboxes fetch away. credentials are omitted deliberately:
    // none of this needs the account.
    function httpGet(url) {
        let f = null;
        try { f = typeof fetch === 'function' ? fetch : null; } catch (e) { f = null; }
        if (!f) return gmGet(url);

        return f(url, { credentials: 'omit' })
            .then((r) => {
                if (!r.ok) throw httpError(r.status);
                return r.json();
            })
            .catch((err) => {
                if (err && err.status) throw err;
                return gmGet(url);
            });
    }

    function gmGet(url) {
        return new Promise((resolve, reject) => {
            const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
                : (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
            if (!gm) return reject(new Error('no GM_xmlhttpRequest'));

            gm({
                method: 'GET',
                url,
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) return reject(httpError(r.status));
                    try { resolve(JSON.parse(r.responseText)); }
                    catch (e) { reject(e); }
                },
                onerror: reject,
                ontimeout: reject,
            });
        });
    }

    // settle(err, raw) returns { v } to hand back uncached, or { v, ttl } to remember first.
    const inflight = new Map();

    function cachedFetch(cacheKey, request, settle) {
        const hit = store.get(cacheKey);
        if (hit) return Promise.resolve(hit);
        if (inflight.has(cacheKey)) return inflight.get(cacheKey);

        const p = gate.run(request)
            .then((raw) => settle(null, raw), (err) => settle(err, null))
            .then((rec) => {
                if (rec.ttl) store.set(cacheKey, rec.v, rec.ttl);
                inflight.delete(cacheKey);
                return rec.v;
            });

        inflight.set(cacheKey, p);
        return p;
    }

    /* -- the price --------------------------------------------------------- */

    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

    // One add-on's value is the string "included", so anything non-numeric counts as zero.
    const sumLines = (list) => (Array.isArray(list) ? list.reduce((t, l) => t + num(l && l.value), 0) : 0);

    // Spinny's price is four quantities deep and the card prints the second one:
    //
    //   base_listing_price                       the car
    // + base_add_on_data_list                    servicing, warranty, FASTag, fuel
    // = listing_price_without_tax                <- WHAT THE CARD SHOWS, both layouts
    // + mandatory_paid_add_ons_data_list         RC transfer, insurance
    // + tax_add_on_data_list                     TCS, and a transfer_tax in Gujarat
    // = listing_price_without_gst                <- what the heart carries in data-price
    // + gst                                      GST on the whole lot
    // = listing_price                            <- WHAT YOU ACTUALLY PAY
    //
    // Both identities hold on 420 of 420 cars sampled across seven cities, so the stated
    // totals are authoritative and the line items only itemise them for the tooltip.
    function priceOf(car) {
        const v3 = car.price_breakdown_v3;
        const b = v3 || car.price_breakdown_v2;
        if (!b) return null;

        const base = num(b.base_listing_price);
        const inside = sumLines(b.base_add_on_data_list);
        const mandatory = sumLines(b.mandatory_paid_add_ons_data_list);
        const taxes = sumLines(b.tax_add_on_data_list);
        const gst = num(b.gst && b.gst.value);

        const allIn = num(b.listing_price) || base + inside + mandatory + taxes + gst;
        // v2 names this field for a different quantity - it folds the mandatory add-ons in -
        // so only v3 can say what the card is printing. Without v3 no on-top figure is claimed.
        const shown = v3 ? num(v3.listing_price_without_tax) || base + inside : 0;

        if (!(base > 0) || !(allIn >= base)) return null;

        const lines = [];
        const add = (l, where) => {
            if (!l || !l.display_name) return;
            lines.push({
                label: l.display_name,
                amount: typeof l.value === 'number' ? l.value : null,
                where,
            });
        };
        for (const l of b.base_add_on_data_list || []) add(l, 'in');
        for (const l of b.mandatory_paid_add_ons_data_list || []) add(l, 'on');
        for (const l of b.tax_add_on_data_list || []) add(l, 'on');
        add(b.gst, 'on');

        const usable = shown > 0 && shown < allIn;

        return {
            base,
            allIn,
            shown: usable ? shown : 0,
            fees: allIn - base,
            onTop: usable ? allIn - shown : 0,
            lines,
            sale: saleOf(car),
            cut: cutOf(car),
        };
    }

    // price_breakdown_v2 keeps the previous price alongside the current one, and it moved the
    // car's own base price rather than the fees, so this is a genuine markdown, not a coupon.
    // Nothing on the site displays it.
    //
    // is_same_listing_price_update is not the gate it looks like - it reads false on 400 of the
    // 420 cars sampled, cut or not - so it is ignored. Both operands of each subtraction are
    // checked for a real value first: listing_price_without_gst is missing on the odd car, and
    // treating a missing current price as zero reports the entire price as a discount.
    function cutOf(car) {
        const v2 = car.price_breakdown_v2;
        if (!v2) return 0;

        const wasBase = num(v2.original_base_listing_price);
        const nowBase = num(v2.base_listing_price);
        const wasTotal = num(v2.original_price);
        const nowTotal = num(v2.listing_price_without_gst);

        const byBase = wasBase > 0 && nowBase > 0 ? wasBase - nowBase : 0;
        const byTotal = wasTotal > 0 && nowTotal > 0 ? wasTotal - nowTotal : 0;

        const cut = Math.max(byBase, byTotal);
        return cut >= CONFIG.minPriceCut ? cut : 0;
    }

    // A live sale is exactly when the price on the card needs explaining, so it goes in the
    // tooltip. This is the number the pink pill was restating.
    function saleOf(car) {
        for (const d of [car.discount_v3, car.discount]) {
            if (d && typeof d.value === 'number' && d.value > 0) return d.value;
        }
        return 0;
    }

    // Only what gets drawn is cached, not the 18 KB record it came from: localStorage is a few
    // megabytes for the whole origin and this has to hold a month of browsing.
    function distil(car) {
        const p = priceOf(car);
        if (!p) return null;

        return {
            // registration_year, not make_year: the odometer starts running at registration,
            // and registration year is what the card itself prints.
            year: num(car.registration_year) || num(car.make_year),
            km: num(car.mileage),
            owners: num(car.no_of_owners),
            readyOn: car.upcoming ? car.available_on || null : null,
            dead: !!(car.sold || car.soft_unpublish),
            p,
        };
    }

    /* -- car records, batched ---------------------------------------------- */

    const settleAll = (resolvers, value) => (resolvers || []).forEach((r) => r(value));

    const carData = {
        queue: new Map(),
        timer: null,
        stats: { requests: 0, found: 0, missed: 0, failed: 0 },

        get(id) {
            const hit = store.get('car:' + id);
            if (hit) return Promise.resolve(hit.miss ? null : hit.car);

            return new Promise((resolve) => {
                if (!this.queue.has(id)) this.queue.set(id, []);
                this.queue.get(id).push(resolve);

                if (this.queue.size >= CONFIG.batchSize) this.flush();
                else if (!this.timer) this.timer = setTimeout(() => this.flush(), CONFIG.batchWaitMs);
            });
        },

        flush() {
            clearTimeout(this.timer);
            this.timer = null;
            if (!this.queue.size) return;

            const batch = Array.from(this.queue.keys()).slice(0, CONFIG.batchSize);
            const waiting = new Map();
            for (const id of batch) {
                waiting.set(id, this.queue.get(id));
                this.queue.delete(id);
            }

            const query = '?ids=' + batch.join(',') + '&size=' + batch.length;
            this.stats.requests++;

            gate.run(() => httpGet(CONFIG.listApi + query)
                    .catch(() => httpGet(CONFIG.listApiFallback + query)))
                .then((data) => {
                    const found = new Map();
                    for (const car of (data && data.results) || []) {
                        if (car && car.id) found.set(String(car.id), car);
                    }

                    for (const id of batch) {
                        const raw = found.get(id);
                        const car = raw ? distil(raw) : null;
                        car ? this.stats.found++ : this.stats.missed++;
                        // Unknown ids are dropped from the response rather than returned null,
                        // so a miss is remembered briefly to stop it being asked for again.
                        store.set('car:' + id, car ? { car } : { miss: true },
                            car ? CONFIG.ttl.car : CONFIG.ttl.carFail);
                        settleAll(waiting.get(id), car);
                    }
                })
                .catch((e) => {
                    this.stats.failed++;
                    LOG('batch failed', e && e.message);
                    for (const id of batch) settleAll(waiting.get(id), null);
                })
                .then(() => { if (this.queue.size) this.flush(); });
        },
    };

    /* -- days listed ------------------------------------------------------- */

    // added_on is the field Spinny's own "Newest First" sort runs on - the sort parameter is
    // literally o=-added_on. It is on none of the batched endpoints: listing v3, v4, v5, v6, v7
    // and light/v5 all omit it, and none of them honour a field filter. So this is the one
    // request the script makes per card, for cards you actually scroll to, cached for a month.
    //
    // Do not substitute latest_publish_date. It is a republish stamp and it fails bimodally:
    // on the car this was written against it reads today, while added_on reads three days ago.
    function daysListedOf(id) {
        if (!CONFIG.showDaysListed) return Promise.resolve(null);

        return cachedFetch('age:' + id,
            () => httpGet(CONFIG.detailApi + encodeURIComponent(id) + '/'),
            (err, data) => {
                const detail = data && (data.productDetail || data.product_detail);
                const added = detail && detail.added_on;
                return added
                    ? { v: { added }, ttl: CONFIG.ttl.addedOn }
                    : { v: { miss: true }, ttl: CONFIG.ttl.addedOnFail };
            }
        ).then((rec) => (rec && rec.added ? daysSince(rec.added) : null));
    }

    /* -- what gets drawn --------------------------------------------------- */

    const PURPLE = '#2e054e';
    const GREY = '#5b5b66';

    const TONE = {
        // The neutral tone is the card's own badge: light grey behind Spinny purple.
        plain: { bg: '#f4f4f6', fg: PURPLE },
        good: { bg: '#e7f6ee', fg: '#116343' },
        warn: { bg: '#fdece9', fg: '#a33a2b' },
    };

    const css = (rules) => Object.keys(rules).map((k) => k + ':' + rules[k]).join(';');

    function priceParts(p) {
        const parts = [
            { text: fmt.lakh(p.allIn) + ' all-in', color: PURPLE, weight: 600 },
            { text: fmt.compact(p.fees) + ' fees', color: GREY, weight: 400 },
        ];
        if (p.onTop > 0) {
            parts.push({ text: fmt.compact(p.onTop) + ' on top', color: TONE.warn.fg, weight: 600 });
        }
        return parts;
    }

    function priceTip(p) {
        const itemise = (where) => p.lines
            .filter((l) => l.where === where)
            .map((l) => l.label + ' ' + (l.amount === null ? '(included)' : fmt.rupees(l.amount)))
            .join(', ');

        const inside = itemise('in');
        const onTop = itemise('on');

        return [
            'Car ' + fmt.rupees(p.base) + ' + ' + fmt.rupees(p.fees) + ' in fees = ' +
                fmt.rupees(p.allIn) + ' all-in.',
            p.onTop > 0
                ? 'The card shows ' + fmt.rupees(p.shown) + ', so ' + fmt.rupees(p.onTop) +
                  ' is still owed on top' + (onTop ? ' — ' + onTop : '') + '.'
                : '',
            inside ? 'Already inside the price shown: ' + inside + '.' : '',
            p.sale > 0 ? 'Includes a ' + fmt.rupees(p.sale) + ' sale discount.' : '',
            'All of it is mandatory. Same numbers as Spinny\'s own price popup.',
        ].filter(Boolean).join('\n');
    }

    // 58,000 km means very different things on a 2013 car and a 2021 one.
    function kmChip(car) {
        if (!(car.km > 0) || !(car.year > 0)) return null;

        const years = Math.max(1, new Date().getFullYear() - car.year);
        const perYear = Math.round(car.km / years);
        if (!(perYear > 0)) return null;

        const ratio = perYear / CONFIG.avgKmPerYear;
        return {
            text: fmt.km(perYear) + ' km/yr',
            tone: ratio <= 0.75 ? TONE.good : ratio >= 1.4 ? TONE.warn : TONE.plain,
            tip: fmt.grouped(car.km) + ' km over ' + years + (years === 1 ? ' year' : ' years') +
                ' since registration. About ' + fmt.grouped(CONFIG.avgKmPerYear) + ' km/yr is average.',
        };
    }

    function ageChip(days) {
        if (days === null || days < 0) return null;

        const stale = days > CONFIG.staleDays;
        return {
            text: days === 0 ? 'listed today' : 'listed ' + days + 'd',
            tone: days < CONFIG.freshDays ? TONE.good : stale ? TONE.warn : TONE.plain,
            tip: (days === 0
                ? 'First listed on Spinny today'
                : 'First listed on Spinny ' + days + (days === 1 ? ' day' : ' days') + ' ago') +
                (stale ? '. It has been sitting a while, so there may be room to negotiate.' : '.'),
        };
    }

    function cutChip(p) {
        if (!(p.cut > 0)) return null;
        return {
            text: 'price cut ' + fmt.compact(p.cut),
            tone: TONE.good,
            tip: 'Spinny has cut this car\'s base price by ' + fmt.rupees(p.cut) + ' and shows ' +
                'that nowhere. Read it against how long the car has been listed. No date for ' +
                'the cut is published, so none is claimed here.',
        };
    }

    // Never displayed on the card, though it moves resale value more than most of what is.
    function ownersChip(car) {
        if (!(car.owners > 1)) return null;
        return {
            text: fmt.ordinal(car.owners) + ' owner',
            tone: car.owners >= 3 ? TONE.warn : TONE.plain,
            tip: 'This car has had ' + car.owners + ' registered owners.',
        };
    }

    // Cars still in refurbishment get a wordless badge: you are told it isn't ready, never when.
    function readyChip(car) {
        if (!car.readyOn) return null;

        const days = daysUntil(car.readyOn);
        if (days === null) return null;

        return {
            text: 'ready ' + fmt.day(car.readyOn),
            tone: TONE.plain,
            tip: 'Still in refurbishment — available from ' + fmt.day(car.readyOn) +
                (days > 0 ? ', about ' + days + (days === 1 ? ' day' : ' days') + ' away' : '') + '.',
        };
    }

    /* -- drawing ----------------------------------------------------------- */

    function render(host, car, days) {
        let block = host.querySelector('[' + BLOCK + ']');
        if (!block) {
            block = document.createElement('div');
            block.setAttribute(BLOCK, '1');
            // A transparent click overlay covers the whole card at z-index 2 and swallows every
            // hover, so the block is lifted above it. The cost is that this strip does not open
            // the car - the right trade for being able to read the breakdown.
            block.style.cssText = css({
                position: 'relative',
                'z-index': 3,
                'margin-top': '8px',
                'font-family': 'inherit',
                cursor: 'default',
            });
            host.appendChild(block);
        }

        block.textContent = '';
        block.appendChild(priceRow(car.p));

        const chips = chipRow(car, days);
        if (chips) block.appendChild(chips);
    }

    function priceRow(p) {
        const row = document.createElement('div');
        row.style.cssText = css({
            display: 'flex',
            'flex-wrap': 'wrap',
            'align-items': 'baseline',
            'column-gap': '5px',
            'font-size': '13px',
            'line-height': '18px',
        });
        row.title = priceTip(p);

        priceParts(p).forEach((part, i) => {
            // The separator travels with the text it introduces, inside a nowrap wrapper. As a
            // flex item of its own it gets left dangling at the end of a wrapped line.
            const cell = document.createElement('span');
            cell.style.cssText = css({ 'white-space': 'nowrap' });

            if (i) {
                const sep = document.createElement('span');
                sep.textContent = '· ';
                sep.style.cssText = css({ color: '#b9b9c2' });
                cell.appendChild(sep);
            }

            const text = document.createElement('span');
            text.textContent = part.text;
            text.style.cssText = css({ color: part.color, 'font-weight': part.weight });
            cell.appendChild(text);

            row.appendChild(cell);
        });

        return row;
    }

    function chipRow(car, days) {
        // Explicit order: each fact arrives whenever its request finishes, and by insertion the
        // chips would shuffle between loads.
        const chips = [kmChip(car), ageChip(days), cutChip(car.p), ownersChip(car), readyChip(car)]
            .filter(Boolean);
        if (!chips.length) return null;

        const row = document.createElement('div');
        row.style.cssText = css({
            display: 'flex',
            'flex-wrap': 'wrap',
            gap: '4px',
            'margin-top': '6px',
        });

        for (const spec of chips) {
            const el = document.createElement('span');
            el.textContent = spec.text;
            el.title = spec.tip || '';
            el.style.cssText = css({
                display: 'inline-flex',
                'align-items': 'center',
                height: '20px',
                padding: '0 8px',
                'border-radius': '1000px',
                background: spec.tone.bg,
                color: spec.tone.fg,
                'font-size': '12px',
                'line-height': '16px',
                'font-weight': 500,
                'white-space': 'nowrap',
            });
            row.appendChild(el);
        }

        return row;
    }

    /* -- per card ---------------------------------------------------------- */

    const idFromHref = (href) => {
        const m = String(href || '').match(CAR_ID);
        return m ? m[1] : null;
    };

    // The heart carries the car's id outright in both layouts, which is the shortest path to
    // it. The link is the fallback, and its last path segment is the same number.
    function idOf(card, layout) {
        const heart = card.querySelector(layout ? layout.heart : ANY_HEART);
        const label = heart && heart.getAttribute('data-label');
        if (label && /^\d{5,}$/.test(label)) return label;

        const link = card.querySelector(CAR_LINK);
        return link ? idFromHref(link.getAttribute('href')) : null;
    }

    function hostOf(card, layout) {
        // The matching layout's own box first, then every other box we know of.
        if (layout) {
            const named = card.querySelector(layout.host);
            if (named) return named;
        }
        for (const sel of HOSTS) {
            const named = card.querySelector(sel);
            if (named) return named;
        }

        // Nothing recognised. The column holding the title is the next best thing, and failing
        // that the card itself - drawn at the bottom rather than not at all.
        const title = card.querySelector('h2,h3');
        if (title) {
            const col = title.closest('div[class*="ds-flex-col"],div[class*="etailContainer"],div[class*="ds-px"]');
            if (col && col !== card) return col;
        }
        return card;
    }

    const known = new WeakMap();   // card -> the distilled record
    const daysOf = new WeakMap();  // card -> days listed
    const layoutOf = new WeakMap();
    const idCache = new WeakMap();
    const hostCache = new WeakMap();
    const asked = new WeakSet();
    const agedAsked = new WeakSet();
    const broken = new WeakSet();

    // A subtree query each, repeated for every card on every sweep, and neither answer changes
    // for the life of a card node. Memoising them is most of the difference between a 42 ms
    // sweep and a 4 ms one once a few hundred cards have accumulated on a scrolled page.
    function idFor(card) {
        const hit = idCache.get(card);
        if (hit) return hit;

        const id = idOf(card, layoutOf.get(card));
        if (id) idCache.set(card, id);
        return id;
    }

    // React does replace the detail box under a card that survives, so a cached host is only
    // trusted while it is still attached and still inside its own card.
    function hostFor(card) {
        const hit = hostCache.get(card);
        if (hit && hit.isConnected && card.contains(hit)) return hit;

        const host = hostOf(card, layoutOf.get(card));
        if (host) hostCache.set(card, host);
        return host;
    }

    function draw(card) {
        const car = known.get(card);
        if (!car || car.dead) return;

        const host = hostFor(card);
        if (host) render(host, car, daysOf.has(card) ? daysOf.get(card) : null);
    }

    function sweepCard(card) {
        const id = idFor(card);
        if (!id) return;

        if (!known.has(card)) {
            if (!asked.has(card)) {
                asked.add(card);
                carData.get(id).then((car) => {
                    if (!car) return;
                    known.set(card, car);
                    draw(card);
                }).catch(() => {});
            }
            return;
        }

        // React replaces card subtrees on scroll and pagination, so a block that was drawn can
        // vanish. Redrawing it from the record already in hand costs no request.
        const host = hostFor(card);
        if (host && !host.querySelector('[' + BLOCK + ']')) draw(card);

        // The one enrichment that costs a request of its own, so it waits twice over: for the
        // card to be worth one, and for the record above to have landed. That second wait is
        // what keeps four concurrent 200 KB fetches from starving the 18 KB batch that every
        // card's price line depends on - without it the whole grid prices late.
        const car = known.get(card);
        if (CONFIG.showDaysListed && !car.dead && !agedAsked.has(card) && nearViewport(card)) {
            agedAsked.add(card);
            daysListedOf(id).then((days) => {
                if (days === null) return;
                daysOf.set(card, days);
                draw(card);
            }).catch(() => {});
        }
    }

    /* -- discovery --------------------------------------------------------- */

    // An IntersectionObserver is the wrong primitive for this grid. Spinny mounts cards lazily -
    // on a filtered page they can appear twenty seconds in, at zero height - and the observer's
    // first callback then reports every one of them as not intersecting. Nothing calls it again,
    // so the page stays bare. A plain sweep over the cards that exist right now, re-run on
    // anything that could have changed them, cannot get wedged that way.
    function nearViewport(card) {
        const r = card.getBoundingClientRect();
        if (!r.width && !r.height) return false;
        const margin = CONFIG.viewportMargin;
        return r.bottom > -margin && r.top < (window.innerHeight || 0) + margin;
    }

    // Grow outwards from something belonging to one car until the subtree covers a second one,
    // then step back. That node is the card, whatever it happens to be called. This is what
    // makes the script survive the next redesign: it needs no class name, no id and no data
    // attribute, only the fact that a card is about exactly one car.
    function growCard(seed, count) {
        let node = seed;
        let best = null;
        for (let depth = 0; node && depth < 12 && node !== document.body; depth++) {
            if (count(node) > 1) break;
            // Stop before climbing out of card-sized boxes into the page section around them.
            if (node.getBoundingClientRect().width > CONFIG.maxCardWidth) break;
            best = node;
            node = node.parentElement;
        }
        // A bare link or icon is not a card. Require room for a price line in it.
        return best && best !== seed && best.getBoundingClientRect().height >= 80 ? best : null;
    }

    const heartsIn = (node) => node.querySelectorAll(ANY_HEART).length;

    const carsIn = (node) => {
        const ids = new Set();
        for (const a of node.querySelectorAll(CAR_LINK)) {
            const id = idFromHref(a.getAttribute('href'));
            if (id) ids.add(id);
        }
        return ids.size;
    };

    function cardFromLink(link) {
        return idFromHref(link.getAttribute('href')) ? growCard(link, carsIn) : null;
    }

    function cardFromHeart(heart) {
        return growCard(heart, heartsIn);
    }

    // Every listing card in every component Spinny ships - legacy, ds, and the recommended-cars
    // carousel - carries exactly one shortlist heart, and it is the only thing that names the car
    // from inside the card. Requiring it is what keeps the script off page furniture: the home
    // page puts data-id-componentname on 338 nodes, most of which are not cards at all.
    function looksLikeCard(node, layout) {
        if (node.getBoundingClientRect().width > CONFIG.maxCardWidth) return false;

        const hearts = node.querySelectorAll(layout ? layout.heart : ANY_HEART);
        if (hearts.length !== 1) return false;
        // The hero on a car's own page carries a heart too, but it is a page section rather than
        // a card - and that page already itemises the price under the headline, which is the one
        // place Spinny does disclose it.
        if (hearts[0].getAttribute('data-category') === HERO) return false;

        // More than one car in scope makes this a strip rather than a card.
        return carsIn(node) <= 1;
    }

    // Used only when nothing above matched at all, so there is no heart to key on and the car
    // link is the only evidence left.
    function looksLikeCardByLink(node) {
        if (node.getBoundingClientRect().width > CONFIG.maxCardWidth) return false;
        if (node.querySelectorAll(ANY_HEART).length > 1) return false;
        return carsIn(node) === 1;
    }

    // Vetting a candidate costs a rect read and two subtree walks, and a node that is a card
    // stays one. Only acceptances are remembered: a rejection is often just a card React has not
    // finished mounting - zero hearts, zero width - and caching that would blank it permanently.
    const vetted = new WeakMap();

    function vet(node, layout) {
        if (vetted.has(node)) return vetted.get(node);
        if (!looksLikeCard(node, layout)) return undefined;
        vetted.set(node, layout);
        return layout;
    }

    function cardNodes() {
        const cands = new Map();   // node -> layout, or null when found structurally

        for (const layout of LAYOUTS) {
            for (const node of document.querySelectorAll(layout.card)) {
                if (cands.has(node)) continue;
                const ok = vet(node, layout);
                if (ok !== undefined) cands.set(node, ok);
            }
        }

        const covered = (el) => {
            for (let n = el; n; n = n.parentElement) if (cands.has(n)) return true;
            return false;
        };

        // Any heart outside every card found above belongs to a component nobody has named.
        // On a listing page that is the "You Might Like" carousel, a third card type sharing no
        // marker with either layout; growing outwards from the heart catches it without having
        // to name it, and will catch the fourth type too.
        for (const heart of document.querySelectorAll(ANY_HEART)) {
            if (covered(heart)) continue;
            const card = cardFromHeart(heart);
            if (card && !cands.has(card) && vet(card, null) !== undefined) cands.set(card, null);
        }

        // Links are the last resort, for a listing grid whose cards have lost their hearts.
        // Skipped on a car's own page: every second link there points at the page's own car -
        // 70 of them on the one measured - so this path would carpet the page instead of
        // finding cards.
        if (!cands.size && !idFromHref(location.pathname)) {
            for (const link of document.querySelectorAll(CAR_LINK)) {
                const card = cardFromLink(link);
                if (card && !cands.has(card) && looksLikeCardByLink(card)) cands.set(card, null);
            }
        }

        // Both layouts can mark nested nodes around one car - a [data-base-component="card"]
        // inside a [data-id-componentname] wrapper, say - and each would get its own block.
        // Keep the innermost: it is the one whose detail box belongs to this car.
        //
        // Done by walking each candidate's ancestors and dropping any that is also a candidate,
        // rather than testing every pair: at 676 cards the pairwise version is 450,000 contains()
        // calls per sweep.
        const outer = new Set();
        for (const node of cands.keys()) {
            for (let p = node.parentElement; p; p = p.parentElement) {
                if (cands.has(p)) outer.add(p);
            }
        }
        if (outer.size) for (const node of outer) cands.delete(node);

        return cands;
    }

    let lastSeen = { cards: 0, layouts: '' };

    function scan() {
        if (document.hidden) return;

        const found = cardNodes();
        const names = new Set();

        for (const [card, layout] of found) {
            if (layout) names.add(layout.name); else names.add('structural');
            if (broken.has(card)) continue;
            if (!layoutOf.has(card) && layout) layoutOf.set(card, layout);
            try {
                sweepCard(card);
            } catch (e) {
                // One unfamiliar card - a payload in a shape not seen, a node React is midway
                // through replacing - must never take the rest of the page with it, and must
                // not be retried forever either, or every sweep dies at the same card.
                broken.add(card);
                LOG('card threw, skipping it', e);
            }
        }

        lastSeen = { cards: found.size, layouts: Array.from(names).join('+') || 'none' };
    }

    let scanTimer = null;
    let scanAskedAt = 0;

    function scanSoon() {
        const now = Date.now();
        if (!scanAskedAt) scanAskedAt = now;

        const run = () => {
            clearTimeout(scanTimer);
            scanTimer = null;
            scanAskedAt = 0;
            scan();
        };

        if (now - scanAskedAt >= CONFIG.scanMaxWaitMs) return run();
        clearTimeout(scanTimer);
        scanTimer = setTimeout(run, CONFIG.scanDebounceMs);
    }

    // Our own block also mutates the page, so ignore records that only touch it.
    function onMutation(records) {
        for (const r of records) {
            const t = r.target;
            if (t && t.closest && t.closest('[' + BLOCK + ']')) continue;
            scanSoon();
            return;
        }
    }

    /* -- diagnostics ------------------------------------------------------- */

    function probe() {
        const count = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return 'err'; } };
        const out = { version: VERSION, url: location.href, layouts: {} };
        for (const l of LAYOUTS) {
            out.layouts[l.name] = { card: count(l.card), host: count(l.host), heart: count(l.heart) };
        }
        out.carLinks = count(CAR_LINK);
        out.cardsFound = lastSeen.cards;
        out.layoutInUse = lastSeen.layouts;
        out.blocksDrawn = count('[' + BLOCK + ']');
        out.promoCss = !!document.getElementById('spce-css');
        out.batches = Object.assign({}, carData.stats);
        out.canFetch = typeof fetch === 'function';
        out.canGM = typeof GM_xmlhttpRequest === 'function';
        try { localStorage.getItem('x'); out.storage = true; } catch (e) { out.storage = false; }
        return out;
    }

    // "It does nothing at all" has been the reported symptom twice, and both times the cause was
    // invisible without asking the page. One line, once, only when there is nothing to show.
    //
    // It asks three times before saying anything: a cold cache on a slow connection takes past
    // ten seconds to draw the first card, and a diagnostic that cries wolf on every first load
    // is worse than none.
    function complainIfIdle(attempt) {
        if (document.querySelector('[' + BLOCK + ']')) return;
        // Having nothing to enrich is not a fault. Plenty of pages under this @match carry no
        // cars at all - the FAQ, the sell flow, a blank tab - and complaining on those is noise.
        if (!document.querySelector(ANY_HEART) && !document.querySelector(CAR_LINK)) return;

        if (attempt < 2) {
            setTimeout(() => complainIfIdle(attempt + 1), CONFIG.complainAfterMs);
            return;
        }

        console.log(
            '[Spinny Card Enricher ' + VERSION + '] nothing drawn. Diagnostics:',
            probe(),
            '\nRun spinnyEnricher.probe() for this again, or spinnyEnricher.rescan() to retry.'
        );
    }

    /* -- start ------------------------------------------------------------- */

    // Order matters: every trigger is registered before the first sweep runs. Sweeping first
    // would mean a throw in that sweep silently costs us the observer, the listeners and the
    // backstop timer - one bad card at load and the script is dead for the session.
    function start() {
        try { store.drop(true); } catch (e) {}
        try { stripPromos(); } catch (e) {}

        // A liveness marker that survives the userscript sandbox, where an assignment to
        // window is invisible from the page's own console.
        try { document.documentElement.setAttribute('data-spce-version', VERSION); } catch (e) {}

        try {
            new MutationObserver(onMutation).observe(document.body || document.documentElement, {
                childList: true, subtree: true,
            });
        } catch (e) { LOG('observer failed', e); }

        // Scrolling is what brings a card into range, so it drives the sweep directly rather
        // than being inferred from a mutation.
        window.addEventListener('scroll', scanSoon, { passive: true });
        window.addEventListener('resize', scanSoon, { passive: true });
        window.addEventListener('popstate', scanSoon);
        document.addEventListener('visibilitychange', scanSoon);

        // The events above cover everything observed, but they are still a model of how Spinny
        // behaves, and this page has already broken two such models. A sweep is a WeakSet
        // lookup per card, so running it unconditionally costs nothing.
        setInterval(scan, CONFIG.sweepMs);
        setTimeout(() => complainIfIdle(0), CONFIG.complainAfterMs);

        scan();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    /* -- support hook ------------------------------------------------------ */

    const api = {
        version: VERSION,
        probe,
        status: probe,
        rescan: scan,
        clearCache() { store.drop(false); return 'cache cleared'; },
        CONFIG,
    };

    // unsafeWindow first: with any @grant the script runs in a sandbox whose window the page's
    // console cannot see, so an assignment there would leave nothing to type.
    try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow) unsafeWindow.spinnyEnricher = api;
    } catch (e) {}
    try { window.spinnyEnricher = api; } catch (e) {}

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            fmt, parseIst, daysSince, daysUntil, priceOf, cutOf, saleOf, distil, probe,
            kmChip, ageChip, cutChip, ownersChip, readyChip, priceTip, priceParts,
            idFromHref, LAYOUTS, CONFIG,
        };
    }
})();
