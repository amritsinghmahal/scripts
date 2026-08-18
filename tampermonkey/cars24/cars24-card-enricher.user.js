// ==UserScript==
// @name         Cars24 Card Enricher
// @namespace    https://github.com/amrmahal/scripts
// @version      1.0.0
// @description  Shows the real all-in price (incl. RC transfer, insurance, warranty, servicing) and an honest "% off new" on every Cars24 listing card.
// @author       amrmahal
// @match        https://www.cars24.com/*
// @connect      car-catalog-gateway-in.c24.tech
// @connect      www.cars24.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * HOW THIS WORKS
 * --------------
 * [2] All-in price. The site's dashed "+ other charges" teaser hides ~5-19% of the real cost.
 *     The popup behind it calls /detail/v1/charges/{appointmentId}, which needs no auth. We call
 *     it directly and render finalPrice.amount in place of the teaser. Verified on 18 cars:
 *     BasePrice === card listingPrice and BasePrice + totalExtraCharges === finalPrice.amount, 18/18.
 *
 * [1] "% off new". Only shown when it is defensible. Cars24's own new-car catalog gives real,
 *     itemised, city-specific onRoadPrice figures - but it is booby-trapped:
 *
 *       - /new-cars/volkswagen/polo/ returns HTTP 200 for a car VW stopped selling in India in
 *         2022, with fabricated "Base Variant" Rs 8,00,002 / "Top Variant" Rs 14,00,000 and
 *         isDiscontinued:false, isActive:true. So those flags CANNOT be trusted as a guard.
 *       - ~67% of listings are older generations. A 2015 Honda City computes as "72.7% off",
 *         but most of that is a decade of model-line price inflation, not depreciation.
 *
 *     So the comparison runs a validity ladder and FAILS CLOSED: any unmet rung means no
 *     percentage at all, and the card falls back to showing the car's age instead of a number
 *     that cannot be justified. Measured honest coverage is ~8-13% of cards.
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

        // Reject a computed discount outside this band. A very high number reliably means a bad
        // match (wrong generation, phantom page) rather than a real bargain - the 2015 Honda City
        // case computes as 72.7%.
        minPct: 1,
        maxPct: 40,

        // Age-aware plausibility ceiling. The generation gate alone is NOT enough: a 2022 Honda
        // City passes it (5th gen started 2020) yet computes as 53% off, because Honda repriced
        // the model line upward - that "discount" is price inflation, not depreciation.
        //
        // Modelled on the real curve: a steep first-year drop, then a gentler slope, then a cap.
        //   ceiling(age) = min(maxPct, firstYearPct + laterYearPct * (age - 1))
        //   1yr 30%   2yr 33%   3yr 36%   4yr 39%   5yr+ 40%
        //
        // Chosen for MARGIN, not fitted tightly to the sample: every legitimate case observed sits
        // >=6pp below its ceiling and every inflated one >=6pp above.
        //   admits  Creta 2024 17%, Swift 2024 22%, Kylaq 2025 24%, Punch 2023 27%, Kushaq 2021 28%
        //   rejects Slavia 2022 47%, City 2021 49%, City 2022 53%, City 2015 73%
        firstYearPct: 30,
        laterYearPct: 3,

        // Current-generation start years. A listing older than its model's cutoff is a generation
        // mismatch and gets no percentage.
        //
        // NOTE: these are domain knowledge, NOT Cars24 data - the catalog exposes no generation
        // field. Any model absent from this table is treated as unknown and yields no percentage
        // (fail closed). Extend this table to widen honest coverage.
        generationStart: {
            'maruti-suzuki/swift': 2024,
            'maruti-suzuki/baleno': 2022,
            'maruti-suzuki/brezza': 2022,
            'maruti-suzuki/wagon-r': 2019,
            'maruti-suzuki/ertiga': 2018,
            'maruti-suzuki/celerio': 2021,
            'maruti-suzuki/ciaz': 2018,
            'maruti-suzuki/grand-vitara': 2022,
            'maruti-suzuki/fronx': 2023,
            'hyundai/creta': 2024,
            'hyundai/venue': 2025,
            'hyundai/grand-i10-nios': 2019,
            'hyundai/verna': 2023,
            'hyundai/exter': 2023,
            'honda/city': 2020,
            'honda/amaze': 2024,
            'honda/elevate': 2023,
            'tata/nexon': 2023,
            'tata/tiago': 2023,
            'tata/punch': 2021,
            'tata/altroz': 2023,
            'tata/harrier': 2023,
            'mahindra/thar': 2025,
            'mahindra/xuv-3xo': 2024,
            'mahindra/xuv-7xo': 2021,
            'mahindra/scorpio-n': 2022,
            'mahindra/bolero': 2020,
            'hyundai/i20': 2020,
            'kia/seltos': 2023,
            'kia/sonet': 2024,
            'kia/carens': 2022,
            'skoda/kushaq': 2024,
            'skoda/kylaq': 2024,
            'skoda/slavia': 2022,
            'renault/kwid': 2022,
            'renault/triber': 2019,
            'toyota/glanza': 2022,
            'toyota/urban-cruiser-hyryder': 2022,
            'nissan/magnite': 2024,
            'volkswagen/virtus': 2022,
            'volkswagen/taigun': 2021,
            'mg/astor': 2021,
            'mg/hector': 2023,
        },

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

        // Used-listing model -> catalog model slug. Every target here was verified to exist in the
        // sitemap; entries whose target does not exist are deliberately omitted so the lookup 404s
        // (which correctly reads as "not sold new") instead of matching the wrong car.
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
            xuv700: 'xuv-7xo',          // same car, renamed XUV 7XO in 2025
            xuv400: 'xuv400-ev',
            'new i20': 'i20',           // "NEW I20" is the 2020+ generation

            // DELIBERATELY NOT ALIASED - the used nameplate identifies an OLDER generation, so
            // mapping it to the current slug would compare two different cars:
            //   "XUV300"    -> xuv-3xo         (renamed 2024; an XUV300 listing is pre-facelift)
            //   "Elite i20" -> i20             (Elite is the 2014-2020 gen)
            //   "Octavia"   -> octavia-facelift
            // These fall through to a 404 / generation-unknown, which correctly yields no
            // percentage rather than a confident mismatch.
        },

        // Variants literally named this are placeholder fabrications, never real trims.
        phantomVariantNames: ['base variant', 'top variant'],

        debug: false,
    };

    const LOG = (...a) => { if (CONFIG.debug) console.log('[c24ce]', ...a); };

    /* ---------------------------------------------------------------------- *
     * store - localStorage with TTL
     * ---------------------------------------------------------------------- */

    const store = {
        // Bump SCHEMA whenever a cached record's shape changes, so old entries are ignored rather
        // than resurfacing as undefined/NaN in the UI.
        SCHEMA: 'v1',
        key(k) { return 'c24ce:' + this.SCHEMA + ':' + k; },

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
                // Quota exceeded: evict our own namespace and retry once.
                try {
                    Object.keys(localStorage)
                        .filter((x) => x.startsWith('c24ce:'))
                        .forEach((x) => localStorage.removeItem(x));
                    localStorage.setItem(this.key(k), JSON.stringify({ v, ts: Date.now(), ttl }));
                } catch (_) { /* give up silently; cache is an optimisation, not a requirement */ }
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

    // CORS on the charges endpoint is access-control-allow-origin: https://www.cars24.com, so a
    // plain fetch works from the page. GM_xmlhttpRequest is the fallback if that ever changes.
    function httpGet(url, headers, asText) {
        return fetch(url, { headers: headers || {}, credentials: 'omit' })
            .then((r) => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return asText ? r.text() : r.json();
            })
            .catch(() => gmGet(url, headers, asText));
    }

    function gmGet(url, headers, asText) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no GM'));
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: headers || {},
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
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
                // The alt price is rounded to 2dp; the charges API supplies the exact base, so we
                // deliberately do NOT use it as a price source.
                variant: this.variantOf(card),
            };
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
     * chargesApi - feature [2]
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
     * newCarCatalog - feature [1], with the validity ladder
     * ---------------------------------------------------------------------- */

    const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
                .catch(() => {
                    // 404 is the reliable "not sold new" signal (verified 10/10).
                    const rec = { absent: true };
                    store.set('nc:' + key, rec, CONFIG.ttl.newCarModel);
                    this.models.set(key, rec);
                    return rec;
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
        parseVariants(html) {
            const decoded = this.decodeFlight(html);
            const out = [];
            const re = /"exShowroomPrice":\s*(\d+)/g;
            let m;
            while ((m = re.exec(decoded))) {
                const start = decoded.lastIndexOf('{', m.index);
                if (start === -1) continue;
                const slice = flight.balanced(decoded, start);
                if (!slice || slice.length > 6000) continue;
                let v;
                try { v = JSON.parse(slice); } catch (_) { continue; }
                if (!v || typeof v.exShowroomPrice !== 'number' || !v.name) continue;
                out.push({
                    name: String(v.name),
                    ex: v.exShowroomPrice,
                    onRoad: typeof v.onRoadPrice === 'number' ? v.onRoadPrice : null,
                    fuel: v.fuelType || '',
                    trans: v.transmissionType || '',
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

        /* -- the validity ladder: returns {pct} or {reason} -- */
        async priceFor(car, usedAllIn) {
            const slug = this.resolveSlug(car);

            // Rung 1: model must exist in the catalog index.
            const index = await this.loadIndex();
            if (index.size && !index.has(slug)) return { reason: 'not-sold-new' };

            // Rung 2: generation. Unknown model => fail closed, no percentage.
            const genStart = CONFIG.generationStart[slug];
            if (!genStart) return { reason: 'generation-unknown' };
            if (!car.year || car.year < genStart) return { reason: 'older-generation' };

            // Rung 3: load the model, city-matched where possible.
            const citySlug = this.citySlugFor(car);
            let rec = await this.loadModel(slug, citySlug);
            let cityMatched = !!citySlug;
            if (rec.absent && citySlug) {
                rec = await this.loadModel(slug, null);
                cityMatched = false;
            }
            if (rec.absent || !rec.variants || !rec.variants.length) return { reason: 'not-sold-new' };

            // Rung 4: phantom guard. Pages like /new-cars/volkswagen/polo/ return 200 with
            // fabricated Base/Top Variant prices and isDiscontinued:false - so reject on the
            // variant NAMES, never on those flags.
            const real = rec.variants.filter(
                (v) => !CONFIG.phantomVariantNames.includes(v.name.toLowerCase().trim())
            );
            if (!real.length) return { reason: 'phantom-catalog-entry' };

            // Rung 5: variant match, constrained by fuel + transmission.
            const match = this.matchVariant(car, real);
            if (!match) return { reason: 'variant-unmatched', range: this.rangeOf(real) };

            // Defensive: never let a malformed record reach the UI as NaN/undefined.
            const newPrice = typeof match.onRoad === 'number' && isFinite(match.onRoad) && match.onRoad > 0
                ? match.onRoad
                : null;
            if (!newPrice || !match.name) return { reason: 'no-onroad-price', range: this.rangeOf(real) };

            // Rung 6: sanity clamps. Out-of-band means a bad match, not a bargain.
            const pct = Math.round((1 - usedAllIn / newPrice) * 100);
            if (pct < CONFIG.minPct || pct > CONFIG.maxPct) return { reason: 'implausible' };

            // Age-aware ceiling: catches same-generation cars whose model line was repriced
            // upward (a 2022 Honda City otherwise computes as 53% off).
            const age = Math.max(1, new Date().getFullYear() - car.year);
            const ceiling = Math.min(
                CONFIG.maxPct,
                CONFIG.firstYearPct + CONFIG.laterYearPct * (age - 1)
            );
            if (pct > ceiling) return { reason: 'implausible-for-age', pct, ceiling };

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

        // Reuse the site's own tokens so this is typographically identical to what it replaced.
        node.innerHTML =
            '<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap;' +
            'font-size:var(--font-size-150);line-height:var(--line-height-150);' +
            'font-weight:var(--medium);color:var(--grey-900)">' +
            '<span>' + text.main + '</span>' +
            (text.suffix
                ? '<span style="font-weight:var(--regular);color:var(--grey-500)">&middot;&nbsp;' + text.suffix + '</span>'
                : '') +
            '</span>';

        node.setAttribute('title', tooltip || '');
        card.setAttribute(MARK, '1');

        // The slot shares its row with the EMI text, so if the suffix pushes past the column,
        // drop it rather than wrap and clip.
        const inner = node.firstElementChild;
        if (inner && node.clientWidth && inner.scrollWidth > node.clientWidth && text.suffix) {
            inner.removeChild(inner.lastElementChild);
        }
    }

    function ageSuffix(year) {
        if (!year) return '';
        const age = new Date().getFullYear() - year;
        if (age <= 0) return '';
        return age + (age === 1 ? ' yr old' : ' yrs old');
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

        // Feature [2] is done. Paint it now; feature [1] refines the suffix if it earns it.
        let suffix = ageSuffix(car.year);
        render(card, node, { main, suffix }, tooltip);

        if (!car.make || !car.model) return;

        try {
            const res = await newCarCatalog.priceFor(car, total);
            if (res && typeof res.pct === 'number') {
                const approx = res.cityMatched ? '' : '~';
                suffix = approx + res.pct + '% off';
                tooltip +=
                    '\n' + res.pct + '% below new ' + res.variantName +
                    ' (' + fmt.rupees(res.newPrice) + ' on-road' +
                    (res.cityMatched && res.citySlug ? ', ' + res.citySlug : ', Delhi-NCR basis') + ').';
            } else if (res && res.range) {
                // Variant could not be matched honestly - show the model's range in the tooltip
                // instead of inventing a single percentage.
                tooltip +=
                    '\nNew ' + car.make + ' ' + car.model + ': ' +
                    fmt.lakh(res.range.min) + ' – ' + fmt.lakh(res.range.max) + ' on-road.';
            } else if (res && res.reason) {
                LOG(appId, car.make, car.model, car.year, '->', res.reason);
            }
            render(card, node, { main, suffix }, tooltip);
        } catch (e) {
            LOG('newcar lookup failed', e);
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
