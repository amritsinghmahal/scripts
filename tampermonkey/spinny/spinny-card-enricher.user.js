// ==UserScript==
// @name         Spinny Card Enricher
// @namespace    https://github.com/amritsinghmahal/scripts
// @version      2.0.0
// @description  Splits out the fees baked into every Spinny price, shows what is still owed on top of the figure printed on the card, and adds km/year, days listed, owners, any price cut and the ready-by date.
// @match        https://www.spinny.com/*
// @connect      api.spinny.com
// @connect      www.spinny.com
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

// The previous version tapped window.XMLHttpRequest at document-start to read Spinny's own
// listing calls, which meant winning a race it could not be guaranteed to win. It asks the
// API for the cars itself instead: api.spinny.com answers an undocumented ?ids= filter and
// returns access-control-allow-origin: https://www.spinny.com, so a plain fetch from the page
// works and nothing depends on when the script loaded.

(function () {
    'use strict';

    const CONFIG = {
        // Everything except days-listed comes from this one batched call - 40 ids at a time,
        // about 18 KB gzipped. ?ids= is undocumented but honoured.
        listApi: 'https://api.spinny.com/v3/api/listing/v3/',
        // v3 carries available_on and the widest record. v7 is what the site itself calls now
        // and answers the same query, so it stands in if v3 is ever retired.
        listApiFallback: 'https://api.spinny.com/v3/api/listing/v7/',
        // added_on lives here and nowhere else. See daysListedOf().
        detailApi: 'https://www.spinny.com/api/product-detail/fetch-page-data/',

        // The one enrichment that costs a request per car. Set false to make the script pay
        // nothing beyond one call per 40 cards.
        showDaysListed: true,

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

        // How far outside the viewport a card still counts as worth paying a request for.
        viewportMargin: 250,
        // Debounce for the sweep, and the longest it may be deferred - a continuous scroll
        // would otherwise keep resetting the timer and starve it indefinitely.
        scanDebounceMs: 150,
        scanMaxWaitMs: 600,
        // Backstop sweep. Every event-driven trigger is a guess about when Spinny changes the
        // grid; this one needs no guess to be right.
        sweepMs: 1500,

        avgKmPerYear: 12000,
        freshDays: 14,
        staleDays: 60,
        minPriceCut: 5000,

        debug: false,
    };

    const LOG = (...a) => { if (CONFIG.debug) console.log('[spce]', ...a); };

    // Spinny rebuilt the listing card on a design system of ds-* utility classes, so the
    // CSS-module names the old version matched on (carListingCardV2Root, productDetailContainer,
    // priceWithRupeeSymbol) are all gone. What replaced them is better: ids and data-attributes
    // with semantic names, one set per card. Matched on a prefix so a -v3 bump still finds them.
    // Two card components are in play and they mark themselves differently: the grid card on
    // listing, search and home pages, and CarListingCardV3New in the similar-cars strip on a
    // car's own page, which lays the photo beside the details instead of above them.
    const SEL = {
        card: '[data-base-component="card"],[data-id-componentname]',
        detail: '[id^="listing-detail-card"]',
        heart: '[id="shortlist_icon"]',
        link: 'a[href*="/buy-used-cars/"]',
        title: 'h2',
    };

    const BLOCK = 'data-spce';

    /* -- storage ----------------------------------------------------------- */

    // Every localStorage touch is wrapped: it throws outright in private mode and once the
    // origin's quota is full.
    const store = {
        // Bump when a cached record changes shape; older entries are then swept, not read.
        SCHEMA: 'v2',
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
                try { write(); } catch (_) { /* the cache is an optimisation */ }
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

    // Both hosts send access-control-allow-origin for www.spinny.com, so plain fetch works and
    // is the fast path. GM_xmlhttpRequest is the fallback for the day that changes.
    // credentials are omitted deliberately: none of this needs the account.
    function httpGet(url) {
        return fetch(url, { credentials: 'omit' })
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
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no GM'));
            GM_xmlhttpRequest({
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
    // = listing_price_without_tax                <- WHAT THE CARD SHOWS
    // + mandatory_paid_add_ons_data_list         RC transfer, insurance
    // + tax_add_on_data_list                     TCS, and a transfer_tax in Gujarat
    // = listing_price_without_gst
    // + gst                                      GST on the whole lot
    // = listing_price                            <- WHAT YOU ACTUALLY PAY
    //
    // Both identities hold on 420 of 420 cars sampled across seven cities, so the stated
    // totals are taken as authoritative and the line items only itemise them for the tooltip.
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

        return {
            base,
            allIn,
            shown: shown > 0 && shown < allIn ? shown : 0,
            fees: allIn - base,
            onTop: shown > 0 && shown < allIn ? allIn - shown : 0,
            lines,
            sale: saleOf(car),
            cut: cutOf(car),
        };
    }

    // price_breakdown_v2 keeps the previous price alongside the current one, and it moved the
    // car's own base price rather than the fees, so this is a genuine markdown rather than a
    // coupon. Nothing on the site displays it.
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

    // Empty on every car sampled, so this only ever adds a line to the tooltip. It is here
    // because a live sale is exactly when the price on the card needs explaining.
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
                        // Unknown ids are dropped from the response rather than returned null,
                        // so a miss is remembered briefly to stop it being asked for again.
                        store.set('car:' + id, car ? { car } : { miss: true },
                            car ? CONFIG.ttl.car : CONFIG.ttl.carFail);
                        settleAll(waiting.get(id), car);
                    }
                })
                .catch(() => { for (const id of batch) settleAll(waiting.get(id), null); })
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
        // The neutral tone is the card's own badge: #f6f6f6 on #2e054e, fully round.
        plain: { bg: '#f6f6f6', fg: PURPLE },
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
                'font-family': 'SpinnyJost, inherit',
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
            // flex item of its own it gets left dangling at the end of a wrapped line, which is
            // what the 199px column in the similar-cars strip does to all three parts.
            const cell = document.createElement('span');
            cell.style.cssText = css({ 'white-space': 'nowrap' });

            if (i) {
                const sep = document.createElement('span');
                sep.textContent = '· ';
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

    // The heart carries the car's id outright, which is the shortest path to it. The link is
    // the fallback: its last path segment is the same number.
    function idOf(card) {
        const heart = card.querySelector(SEL.heart);
        const label = heart && heart.getAttribute('data-label');
        if (label && /^\d{5,}$/.test(label)) return label;

        const link = card.querySelector(SEL.link);
        const href = link ? link.getAttribute('href') || '' : '';
        const m = href.match(/\/(\d{5,})\/?(?:[?#]|$)/);
        return m ? m[1] : null;
    }

    function hostOf(card) {
        // The grid card names its detail box outright.
        const named = card.querySelector(SEL.detail);
        if (named) return named;

        // The strip card has no such box - its details are a column beside the photo - and if
        // that id is ever renamed the grid card won't either. The column holding the title is
        // the answer in both cases. It is only 199px wide in the strip, which is why the price
        // line and the chips are both allowed to wrap rather than being truncated.
        const title = card.querySelector(SEL.title);
        if (!title) return null;
        return title.closest('div[class*="ds-flex-col"]') || title.closest('div[class*="ds-px"]');
    }

    const known = new WeakMap();   // card -> the distilled record
    const daysOf = new WeakMap();  // card -> days listed
    const asked = new WeakSet();
    const agedAsked = new WeakSet();
    const broken = new WeakSet();

    function draw(card) {
        const car = known.get(card);
        if (!car || car.dead) return;

        const host = hostOf(card);
        if (host) render(host, car, daysOf.has(card) ? daysOf.get(card) : null);
    }

    function sweepCard(card) {
        const id = idOf(card);
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
        const host = hostOf(card);
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

    function cardNodes() {
        const out = new Set();

        const take = (node) => {
            const card = node.closest(SEL.card);
            // data-id-componentname also marks page-level containers - the listing grid itself
            // carries one - so anything holding more than one heart is a grid, not a car.
            if (card && card.querySelectorAll(SEL.heart).length <= 1) out.add(card);
        };

        for (const heart of document.querySelectorAll(SEL.heart)) take(heart);
        // The detail box is the thing actually needed, and not every layout is guaranteed to
        // carry the heart, so it gets a look-in of its own.
        for (const detail of document.querySelectorAll(SEL.detail)) take(detail);

        return out;
    }

    function scan() {
        if (document.hidden) return;

        for (const card of cardNodes()) {
            // One unfamiliar card - a payload in a shape not seen, a node React is midway
            // through replacing - must never take the rest of the page with it, and must not be
            // retried forever either, or every sweep dies at the same card.
            if (broken.has(card)) continue;
            try {
                sweepCard(card);
            } catch (e) {
                broken.add(card);
                LOG('card threw, skipping it', e);
            }
        }
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

    // Order matters: every trigger is registered before the first sweep runs. Sweeping first
    // would mean a throw in that sweep silently costs us the observer, the listeners and the
    // backstop timer - one bad card at load and the script is dead for the session.
    function start() {
        try { store.drop(true); } catch (e) {}

        new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true });

        // Scrolling is what brings a card into range, so it drives the sweep directly rather
        // than being inferred from a mutation.
        window.addEventListener('scroll', scanSoon, { passive: true });
        window.addEventListener('resize', scanSoon, { passive: true });
        window.addEventListener('popstate', scanSoon);
        document.addEventListener('visibilitychange', scanSoon);

        // The events above cover everything observed, but they are still a model of how Spinny
        // behaves, and this page has already broken one such model. A sweep is a WeakSet lookup
        // per card, so running it unconditionally costs nothing and removes the need for the
        // model to be complete.
        setInterval(scan, CONFIG.sweepMs);

        scan();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    /* -- support hook ------------------------------------------------------ */

    // This script has failed twice for reasons invisible from the outside, and both times the
    // only way to tell "not running" from "running but finding nothing" was to guess. Run
    // spinnyEnricher.status() in the console and it says which.
    const api = {
        version: '2.0.0',
        status() {
            const cards = Array.from(cardNodes());
            return {
                running: true,
                cardsOnPage: cards.length,
                cardsDrawn: document.querySelectorAll('[' + BLOCK + ']').length,
                cardsWithRecord: cards.filter((c) => known.has(c)).length,
                firstCardId: cards[0] ? idOf(cards[0]) : null,
                firstCardHasHost: cards[0] ? !!hostOf(cards[0]) : null,
                cached: (() => {
                    try {
                        return Object.keys(localStorage).filter((k) => k.indexOf(store.PREFIX) === 0).length;
                    } catch (e) { return null; }
                })(),
                pageHidden: document.hidden,
            };
        },
        rescan: scan,
        clearCache() { store.drop(false); return 'cache cleared'; },
        CONFIG,
    };

    try { (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).spinnyEnricher = api; }
    catch (e) { window.spinnyEnricher = api; }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            fmt, parseIst, daysSince, daysUntil, priceOf, cutOf, saleOf, distil,
            kmChip, ageChip, cutChip, ownersChip, readyChip, priceTip, priceParts, CONFIG,
        };
    }
})();
