// ==UserScript==
// @name         Cars24 Card Enricher
// @namespace    https://github.com/amrmahal/scripts
// @version      1.0.0
// @description  Puts the real drive-away price, an honest "% off new", and km/year on every Cars24 listing card.
// @author       amrmahal
// @match        https://www.cars24.com/*
// @connect      car-catalog-gateway-in.c24.tech
// @connect      www.cars24.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Three additions to each car card:
 *
 *   1. The all-in price. The grey "+ other charges" line hides RC transfer, insurance, warranty
 *      and servicing - between Rs 33,000 and Rs 56,000 on the cars I sampled, 5-19% on top of the
 *      headline. The site's own popup fetches those figures from /detail/v1/charges/{id}, which
 *      needs no login, so we ask for them directly and write the total where the teaser was.
 *
 *   2. How much cheaper this is than the same model new - but only when that holds up. Two traps
 *      make the naive version worthless:
 *
 *        - Car prices climb every year. A 2022 Honda City works out at "53% off" a new one; a
 *          2015 at "73% off". Most of that gap is the new car getting dearer, not this one losing
 *          value. An age-based ceiling throws those out.
 *        - Some catalogue pages are fiction. /new-cars/volkswagen/polo/ still answers 200 for a
 *          car pulled from India in 2022, offering "Base Variant" at Rs 8,00,002 with
 *          isDiscontinued:false. The flags cannot be trusted; the placeholder trim names can.
 *
 *      When a comparison cannot be made honestly the card shows the car's age, or says the model
 *      is no longer sold. No number beats a wrong number.
 *
 *   3. Kilometres per year, in a pill under the wishlist heart. 60,000 km reads very differently
 *      on a 2013 car than a 2021 one.
 *
 * Everything is read-only and cached in localStorage. If the network is unavailable the card is
 * left exactly as the site drew it.
 */

(function () {
    'use strict';

    /* ---------------------------------------------------------------------- *
     * CONFIG
     * ---------------------------------------------------------------------- */

    const CONFIG = {
        // Endpoint behind the "+ other charges" popup (lazy chunk tax-price-breakup-popup).
        chargesApi: 'https://car-catalog-gateway-in.c24.tech/detail/v1/charges/',
        chargesHeaders: { X_TENANT_ID: 'INDIA_CAR_LISTING', Source: 'mSite' },

        newCarsBase: 'https://www.cars24.com/new-cars/',
        // Authoritative brand/model index: 39 brands, 350 models, one cached request.
        variantSitemap: 'https://www.cars24.com/new-cars/new-cars-variants.xml',

        ttl: {
            charges: 24 * 60 * 60 * 1000,      // prices move slowly
            chargesFail: 30 * 60 * 1000,       // don't re-hammer dead appointmentIds
            newCarModel: 7 * 24 * 60 * 60 * 1000,
            sitemap: 7 * 24 * 60 * 60 * 1000,
        },

        maxConcurrent: 4,
        requestGapMs: 120,

        // Typical yearly running, used to judge whether a car is low- or high-use for its age.
        avgKmPerYear: 12000,

        // Age-aware plausibility ceiling for the computed discount:
        //   ceiling(age) = min(maxPct, firstYearPct + laterYearPct * (age - 1))
        //   1yr 30%   2yr 33%   3yr 36%   4yr 39%   5yr+ 40%
        //
        // This is the guard that keeps the number believable. We compare a used car against what
        // its model costs new TODAY, and model lines get repriced upward year after year - so a
        // plain subtraction can claim 53% off a 4-year-old Honda City, or 73% off a 2015 one. Most
        // of that gap is price inflation, not depreciation. Anything over the ceiling is treated as
        // a bad comparison and no percentage is shown.
        //
        // Verified against live listings: admits Creta 2024 17%, Swift 2024 22%, Kylaq 2025 24%,
        // Punch 2023 27%, i20 2021 38%; rejects Slavia 2022 47%, City 2021 49%, City 2022 53%.
        minPct: 1,
        maxPct: 40,
        firstYearPct: 30,
        laterYearPct: 3,

        // Used-listing make -> catalog brand slug.
        brandAlias: {
            maruti: 'maruti-suzuki',
            'maruti suzuki': 'maruti-suzuki',
            mercedes: 'mercedes-benz',
            'mercedes benz': 'mercedes-benz',
            landrover: 'land-rover',
            'land rover': 'land-rover',
            vw: 'volkswagen',
        },

        // Used listings and the new-car catalogue spell some models differently. Each target below
        // was checked to exist in the catalogue - add to this table when a car you know is on sale
        // reports "not sold new".
        modelAlias: {
            'wagon r 1.0': 'wagon-r',
            'wagon r': 'wagon-r',
            'new wagon-r': 'wagon-r',
            'new wagon r': 'wagon-r',
            'vitara brezza': 'brezza',
            'grand i10': 'grand-i10-nios',
            'grand i10 nios': 'grand-i10-nios',
            'scorpio n': 'scorpio-n',
            'urban cruiser hyryder': 'urban-cruiser-hyryder',
            xuv700: 'xuv-7xo',          // same car, renamed XUV 7XO
            xuv400: 'xuv400-ev',
            'new i20': 'i20',           // "NEW I20" is the current i20

            // Left out on purpose. These nameplates belong to the previous car, so pointing them at
            // today's slug would price a listing against a model it is not:
            //   "XUV300"    (Mahindra renamed it XUV 3XO in 2024)
            //   "Elite i20" (the 2014-2020 i20)
            //   "Octavia"   (the catalogue only carries the facelift)
            // They fall through and report "not sold new", which is the truthful answer.
        },

        // Placeholder catalogue pages offer these instead of real trims.
        phantomVariantNames: ['base variant', 'top variant'],

        debug: false,
    };

    const LOG = (...a) => { if (CONFIG.debug) console.log('[c24ce]', ...a); };

    /* ---------------------------------------------------------------------- *
     * store - localStorage with TTL
     * ---------------------------------------------------------------------- */

    const store = {
        // Bump SCHEMA whenever a cached record changes shape. Entries written by an older version
        // are then ignored and swept, instead of resurfacing as undefined/NaN on a card.
        SCHEMA: 'v2',
        PREFIX: 'c24ce:',
        key(k) { return this.PREFIX + this.SCHEMA + ':' + k; },

        // Drop anything this build cannot read. Cheap: runs once, over our own keys only.
        sweep() {
            const mine = this.PREFIX + this.SCHEMA + ':';
            try {
                Object.keys(localStorage)
                    .filter((k) => k.indexOf(this.PREFIX) === 0 && k.indexOf(mine) !== 0)
                    .forEach((k) => localStorage.removeItem(k));
            } catch (_) { /* private mode / storage disabled */ }
        },

        evictAll() {
            try {
                Object.keys(localStorage)
                    .filter((k) => k.indexOf(this.PREFIX) === 0)
                    .forEach((k) => localStorage.removeItem(k));
            } catch (_) {}
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
                // Corrupt entry - drop it rather than throwing on every card.
                try { localStorage.removeItem(this.key(k)); } catch (_) {}
                return null;
            }
        },

        set(k, v, ttl) {
            try {
                localStorage.setItem(this.key(k), JSON.stringify({ v, ts: Date.now(), ttl }));
            } catch (e) {
                // Out of quota: clear our own keys and try once more.
                this.evictAll();
                try {
                    localStorage.setItem(this.key(k), JSON.stringify({ v, ts: Date.now(), ttl }));
                } catch (_) { /* the cache is an optimisation, not a requirement */ }
            }
        },
    };

    /* ---------------------------------------------------------------------- *
     * format - Indian grouping and lakh shorthand, matching site convention
     * ---------------------------------------------------------------------- */

    const fmt = {
        // 744713 -> "7,44,713"
        grouped(n) {
            const s = String(Math.round(n));
            if (s.length <= 3) return s;
            const head = s.slice(0, -3);
            const tail = s.slice(-3);
            return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
        },

        // 744713 -> "7.44L"  (site shows "6.94 lakh" / "8.56L"; we use the compact form)
        lakh(n) {
            const l = n / 100000;
            if (l >= 100) return '₹' + (l / 100).toFixed(2) + 'Cr';
            return '₹' + l.toFixed(2) + 'L';
        },

        rupees(n) {
            return '₹' + this.grouped(n);
        },
    };

    /* ---------------------------------------------------------------------- *
     * http - fetch with GM_xmlhttpRequest fallback, plus a concurrency gate
     * ---------------------------------------------------------------------- */

    const gate = {
        active: 0,
        queue: [],

        run(fn) {
            return new Promise((resolve) => {
                this.queue.push({ fn, resolve });
                this.pump();
            });
        },

        pump() {
            while (this.active < CONFIG.maxConcurrent && this.queue.length) {
                const job = this.queue.shift();
                this.active++;
                job.fn()
                    .then(job.resolve, () => job.resolve(null))
                    .then(() => {
                        this.active--;
                        // Small gap so we never look like a scraper burst.
                        setTimeout(() => this.pump(), CONFIG.requestGapMs);
                    });
            }
        },
    };

    // A 404 is meaningful - it tells us the model is off the market - whereas a dropped connection
    // tells us nothing. Tag the error so callers can tell the two apart instead of guessing.
    function notFound(err) {
        return !!err && err.status === 404;
    }

    function httpError(status) {
        const e = new Error('HTTP ' + status);
        e.status = status;
        return e;
    }

    // CORS on the charges endpoint is access-control-allow-origin: https://www.cars24.com, so a
    // plain fetch works from the page. GM_xmlhttpRequest is the fallback if that ever changes.
    function httpGet(url, headers, asText) {
        return fetch(url, { headers: headers || {}, credentials: 'omit' })
            .then((r) => {
                if (!r.ok) throw httpError(r.status);
                return asText ? r.text() : r.json();
            })
            .catch((err) => {
                // Don't retry a definitive answer through the other transport.
                if (notFound(err)) throw err;
                return gmGet(url, headers, asText);
            });
    }

    function gmGet(url, headers, asText) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no GM'));
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: headers || {},
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) return reject(httpError(r.status));
                    try { resolve(asText ? r.responseText : JSON.parse(r.responseText)); }
                    catch (e) { reject(e); }
                },
                onerror: reject,
                ontimeout: reject,
            });
        });
    }

    /* ---------------------------------------------------------------------- *
     * flight - read the Next.js RSC payload the page already contains
     *
     * Preferred over scraping card text: gives exact integers instead of the
     * rounded "Rs 6.94 lakh" shown in the DOM.
     * ---------------------------------------------------------------------- */

    const flight = {
        cars: new Map(),
        lastLen: 0,

        raw() {
            const f = window.self && window.self.__next_f;
            if (!Array.isArray(f)) return '';
            let out = '';
            for (const entry of f) {
                if (Array.isArray(entry) && typeof entry[1] === 'string') out += entry[1];
            }
            return out;
        },

        // Client-side navigation appends chunks, so re-parse when the payload grows.
        refresh() {
            const s = this.raw();
            if (!s || s.length === this.lastLen) return this.cars;
            this.lastLen = s.length;

            const needle = '{"appointmentId"';
            let i = s.indexOf(needle);
            while (i !== -1) {
                const obj = this.balanced(s, i);
                if (obj) {
                    try {
                        const car = JSON.parse(obj);
                        if (car && car.appointmentId) this.cars.set(String(car.appointmentId), car);
                    } catch (_) { /* partial chunk, skip */ }
                }
                i = s.indexOf(needle, i + needle.length);
            }
            LOG('flight cars indexed:', this.cars.size);
            return this.cars;
        },

        // Brace-balanced slice, string-aware so braces inside values don't break it.
        balanced(s, start) {
            let depth = 0, inStr = false, esc = false;
            for (let k = start; k < s.length; k++) {
                const c = s[k];
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === '\\') esc = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') inStr = true;
                else if (c === '{') depth++;
                else if (c === '}') {
                    depth--;
                    if (depth === 0) return s.slice(start, k + 1);
                }
            }
            return null;
        },

        get(appId) {
            if (!this.cars.has(appId)) this.refresh();
            return this.cars.get(appId) || null;
        },
    };

    /* ---------------------------------------------------------------------- *
     * scrape - DOM fallback for cards the flight payload doesn't cover
     *
     * Only the ~20 server-rendered cards appear in __next_f; everything loaded
     * by scrolling arrives via POST listing/v2/ and never lands in the page
     * payload. Every card does, however, carry a structured image alt:
     *   "2021 Skoda KUSHAQ - SUV - Petrol - Manual - ₹6.94 lakh"
     * which gives year / make / model / fuel / transmission for all 340.
     * ---------------------------------------------------------------------- */

    const scrape = {
        // Multi-word makes must be matched before their first word is taken as the make.
        MULTI_MAKES: ['land rover', 'aston martin', 'rolls royce', 'maruti suzuki', 'mercedes benz'],

        fromCard(card) {
            const img = card.querySelector('img[alt]');
            const alt = img ? img.getAttribute('alt') || '' : '';
            const m = alt.match(/^(\d{4})\s+(.+?)\s+-\s+([^-]+?)\s+-\s+([^-]+?)\s+-\s+([^-]+?)\s+-\s+/);
            if (!m) return null;

            const year = parseInt(m[1], 10);
            const nameBlob = m[2].trim();
            const fuel = m[4].trim();
            const trans = m[5].trim();

            let make = '', model = '';
            const lower = nameBlob.toLowerCase();
            const multi = this.MULTI_MAKES.find((x) => lower.startsWith(x));
            if (multi) {
                make = nameBlob.slice(0, multi.length);
                model = nameBlob.slice(multi.length).trim();
            } else {
                const sp = nameBlob.indexOf(' ');
                if (sp === -1) return null;
                make = nameBlob.slice(0, sp);
                model = nameBlob.slice(sp + 1).trim();
            }
            if (!make || !model) return null;

            return {
                year,
                make,
                model,
                fuelType: fuel,
                transmissionType: { value: trans },
                odometer: this.odometerOf(card),
                // The alt price is rounded to 2dp; the charges API supplies the exact base, so we
                // deliberately do NOT use it as a price source.
                variant: this.variantOf(card),
            };
        },

        // The spec chips read "25,527 km", "Petrol", "Manual", "MH-13".
        odometerOf(card) {
            const chips = card.querySelectorAll('p, span');
            for (const el of chips) {
                const m = (el.textContent || '').trim().match(/^([\d,]+)\s*km$/i);
                if (m) {
                    const value = parseInt(m[1].replace(/,/g, ''), 10);
                    if (isFinite(value) && value > 0) return { value: value };
                }
            }
            return null;
        },

        // The trim sits in a second span next to the car title, e.g. "AMBITION 1.0L TSI MT".
        variantOf(card) {
            const title = card.querySelector('.styles_outer__NTVth') || card;
            const spans = title.querySelectorAll('span');
            for (let i = 0; i < spans.length; i++) {
                const t = (spans[i].textContent || '').trim();
                if (!t) continue;
                // Skip the "2021 Skoda KUSHAQ" title itself; the trim follows it.
                if (/^\d{4}\s/.test(t)) {
                    const next = spans[i + 1];
                    if (next) return (next.textContent || '').trim();
                }
            }
            return '';
        },
    };

    /* ---------------------------------------------------------------------- *
     * chargesApi - the real drive-away price
     * ---------------------------------------------------------------------- */

    const chargesApi = {
        inflight: new Map(),

        get(appId, carSegment) {
            const ck = 'ch:' + appId;
            const cached = store.get(ck);
            if (cached) return Promise.resolve(cached.fail ? null : cached);
            if (this.inflight.has(appId)) return this.inflight.get(appId);

            const headers = Object.assign({}, CONFIG.chargesHeaders);
            if (carSegment) headers.X_CAR_SEGMENT = carSegment;

            const p = gate
                .run(() => httpGet(CONFIG.chargesApi + encodeURIComponent(appId), headers, false))
                .then((data) => {
                    if (!data || !data.finalPrice || typeof data.finalPrice.amount !== 'number') {
                        store.set(ck, { fail: true }, CONFIG.ttl.chargesFail);
                        return null;
                    }
                    const out = {
                        base: this.baseOf(data),
                        extras: data.totalExtraCharges || 0,
                        total: data.finalPrice.amount,
                        lines: (data.charges || [])
                            .filter((c) => c && c.id !== 'BasePrice')
                            .map((c) => ({ title: c.title, amount: c.amount, note: c.amountDescription })),
                    };
                    store.set(ck, out, CONFIG.ttl.charges);
                    return out;
                })
                .catch(() => {
                    store.set(ck, { fail: true }, CONFIG.ttl.chargesFail);
                    return null;
                })
                .then((v) => { this.inflight.delete(appId); return v; });

            this.inflight.set(appId, p);
            return p;
        },

        baseOf(data) {
            const b = (data.charges || []).find((c) => c && c.id === 'BasePrice');
            return b ? b.amount : null;
        },
    };

    /* ---------------------------------------------------------------------- *
     * newCarCatalog - what the same model costs new today
     * ---------------------------------------------------------------------- */

    const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Variant names occasionally carry escapes ("1.5 Turbo – DCT").
    function unescapeJson(s) {
        try { return JSON.parse('"' + s + '"'); }
        catch (_) { return s; }
    }

    // "navi-mumbai" -> "Navi Mumbai"
    function titleCase(slug) {
        return String(slug || '')
            .split('-')
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
    }

    // Tails that look like a city in the URL but are not one.
    const NON_CITY_SLUGS = new Set(['cars', 'used-cars', 'sunroof', 'first-owner', 'automatic', 'petrol', 'diesel', 'cng', 'electric']);

    const newCarCatalog = {
        index: null,          // Set of "brand/model"
        models: new Map(),    // "brand/model[@city]" -> {variants:[...]} | {absent:true}
        inflight: new Map(),

        /* -- authoritative brand/model index from the sitemap (one cached request) -- */
        loadIndex() {
            if (this.index) return Promise.resolve(this.index);
            const cached = store.get('sitemap');
            if (cached) {
                this.index = new Set(cached);
                return Promise.resolve(this.index);
            }
            if (this.inflight.has('__index')) return this.inflight.get('__index');

            const p = gate
                .run(() => httpGet(CONFIG.variantSitemap, {}, true))
                .then((xml) => {
                    const set = new Set();
                    if (typeof xml === 'string') {
                        const re = /<loc>\s*https:\/\/www\.cars24\.com\/new-cars\/([^/]+)\/([^/]+)\/([^/<]+)\/?\s*<\/loc>/g;
                        let m;
                        while ((m = re.exec(xml))) set.add(m[1] + '/' + m[2]);
                    }
                    if (set.size) {
                        store.set('sitemap', Array.from(set), CONFIG.ttl.sitemap);
                        this.index = set;
                    } else {
                        this.index = new Set();
                    }
                    LOG('catalog index models:', this.index.size);
                    return this.index;
                })
                .catch(() => { this.index = new Set(); return this.index; })
                .then((v) => { this.inflight.delete('__index'); return v; });

            this.inflight.set('__index', p);
            return p;
        },

        /* -- map a used listing to a catalog "brand/model" slug -- */
        resolveSlug(car) {
            const mk = String(car.make || '').toLowerCase().trim();
            const mo = String(car.model || '').toLowerCase().trim();
            const brand = CONFIG.brandAlias[mk] || slugify(mk);
            const model = CONFIG.modelAlias[mo] || slugify(mo);
            return brand + '/' + model;
        },

        /* -- fetch + parse one model page (optionally city-specific) -- */
        loadModel(slug, citySlug) {
            const key = slug + (citySlug ? '@' + citySlug : '');
            if (this.models.has(key)) return Promise.resolve(this.models.get(key));

            const cached = store.get('nc:' + key);
            if (cached) { this.models.set(key, cached); return Promise.resolve(cached); }
            if (this.inflight.has(key)) return this.inflight.get(key);

            const url = CONFIG.newCarsBase + slug + '/' + (citySlug ? 'price-in-' + citySlug + '/' : '');

            const p = gate
                .run(() => httpGet(url, {}, true))
                .then((html) => {
                    const parsed = typeof html === 'string' ? this.parseVariants(html) : null;
                    const rec = parsed && parsed.length ? { variants: parsed } : { absent: true };
                    store.set('nc:' + key, rec, CONFIG.ttl.newCarModel);
                    this.models.set(key, rec);
                    return rec;
                })
                .catch((err) => {
                    // A 404 genuinely means the model has left the catalogue, and that is worth
                    // remembering for a week. Anything else (offline, timeout, rate limit) says
                    // nothing about the car, so report it as unknown and do not cache it - the
                    // alternative is telling someone a Baleno is discontinued because their wifi
                    // dropped.
                    if (notFound(err)) {
                        const rec = { absent: true };
                        store.set('nc:' + key, rec, CONFIG.ttl.newCarModel);
                        this.models.set(key, rec);
                        return rec;
                    }
                    return { unknown: true };
                })
                .then((v) => { this.inflight.delete(key); return v; });

            this.inflight.set(key, p);
            return p;
        },

        // Pull variant objects out of the model page's RSC payload.
        //
        // The payload lives inside self.__next_f.push([1,"...."]) string literals, so in the raw
        // HTML every quote is backslash-escaped: \"exShowroomPrice\":1069000. Searching the raw
        // markup for unescaped JSON finds nothing, so decode the flight strings first.
        // Two payload shapes exist in the wild and both must work:
        //   compact  - nested arrays are "$ad" back-references, so a variant object is ~300 bytes
        //   expanded - tags/delta arrays are inlined, pushing a variant past 13KB (Hyundai i20)
        // So we do not JSON.parse the whole object. We read the fields we need out of a window of
        // text around each exShowroomPrice hit, which is shape-independent and cheap.
        parseVariants(html) {
            const decoded = this.decodeFlight(html);
            const out = [];
            const re = /"exShowroomPrice":\s*(\d+)/g;
            let m;
            while ((m = re.exec(decoded))) {
                const start = decoded.lastIndexOf('{', m.index);
                if (start === -1) continue;

                // "name" and "slug" sit immediately before the price; everything else can be far
                // past a large inlined array, so scan generously forward.
                const head = decoded.slice(start, m.index);
                const tail = decoded.slice(m.index, m.index + 60000);

                const name = (head.match(/"name":"((?:\\.|[^"\\])*)"/) || [])[1];
                if (!name) continue;

                const ex = parseInt(m[1], 10);
                if (!isFinite(ex) || ex <= 0) continue;

                // Stop at the next variant so we never borrow a neighbour's on-road price.
                const nextIdx = tail.slice(1).search(/"exShowroomPrice":\s*\d/);
                const scope = nextIdx > 0 ? tail.slice(0, nextIdx + 1) : tail;

                const onRoad = parseFloat((scope.match(/"onRoadPrice":\s*([\d.]+)/) || [])[1]);
                out.push({
                    name: unescapeJson(name),
                    ex,
                    onRoad: isFinite(onRoad) && onRoad > 0 ? onRoad : null,
                    fuel: (scope.match(/"fuelType":"([^"]{1,20})"/) || [])[1] || '',
                    trans: (scope.match(/"transmissionType":"([^"]{1,20})"/) || [])[1] || '',
                });
            }
            // De-dupe: the payload repeats variants across sections. Keep the entry that carries an
            // on-road price, since the same variant appears both with and without one.
            const byKey = new Map();
            for (const v of out) {
                const k = v.name + '|' + v.ex;
                const prev = byKey.get(k);
                if (!prev || (!prev.onRoad && v.onRoad)) byKey.set(k, v);
            }
            return Array.from(byKey.values());
        },

        // Concatenate and unescape the RSC flight string chunks embedded in the page.
        decodeFlight(html) {
            let out = '';
            // self.__next_f.push([1,"<escaped chunk>"])
            const re = /self\.__next_f\.push\(\[\s*\d+\s*,\s*"((?:\\.|[^"\\])*)"/g;
            let m;
            while ((m = re.exec(html))) {
                try { out += JSON.parse('"' + m[1] + '"'); }
                catch (_) { /* skip an unparseable chunk rather than losing the rest */ }
            }
            // Fixtures / non-Next pages: fall back to the raw text so tests still work.
            return out || html;
        },

        /* -- Work out what to say about this car versus buying new.
         *
         * Returns one of:
         *   { pct, newPrice, variantName, ... }  a discount we are willing to stand behind
         *   { discontinued: true }               nobody sells this model new any more
         *   { reason, range? }                   we know the model but cannot price it honestly
         */
        async priceFor(car, usedAllIn) {
            const slug = this.resolveSlug(car);

            // Not in the catalogue at all -> the model is off the market.
            const index = await this.loadIndex();
            if (index.size && !index.has(slug)) return { discontinued: true };

            // Prefer the listing's city so we compare on-road against on-road for the same RTO.
            // City pages come and go, so fall back to the plain model page before giving up.
            const citySlug = this.citySlugFor(car);
            let rec = await this.loadModel(slug, citySlug);
            let cityMatched = !!citySlug;
            if (!rec.variants && citySlug) {
                rec = await this.loadModel(slug, null);
                cityMatched = false;
            }
            if (rec.unknown) return { reason: 'lookup-failed' };
            if (rec.absent || !rec.variants || !rec.variants.length) return { discontinued: true };

            // Some catalogue pages are placeholders: /new-cars/volkswagen/polo/ answers 200 for a
            // car VW pulled from India in 2022, offering a made-up "Base Variant" at Rs 8,00,002
            // with isDiscontinued:false. The flags lie, the variant names do not - so filter on
            // the names and treat a page with nothing left as a model that is no longer sold.
            const real = rec.variants.filter(
                (v) => !CONFIG.phantomVariantNames.includes(v.name.toLowerCase().trim())
            );
            if (!real.length) return { discontinued: true };

            // Match the trim, keeping fuel and gearbox honest.
            const match = this.matchVariant(car, real);
            if (!match) return { reason: 'variant-unmatched', range: this.rangeOf(real) };

            const newPrice = typeof match.onRoad === 'number' && isFinite(match.onRoad) && match.onRoad > 0
                ? match.onRoad
                : null;
            if (!newPrice || !match.name) return { reason: 'no-onroad-price', range: this.rangeOf(real) };

            const pct = Math.round((1 - usedAllIn / newPrice) * 100);
            if (pct < CONFIG.minPct) return { reason: 'no-saving' };

            // Anything above the age ceiling says more about years of price rises than about this
            // particular car, so we keep quiet rather than quote it.
            const age = Math.max(1, new Date().getFullYear() - car.year);
            const ceiling = Math.min(
                CONFIG.maxPct,
                CONFIG.firstYearPct + CONFIG.laterYearPct * (age - 1)
            );
            // Report the rejected figure under a different name, so no caller can mistake a
            // refusal for a result by reading .pct.
            if (pct > ceiling) return { reason: 'too-good-to-be-true', rejectedPct: pct, ceiling };

            return { pct, newPrice, variantName: match.name, cityMatched, citySlug };
        },

        rangeOf(variants) {
            const on = variants.map((v) => v.onRoad).filter((x) => typeof x === 'number' && x > 0);
            if (!on.length) return null;
            return { min: Math.min.apply(null, on), max: Math.max.apply(null, on) };
        },

        citySlugFor(car) {
            // The URL city is authoritative for a listing page. Both shapes occur:
            //   /buy-used-cars-pune/                 (main listing)
            //   /buy-used-maruti-baleno-cars-pune/   (brand/model page)
            const m = location.pathname.match(/\/buy-used-(?:.*-)?cars-([a-z]+(?:-[a-z]+)*)\/?$/);
            let city = m ? m[1] : '';

            // Fall back to the card's own hub locality ("Amanora Mall apex building, Pune").
            if (!city) {
                const loc = car.address && car.address.locality;
                if (loc) city = String(loc).split(',').pop();
            }

            const s = slugify(city);
            if (!s || s.length < 3) return null;
            // Guard against swallowing a non-city tail such as "buy-used-first-owner-cars".
            if (NON_CITY_SLUGS.has(s)) return null;
            return s;
        },

        /* -- variant name matching -- */
        matchVariant(car, variants) {
            const wantFuel = norm(car.fuelType);
            const wantTrans = norm(car.transmissionType && car.transmissionType.value);

            // Drop engine/fuel noise from the used variant string:
            // "ZETA PETROL 1.2" -> "zeta", "SPORTZ 1.2 HY-CNG DUO" -> "sportz cng"
            const usedTokens = tokenize(car.variant);
            if (!usedTokens.length) return null;

            const eligible = variants.filter((v) => {
                if (wantFuel && norm(v.fuel) && norm(v.fuel) !== wantFuel) return false;
                if (wantTrans && norm(v.trans) && norm(v.trans) !== wantTrans) return false;
                return true;
            });
            const pool = eligible.length ? eligible : [];
            if (!pool.length) return null;

            let best = null, bestScore = 0;
            for (const v of pool) {
                const vt = tokenize(v.name);
                if (!vt.length) continue;
                const overlap = vt.filter((t) => usedTokens.includes(t));
                if (!overlap.length) continue;
                // Require the trim keyword to line up, not just any incidental token.
                const score = overlap.length / Math.max(vt.length, 1);
                if (score > bestScore) { bestScore = score; best = v; }
            }
            // Demand a decisive match; a weak partial is how "Renault RXT vs Techno" goes wrong.
            return bestScore >= 0.5 ? best : null;
        },
    };

    const FUEL_WORDS = { petrol: 'petrol', diesel: 'diesel', cng: 'cng', electric: 'electric', ev: 'electric', hybrid: 'hybrid' };
    const DROP_TOKENS = new Set(['mt', 'at', 'amt', 'cvt', 'dct', 'tsi', 'tdi', 'vtec', 'ivtec', 'kappa', 'vtvt', 'dual', 'tone', 'o', 'opt', 'option', 'bsvi', 'bsiv', 'duo', 'hy', 'plus', 'l']);

    function norm(s) {
        s = String(s || '').toLowerCase().trim();
        if (!s) return '';
        if (/manual/.test(s)) return 'manual';
        if (/automatic|amt|cvt|dct|at\b/.test(s)) return 'automatic';
        for (const k in FUEL_WORDS) if (s.indexOf(k) !== -1) return FUEL_WORDS[k];
        return s;
    }

    // "ZETA PETROL 1.2" -> ["zeta"]; keeps fuel words only when they disambiguate a trim.
    function tokenize(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .filter((t) => !/^\d/.test(t))          // drop 1.2, 1.5, 998 ...
            .filter((t) => !DROP_TOKENS.has(t))
            .filter((t) => !(t in FUEL_WORDS));
    }

    /* ---------------------------------------------------------------------- *
     * render
     * ---------------------------------------------------------------------- */

    const SEL = {
        card: 'a.styles_carCardWrapper__sXLIp',
        pricing: '.styles_pricingDetail__Q_3hz',
        label: '.styles_labelContainer__NIr_r',
    };

    const MARK = 'data-c24ce';

    // The label slot is a fixed height:19px inside a 312px overflow:hidden card, so we replace its
    // contents rather than adding a line - adding one would clip the card's own content.
    function labelNodeOf(card) {
        let n = card.querySelector(SEL.label);
        if (n) return n;

        // Fallback if the CSS-module hash changes on a deploy: find by the label's own text.
        const pricing = card.querySelector(SEL.pricing);
        const scope = pricing || card;
        const cands = scope.querySelectorAll('div, span, p');
        for (const c of cands) {
            const t = (c.textContent || '').trim().toLowerCase();
            if (t === '+ other charges' || t === '+ extra charges') {
                return c.closest('div') || c;
            }
        }
        return null;
    }

    function render(card, node, text, tooltip) {
        if (!node) return;

        if (!node.hasAttribute('data-c24ce-orig')) {
            node.setAttribute('data-c24ce-orig', node.innerHTML);
        }

        paint(node, text.main, text.suffix, tooltip);
        card.setAttribute(MARK, '1');

        // The slot is 19px tall and shares its row with the EMI figure, so there is no room to
        // wrap. If we have overrun the column, shed detail in order of least value: first the
        // word "all-in", then the suffix. The percentage is the whole point, so it goes last.
        if (!overflowing(node)) return;
        paint(node, fmt.lakh(text.total || 0), text.suffix, tooltip);
        if (!overflowing(node)) return;
        paint(node, text.main, '', tooltip);
    }

    function paint(node, main, suffix, tooltip) {
        // Reuse the site's own type tokens so this reads as part of the card, not an addition.
        node.innerHTML =
            '<span style="display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap;' +
            'font-size:var(--font-size-150);line-height:var(--line-height-150);' +
            'font-weight:var(--medium);color:var(--grey-900)">' +
            '<span>' + main + '</span>' +
            (suffix
                ? '<span style="font-weight:var(--regular);color:var(--grey-500)">&middot;&nbsp;' + suffix + '</span>'
                : '') +
            '</span>';
        node.setAttribute('title', tooltip || '');
    }

    function overflowing(node) {
        const inner = node.firstElementChild;
        if (!inner || !node.clientWidth) return false;
        return inner.scrollWidth > node.clientWidth;
    }

    function ageSuffix(year) {
        if (!year) return '';
        const age = new Date().getFullYear() - year;
        if (age <= 0) return '';
        return age + (age === 1 ? ' yr old' : ' yrs old');
    }

    /* ---------------------------------------------------------------------- *
     * km/year pill
     *
     * Odometer alone is hard to judge - 70,000 km is a lot on a 2021 car and
     * unremarkable on a 2013 one. Yearly running makes the comparison fair.
     * The pill sits under the wishlist heart, in the same absolutely-positioned
     * corner of the photo, where there is always empty sky or bodywork.
     * ---------------------------------------------------------------------- */

    const KM_PILL = 'data-c24ce-km';

    function kmPerYear(car) {
        const km = car.odometer && typeof car.odometer.value === 'number' ? car.odometer.value : null;
        if (!km || !car.year) return null;
        // Count the current year as one, so a brand-new car never divides by zero.
        const years = Math.max(1, new Date().getFullYear() - car.year);
        return Math.round(km / years);
    }

    function addKmPill(card, car) {
        if (card.querySelector('[' + KM_PILL + ']')) return;

        const perYear = kmPerYear(car);
        if (!perYear) return;

        // The heart lives in an absolutely positioned box at top:8px right:8px; its offset parent
        // is the thumbnail. Hang the pill off that same parent so it tracks the heart.
        const heartBox = card.querySelector('.styles_outer__ZH1Cg');
        const host = heartBox && heartBox.parentElement && heartBox.parentElement.parentElement;
        if (!host) return;
        if (!host.style.position) host.style.position = 'relative';

        const ratio = perYear / CONFIG.avgKmPerYear;
        const tone = ratio <= 0.75
            ? { fg: '#1B6B4A', bg: 'rgba(232,248,240,0.94)' }   // easy life
            : ratio >= 1.4
                ? { fg: '#A33A2B', bg: 'rgba(253,236,233,0.94)' } // worked hard
                : { fg: '#3F4145', bg: 'rgba(255,255,255,0.94)' };

        const pill = document.createElement('div');
        pill.setAttribute(KM_PILL, '1');
        pill.style.cssText = [
            'position:absolute',
            'top:40px',            // clears the 24px heart at top:8px
            'right:8px',
            'z-index:9',
            'padding:2px 6px',
            'border-radius:6px',
            'background:' + tone.bg,
            'color:' + tone.fg,
            'font-size:11px',
            'line-height:13px',
            'font-weight:var(--semibold, 600)',
            'text-align:right',
            'white-space:nowrap',
            'pointer-events:none',
            'box-shadow:0 1px 3px rgba(0,0,0,0.12)',
        ].join(';');
        pill.innerHTML =
            '<span>' + fmt.grouped(perYear) + '</span>' +
            '<span style="font-weight:var(--regular, 400);opacity:0.75"> km/yr</span>';

        host.appendChild(pill);
    }

    /* ---------------------------------------------------------------------- *
     * processCard
     * ---------------------------------------------------------------------- */

    function appIdOf(card) {
        const href = card.getAttribute('href') || '';
        const m = href.match(/-(\d{9,})\/?(?:[?#].*)?$/);
        return m ? m[1] : null;
    }

    const done = new WeakSet();

    async function processCard(card) {
        if (done.has(card) || card.hasAttribute(MARK)) return;
        const appId = appIdOf(card);
        if (!appId) return;
        done.add(card);

        // Flight payload is exact but only covers server-rendered cards; scrape the rest.
        const car = flight.get(appId) || scrape.fromCard(card) || {};

        // Cards where the site itself hides charges, or where price is negotiable (C2C), have no
        // meaningful fixed all-in figure.
        const info = car.additionalInfo || {};
        if (info.showOtherCharges === false || car.businessVertical === 'C2C') return;

        // Yearly running needs nothing from the network, so show it straight away.
        addKmPill(card, car);

        const node = labelNodeOf(card);
        if (!node) return;

        const charges = await chargesApi.get(appId, car.carSegment);
        if (!charges) return;   // leave the original label untouched

        const total = charges.total;
        const main = fmt.lakh(total) + ' all-in';

        const chargeList = charges.lines.length
            ? charges.lines
                  .map((l) => l.title + ' ' + (l.note && /included/i.test(l.note) ? '(included)' : fmt.rupees(l.amount || 0)))
                  .join(', ')
            : '';
        let tooltip = 'Total ' + fmt.rupees(total) + (chargeList ? ' — incl. ' + chargeList : '');

        // Show the price straight away; the new-car comparison refines the tail if it earns it.
        let suffix = ageSuffix(car.year);
        render(card, node, { main, suffix, total }, tooltip);

        if (!car.make || !car.model) return;

        try {
            const res = await newCarCatalog.priceFor(car, total);

            // Only a result carrying a real price is a match. Rejections may also carry a pct for
            // debugging, so checking that field alone would print the number we just refused.
            if (res && res.newPrice && res.variantName && typeof res.pct === 'number') {
                suffix = (res.cityMatched ? '' : '~') + res.pct + '% off';
                tooltip +=
                    '\n' + res.pct + '% cheaper than a new ' + res.variantName + ' at ' +
                    fmt.rupees(res.newPrice) + ' on-road' +
                    (res.cityMatched && res.citySlug ? ' in ' + titleCase(res.citySlug) : ' (Delhi-NCR)') + '.';

            } else if (res && res.discontinued) {
                // Nothing to compare against - say so plainly instead of leaving a gap.
                suffix = 'not sold new';
                tooltip += '\nThe ' + car.make + ' ' + car.model + ' is not sold new any more, ' +
                           'so there is no new price to compare against.';

            } else if (res && res.range) {
                suffix = ageSuffix(car.year);
                tooltip +=
                    '\nA new ' + car.make + ' ' + car.model + ' runs ' +
                    fmt.lakh(res.range.min) + ' to ' + fmt.lakh(res.range.max) + ' on-road, but the ' +
                    'trim names have changed too much to compare this one directly.';

            } else if (res && res.reason) {
                LOG(appId, car.make, car.model, car.year, '->', res.reason,
                    res.rejectedPct ? res.rejectedPct + '% > ' + res.ceiling + '% ceiling' : '');
            }

            render(card, node, { main, suffix, total }, tooltip);
        } catch (e) {
            LOG('new-car lookup failed', e);
        }
    }

    /* ---------------------------------------------------------------------- *
     * observe
     * ---------------------------------------------------------------------- */

    let io = null;

    function ensureObserver() {
        if (io) return io;
        io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        io.unobserve(e.target);
                        processCard(e.target);
                    }
                }
            },
            { rootMargin: '200px 0px' }
        );
        return io;
    }

    function scan() {
        flight.refresh();
        const cards = document.querySelectorAll(SEL.card + ':not([' + MARK + '])');
        if (!cards.length) return;
        const obs = ensureObserver();
        cards.forEach((c) => { if (!done.has(c)) obs.observe(c); });
        LOG('observing', cards.length, 'cards');
    }

    let t = null;
    function scanSoon() {
        clearTimeout(t);
        t = setTimeout(scan, 150);
    }

    function start() {
        store.sweep();
        scan();

        new MutationObserver(scanSoon).observe(document.body, { childList: true, subtree: true });

        // Next.js client-side navigation doesn't reload the page.
        window.addEventListener('popstate', scanSoon);
        for (const m of ['pushState', 'replaceState']) {
            const orig = history[m];
            history[m] = function () {
                const r = orig.apply(this, arguments);
                scanSoon();
                return r;
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // Exposed for the offline test harness; harmless in the browser.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { fmt, tokenize, norm, newCarCatalog, CONFIG, flight, appIdOf: appIdOf };
    }
})();
