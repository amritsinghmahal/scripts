// ==UserScript==
// @name         Cars24 Card Enricher
// @namespace    https://github.com/amritsinghmahal/scripts
// @version      1.3.1
// @description  Splits out the fees baked into every Cars24 price, adds an honest "% off new", km/year, days listed, and how many people saved the car.
// @match        https://www.cars24.com/*
// @connect      car-catalog-gateway-in.c24.tech
// @connect      www.cars24.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        // Both return the same priceSummary, but only the full record carries wishlistCount, and
        // nothing batched exposes it. 89 KB against 2 KB, hence the switch.
        detailApi: 'https://car-catalog-gateway-in.c24.tech/detail/v1/',
        chargesApi: 'https://car-catalog-gateway-in.c24.tech/detail/v1/charges/',
        showSaved: true,

        listingApi: 'https://car-catalog-gateway-in.c24.tech/listing/v1/cars',
        newCarsBase: 'https://www.cars24.com/new-cars/',
        variantSitemap: 'https://www.cars24.com/new-cars/new-cars-variants.xml',

        ttl: {
            detail: 12 * 60 * 60 * 1000,
            detailFail: 30 * 60 * 1000,
            newCarModel: 7 * 24 * 60 * 60 * 1000,
            sitemap: 7 * 24 * 60 * 60 * 1000,
            firstListing: 30 * 24 * 60 * 60 * 1000,
            firstListingFail: 60 * 60 * 1000,
        },

        maxConcurrent: 4,
        requestGapMs: 120,
        ageBatchSize: 40,
        ageBatchWaitMs: 90,

        avgKmPerYear: 12000,
        freshDays: 14,
        staleDays: 60,

        // New models get repriced upward every year, so a raw subtraction claims 53% off a 2022
        // Honda City and 73% off a 2015 one. Anything above the ceiling is inflation, not value.
        minPct: 1,
        maxPct: 40,
        firstYearPct: 30,
        laterYearPct: 3,

        brandAlias: {
            maruti: 'maruti-suzuki',
            'maruti suzuki': 'maruti-suzuki',
            mercedes: 'mercedes-benz',
            'mercedes benz': 'mercedes-benz',
            landrover: 'land-rover',
            'land rover': 'land-rover',
            vw: 'volkswagen',
        },

        // Add here when a car you know is on sale reports "not sold new".
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
            xuv700: 'xuv-7xo',
            xuv400: 'xuv400-ev',
            'new i20': 'i20',
            // XUV300, Elite i20 and Octavia are deliberately absent: those nameplates are the
            // previous car, so mapping them to today's slug would price a different model.
        },

        // Placeholder catalogue pages offer these instead of real trims.
        phantomVariantNames: ['base variant', 'top variant'],

        debug: false,
    };

    const LOG = (...a) => { if (CONFIG.debug) console.log('[c24ce]', ...a); };

    const SEL = {
        card: 'a.styles_carCardWrapper__sXLIp',
        pricing: '.styles_pricingDetail__Q_3hz',
        label: '.styles_labelContainer__NIr_r',
        priceWrap: '.styles_priceWrap__VwWBV',
        title: '.styles_outer__NTVth',
        heart: '.styles_outer__ZH1Cg',
    };

    const MARK = 'data-c24ce';
    const PILL_STACK = 'data-c24ce-pills';

    const yearsOld = (year) => Math.max(1, new Date().getFullYear() - year);

    /* -- storage ----------------------------------------------------------- */

    const store = {
        // Bump when a cached record changes shape; older entries are then swept, not read.
        SCHEMA: 'v4',
        PREFIX: 'c24ce:',
        key(k) { return this.PREFIX + this.SCHEMA + ':' + k; },

        drop(staleOnly) {
            const mine = this.key('');
            try {
                Object.keys(localStorage)
                    .filter((k) => k.indexOf(this.PREFIX) === 0 && !(staleOnly && k.indexOf(mine) === 0))
                    .forEach((k) => localStorage.removeItem(k));
            } catch (_) { /* private mode */ }
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
                // Model pages cost most of a megabyte to rebuild, so shed the cheap keys first.
                this.evictCheap();
                try { write(); } catch (_) { /* the cache is an optimisation */ }
            }
        },

        evictCheap() {
            const keep = this.key('nc:');
            const sitemap = this.key('sitemap');
            try {
                const mine = Object.keys(localStorage).filter((k) => k.indexOf(this.PREFIX) === 0);
                const cheap = mine.filter((k) => k.indexOf(keep) !== 0 && k !== sitemap);
                (cheap.length ? cheap : mine).forEach((k) => localStorage.removeItem(k));
            } catch (_) {}
        },
    };

    /* -- formatting -------------------------------------------------------- */

    const fmt = {
        // 744713 -> "7,44,713"
        grouped(n) {
            const s = String(Math.round(n));
            if (s.length <= 3) return s;
            return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
        },

        // 744713 -> "₹7.45L"
        lakh(n) {
            const l = n / 100000;
            if (l >= 100) return '₹' + (l / 100).toFixed(2) + 'Cr';
            return '₹' + l.toFixed(2) + 'L';
        },

        // 1190000, 1550000 -> "₹11.9-15.5L"
        lakhRange(min, max) {
            const one = (n) => (n / 100000).toFixed(1).replace(/\.0$/, '');
            return '₹' + one(min) + '-' + one(max) + 'L';
        },

        // 50474 -> "₹50.5k", 2474 -> "₹2,474"
        compact(n) {
            if (n >= 100000) return this.lakh(n);
            if (n >= 10000) return '₹' + (n / 1000).toFixed(1) + 'k';
            return '₹' + this.grouped(n);
        },

        rupees(n) { return '₹' + this.grouped(n); },
    };

    // "navi-mumbai" -> "Navi Mumbai"
    const titleCase = (slug) => String(slug || '').split('-').filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const slugify = (s) => String(s || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

    // A 404 means the model is gone; a dropped connection means nothing. Callers treat them
    // differently, so the distinction has to survive.
    const notFound = (err) => !!err && err.status === 404;

    function httpError(status) {
        const e = new Error('HTTP ' + status);
        e.status = status;
        return e;
    }

    // These endpoints allow the cars24.com origin, so plain fetch works; GM is the fallback.
    function httpGet(url, headers, asText) {
        return fetch(url, { headers: headers || {}, credentials: 'omit' })
            .then((r) => {
                if (!r.ok) throw httpError(r.status);
                return asText ? r.text() : r.json();
            })
            .catch((err) => {
                if (notFound(err)) throw err;
                return gmGet(url, headers, asText);
            });
    }

    function httpPost(url, headers, body) {
        return fetch(url, {
            method: 'POST',
            headers: headers || {},
            body: JSON.stringify(body),
            credentials: 'omit',
        }).then((r) => {
            if (!r.ok) throw httpError(r.status);
            return r.json();
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

    /* -- car data from the page -------------------------------------------- */

    // The RSC payload gives exact integers, where the DOM only has a rounded "₹6.94 lakh".
    const flight = {
        cars: new Map(),
        seen: 0,

        refresh() {
            const chunks = window.self && window.self.__next_f;
            if (!Array.isArray(chunks) || chunks.length === this.seen) return this.cars;
            this.seen = chunks.length;

            let s = '';
            for (const entry of chunks) {
                if (Array.isArray(entry) && typeof entry[1] === 'string') s += entry[1];
            }

            const needle = '{"appointmentId"';
            let i = s.indexOf(needle);
            while (i !== -1) {
                const obj = this.balanced(s, i);
                if (obj) {
                    try {
                        const car = JSON.parse(obj);
                        if (car && car.appointmentId) this.cars.set(String(car.appointmentId), car);
                    } catch (_) { /* partial chunk */ }
                }
                i = s.indexOf(needle, i + needle.length);
            }
            return this.cars;
        },

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
                else if (c === '}' && --depth === 0) return s.slice(start, k + 1);
            }
            return null;
        },

        get(appId) {
            if (this.cars.has(appId)) return this.cars.get(appId);
            this.refresh();
            return this.cars.get(appId) || null;
        },
    };

    // Only server-rendered cards reach __next_f; the rest arrive by XHR. They all carry a
    // structured image alt though: "2021 Skoda KUSHAQ - SUV - Petrol - Manual - ₹6.94 lakh".
    const scrape = {
        MULTI_MAKES: ['land rover', 'aston martin', 'rolls royce', 'maruti suzuki', 'mercedes benz'],

        fromCard(card) {
            const img = card.querySelector('img[alt]');
            const alt = img ? img.getAttribute('alt') || '' : '';
            const m = alt.match(/^(\d{4})\s+(.+?)\s+-\s+([^-]+?)\s+-\s+([^-]+?)\s+-\s+([^-]+?)\s+-\s+/);
            if (!m) return null;

            const nameBlob = m[2].trim();
            const lower = nameBlob.toLowerCase();
            const multi = this.MULTI_MAKES.find((x) => lower.startsWith(x));

            let make, model;
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
                year: parseInt(m[1], 10),
                make,
                model,
                fuelType: m[4].trim(),
                transmissionType: { value: m[5].trim() },
                odometer: this.odometerOf(card),
                variant: this.variantOf(card),
            };
        },

        odometerOf(card) {
            for (const el of card.querySelectorAll('p, span')) {
                const m = (el.textContent || '').trim().match(/^([\d,]+)\s*km$/i);
                if (m) {
                    const value = parseInt(m[1].replace(/,/g, ''), 10);
                    if (isFinite(value) && value > 0) return { value };
                }
            }
            return null;
        },

        // The trim is the span right after the "2021 Skoda KUSHAQ" title.
        variantOf(card) {
            const spans = (card.querySelector(SEL.title) || card).querySelectorAll('span');
            for (let i = 0; i < spans.length; i++) {
                const t = (spans[i].textContent || '').trim();
                if (t && /^\d{4}\s/.test(t) && spans[i + 1]) {
                    return (spans[i + 1].textContent || '').trim();
                }
            }
            return '';
        },
    };

    /* -- fees and save count ----------------------------------------------- */

    const carDetail = {
        get(appId, carSegment) {
            const headers = { X_TENANT_ID: 'INDIA_CAR_LISTING' };
            if (carSegment) headers.X_CAR_SEGMENT = carSegment;

            const request = CONFIG.showSaved
                ? () => httpPost(CONFIG.detailApi,
                    Object.assign({ 'Content-Type': 'application/json' }, headers),
                    { appointmentId: String(appId) })
                : () => httpGet(CONFIG.chargesApi + encodeURIComponent(appId),
                    Object.assign({ Source: 'mSite' }, headers), false);

            return cachedFetch('cd:' + appId, request, (err, data) => {
                const out = err ? null : this.parse(data);
                return out
                    ? { v: out, ttl: CONFIG.ttl.detail }
                    : { v: { fail: true }, ttl: CONFIG.ttl.detailFail };
            }).then((rec) => (rec && rec.fail ? null : rec));
        },

        // The slim route puts priceSummary at the top level; the full record nests it under detail.
        parse(data) {
            const detail = (data && data.detail) || {};
            const summary = detail.priceSummary || data;
            if (!summary || !summary.finalPrice || typeof summary.finalPrice.amount !== 'number') return null;

            const charges = summary.charges || [];
            const baseLine = charges.find((c) => c && c.id === 'BasePrice');
            const base = baseLine ? baseLine.amount : null;
            const total = summary.finalPrice.amount;
            const lines = charges
                .filter((c) => c && c.id !== 'BasePrice')
                .map((c) => ({ title: c.title, amount: c.amount, note: c.amountDescription }));

            // totalExtraCharges now reports 0 even with the lines populated, so derive it.
            const fees = typeof base === 'number' && total > base
                ? total - base
                : lines.reduce((sum, l) => sum + (l.amount || 0), 0);

            return {
                base,
                fees,
                total,
                lines,
                saved: typeof detail.wishlistCount === 'number' ? detail.wishlistCount : null,
            };
        },
    };

    /* -- days listed ------------------------------------------------------- */

    // firstListingTime is the column the site's own "Recently Added" sort runs on. Many ids per
    // call, so cards are collected for a moment and asked for together.
    const listingAge = {
        queue: new Map(),
        timer: null,

        get(appId) {
            const cached = store.get('fl:' + appId);
            if (cached) return Promise.resolve(cached.miss ? null : this.daysSince(cached.t));

            return new Promise((resolve) => {
                if (!this.queue.has(appId)) this.queue.set(appId, []);
                this.queue.get(appId).push(resolve);

                if (this.queue.size >= CONFIG.ageBatchSize) this.flush();
                else if (!this.timer) this.timer = setTimeout(() => this.flush(), CONFIG.ageBatchWaitMs);
            });
        },

        flush() {
            clearTimeout(this.timer);
            this.timer = null;
            if (!this.queue.size) return;

            const batch = Array.from(this.queue.keys()).slice(0, CONFIG.ageBatchSize);
            const waiting = new Map();
            batch.forEach((id) => { waiting.set(id, this.queue.get(id)); this.queue.delete(id); });

            // No custom headers keeps this a CORS-simple request, so there is no preflight.
            gate.run(() => httpGet(CONFIG.listingApi + '?appIds=' + batch.join(','), {}, false))
                .then((data) => {
                    const found = new Map();
                    for (const car of (data && data.content) || []) {
                        if (car && car.appointmentId && car.firstListingTime) {
                            found.set(String(car.appointmentId), car.firstListingTime);
                        }
                    }
                    for (const id of batch) {
                        const t = found.get(id);
                        // Unknown ids are dropped from the response rather than returned null.
                        if (t) store.set('fl:' + id, { t }, CONFIG.ttl.firstListing);
                        else store.set('fl:' + id, { miss: true }, CONFIG.ttl.firstListingFail);
                        this.settle(waiting.get(id), t ? this.daysSince(t) : null);
                    }
                })
                .catch(() => {
                    for (const id of batch) this.settle(waiting.get(id), null);
                })
                .then(() => { if (this.queue.size) this.flush(); });
        },

        settle(resolvers, value) {
            (resolvers || []).forEach((r) => r(value));
        },

        // Timestamps arrive both with and without milliseconds in the same response.
        daysSince(iso) {
            const t = Date.parse(iso);
            if (!isFinite(t)) return null;
            return Math.max(0, Math.floor((Date.now() - t) / 86400000));
        },
    };

    /* -- what the same model costs new ------------------------------------- */

    const FUEL_WORDS = { petrol: 'petrol', diesel: 'diesel', cng: 'cng', electric: 'electric', ev: 'electric', hybrid: 'hybrid' };
    const DROP_TOKENS = new Set(['mt', 'at', 'amt', 'cvt', 'dct', 'tsi', 'tdi', 'vtec', 'ivtec', 'kappa', 'vtvt', 'dual', 'tone', 'o', 'opt', 'option', 'bsvi', 'bsiv', 'duo', 'hy', 'plus', 'l']);
    const NON_CITY_SLUGS = new Set(['cars', 'used-cars', 'sunroof', 'first-owner', 'automatic', 'petrol', 'diesel', 'cng', 'electric']);

    function norm(s) {
        s = String(s || '').toLowerCase().trim();
        if (!s) return '';
        if (/manual/.test(s)) return 'manual';
        if (/automatic|amt|cvt|dct|at\b/.test(s)) return 'automatic';
        for (const k in FUEL_WORDS) if (s.indexOf(k) !== -1) return FUEL_WORDS[k];
        return s;
    }

    // "ZETA PETROL 1.2" -> ["zeta"]
    function tokenize(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .filter((t) => !/^\d/.test(t))
            .filter((t) => !DROP_TOKENS.has(t))
            .filter((t) => !(t in FUEL_WORDS));
    }

    function unescapeJson(s) {
        try { return JSON.parse('"' + s + '"'); }
        catch (_) { return s; }
    }

    const newCarCatalog = {
        index: null,
        models: new Map(),

        loadIndex() {
            if (this.index) return Promise.resolve(this.index);
            return cachedFetch('sitemap',
                () => httpGet(CONFIG.variantSitemap, {}, true),
                (err, xml) => {
                    const slugs = [];
                    if (!err && typeof xml === 'string') {
                        const re = /<loc>\s*https:\/\/www\.cars24\.com\/new-cars\/([^/]+)\/([^/]+)\/([^/<]+)\/?\s*<\/loc>/g;
                        let m;
                        while ((m = re.exec(xml))) slugs.push(m[1] + '/' + m[2]);
                    }
                    return slugs.length ? { v: slugs, ttl: CONFIG.ttl.sitemap } : { v: [] };
                }
            ).then((slugs) => {
                this.index = new Set(slugs);
                return this.index;
            });
        },

        resolveSlug(car) {
            const mk = String(car.make || '').toLowerCase().trim();
            const mo = String(car.model || '').toLowerCase().trim();
            return (CONFIG.brandAlias[mk] || slugify(mk)) + '/' + (CONFIG.modelAlias[mo] || slugify(mo));
        },

        loadModel(slug, citySlug) {
            const key = slug + (citySlug ? '@' + citySlug : '');
            if (this.models.has(key)) return Promise.resolve(this.models.get(key));

            const url = CONFIG.newCarsBase + slug + '/' + (citySlug ? 'price-in-' + citySlug + '/' : '');

            return cachedFetch('nc:' + key, () => httpGet(url, {}, true), (err, html) => {
                // Only a 404 says the model is gone. Anything else (offline, timeout, rate limit)
                // says nothing about the car, so it must not be remembered as "not sold new".
                if (err && !notFound(err)) return { v: { unknown: true } };
                const parsed = !err && typeof html === 'string' ? this.parseVariants(html) : null;
                const rec = parsed && parsed.length ? { variants: parsed } : { absent: true };
                return { v: rec, ttl: CONFIG.ttl.newCarModel };
            }).then((rec) => {
                // Memoise either way, so one blip does not re-fetch a megabyte per remaining card.
                this.models.set(key, rec);
                return rec;
            });
        },

        // Read from a text window rather than JSON.parsed: the compact payload uses "$ad"
        // back-references, but the expanded one inlines its arrays and runs a variant past 13 KB.
        parseVariants(html) {
            const decoded = this.decodeFlight(html);
            const hits = [];
            const re = /"exShowroomPrice":\s*(\d+)/g;
            let m;
            while ((m = re.exec(decoded))) hits.push({ at: m.index, ex: parseInt(m[1], 10) });

            // Same variant repeats across sections; keep whichever copy carries an on-road price.
            const byKey = new Map();
            hits.forEach((hit, i) => {
                const objStart = decoded.lastIndexOf('{', hit.at);
                if (objStart === -1 || !(hit.ex > 0)) return;

                const name = (decoded.slice(objStart, hit.at).match(/"name":"((?:\\.|[^"\\])*)"/) || [])[1];
                if (!name) return;

                const next = i + 1 < hits.length ? hits[i + 1].at : decoded.length;
                const scope = decoded.slice(hit.at, Math.min(next, hit.at + 60000));
                const onRoad = parseFloat((scope.match(/"onRoadPrice":\s*([\d.]+)/) || [])[1]);

                const v = {
                    name: unescapeJson(name),
                    onRoad: isFinite(onRoad) && onRoad > 0 ? onRoad : null,
                    fuel: (scope.match(/"fuelType":"([^"]{1,20})"/) || [])[1] || '',
                    trans: (scope.match(/"transmissionType":"([^"]{1,20})"/) || [])[1] || '',
                };

                const k = v.name + '|' + hit.ex;
                const prev = byKey.get(k);
                if (!prev || (!prev.onRoad && v.onRoad)) byKey.set(k, v);
            });
            return Array.from(byKey.values());
        },

        decodeFlight(html) {
            let out = '';
            const re = /self\.__next_f\.push\(\[\s*\d+\s*,\s*"((?:\\.|[^"\\])*)"/g;
            let m;
            while ((m = re.exec(html))) {
                try { out += JSON.parse('"' + m[1] + '"'); }
                catch (_) { /* skip the chunk, keep the rest */ }
            }
            return out || html;
        },

        // Returns one of:
        //   { kind: 'discount', pct, newPrice, variantName, exact, cityMatched, citySlug }
        //   { kind: 'discontinued' }                nobody sells this model new any more
        //   { kind: 'range', range, reason }        still sold, but no figure worth defending
        //   { kind: 'none', reason }
        async priceFor(car, usedAllIn) {
            const slug = this.resolveSlug(car);

            const index = await this.loadIndex();
            if (index.size && !index.has(slug)) return { kind: 'discontinued' };

            // Compare on-road against on-road for the same RTO where the city page exists.
            const citySlug = this.citySlugFor(car);
            let rec = await this.loadModel(slug, citySlug);
            let cityMatched = !!citySlug;
            if (!rec.variants && citySlug) {
                rec = await this.loadModel(slug, null);
                cityMatched = false;
            }
            if (rec.unknown) return { kind: 'none', reason: 'lookup-failed' };
            if (rec.absent || !rec.variants || !rec.variants.length) return { kind: 'discontinued' };

            // /new-cars/volkswagen/polo/ answers 200 for a car pulled from India in 2022, with a
            // fabricated "Base Variant" and isDiscontinued:false. Names give it away; flags do not.
            const real = rec.variants.filter(
                (v) => !CONFIG.phantomVariantNames.includes(v.name.toLowerCase().trim())
            );
            if (!real.length) return { kind: 'discontinued' };

            const range = this.rangeOf(real);
            const noFigure = (reason) => (range ? { kind: 'range', range, reason } : { kind: 'none', reason });

            // Trims get renamed between generations, so fall back to the cheapest comparable one.
            let match = this.matchVariant(car, real);
            const exact = !!match;
            if (!match) match = this.cheapestComparable(car, real);
            if (!match || !match.name || !(match.onRoad > 0)) return noFigure('variant-unmatched');

            const newPrice = match.onRoad;
            const pct = Math.round((1 - usedAllIn / newPrice) * 100);
            if (pct < CONFIG.minPct) return noFigure('no-saving');

            const ceiling = Math.min(
                CONFIG.maxPct,
                CONFIG.firstYearPct + CONFIG.laterYearPct * (yearsOld(car.year) - 1)
            );
            if (pct > ceiling) return noFigure('above-ceiling');

            return { kind: 'discount', pct, newPrice, variantName: match.name, exact, cityMatched, citySlug };
        },

        // Same fuel and gearbox as the used car; a blank field on either side is not a mismatch.
        comparable(car, variants) {
            const wantFuel = norm(car.fuelType);
            const wantTrans = norm(car.transmissionType && car.transmissionType.value);
            return variants.filter((v) => {
                const f = norm(v.fuel), t = norm(v.trans);
                return (!wantFuel || !f || f === wantFuel) && (!wantTrans || !t || t === wantTrans);
            });
        },

        matchVariant(car, variants) {
            const usedTokens = tokenize(car.variant);
            if (!usedTokens.length) return null;

            let best = null, bestScore = 0;
            for (const v of this.comparable(car, variants)) {
                const vt = tokenize(v.name);
                if (!vt.length) continue;
                const overlap = vt.filter((t) => usedTokens.includes(t));
                if (!overlap.length) continue;
                const score = overlap.length / vt.length;
                if (score > bestScore) { bestScore = score; best = v; }
            }
            // A weak partial is how "Renault RXT" ends up matched to "Techno".
            return bestScore >= 0.5 ? best : null;
        },

        cheapestComparable(car, variants) {
            const usable = this.comparable(car, variants).filter((v) => v.onRoad);
            if (!usable.length) return null;
            return usable.reduce((lo, v) => (v.onRoad < lo.onRoad ? v : lo));
        },

        rangeOf(variants) {
            const on = variants.map((v) => v.onRoad).filter((x) => x > 0);
            if (!on.length) return null;
            return { min: Math.min.apply(null, on), max: Math.max.apply(null, on) };
        },

        citySlugFor(car) {
            // /buy-used-cars-pune/ and /buy-used-maruti-baleno-cars-pune/ both occur.
            const m = location.pathname.match(/\/buy-used-(?:.*-)?cars-([a-z]+(?:-[a-z]+)*)\/?$/);
            let city = m ? m[1] : '';

            if (!city) {
                const loc = car.address && car.address.locality;
                if (loc) city = String(loc).split(',').pop();
            }

            const s = slugify(city);
            if (!s || s.length < 3 || NON_CITY_SLUGS.has(s)) return null;
            return s;
        },
    };

    /* -- the label under the price ----------------------------------------- */

    // The price the card is advertising. Exact from the payload where we have it, otherwise read off
    // the card - rounded to the nearest thousand, which is plenty against a total that differs by
    // tens of thousands.
    function headlinePrice(card, car) {
        if (car && car.listingPrice > 0) return car.listingPrice;

        const wrap = card.querySelector(SEL.priceWrap);
        if (!wrap) return null;

        const prices = [];
        for (const el of wrap.querySelectorAll('p, span')) {
            if (el.children.length) continue;
            const value = parsePrice(el.textContent);
            if (value) prices.push(el);
        }
        if (!prices.length) return null;

        // In every layout the site has used the asking price comes last, so position is the reliable
        // signal; computed styles are only consulted to skip a struck-through "was" price.
        const asking = prices.length > 1 ? prices.filter((el) => !struckThrough(el)) : prices;
        const pick = (asking.length ? asking : prices).pop();
        return parsePrice(pick.textContent);
    }

    function struckThrough(el) {
        try {
            const s = window.getComputedStyle && window.getComputedStyle(el);
            return !!s && /line-through/.test(s.textDecorationLine || s.textDecoration || '');
        } catch (_) {
            return false;
        }
    }

    // "₹5.84 lakh" -> 584000, "₹6.16L" -> 616000, "₹1.2 Cr" -> 12000000
    function parsePrice(text) {
        const m = String(text || '').match(/₹\s*([\d.,]+)\s*(lakh|l|cr|crore)?/i);
        if (!m) return null;
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (!isFinite(n) || n <= 0) return null;
        const unit = (m[2] || '').toLowerCase();
        if (unit === 'cr' || unit === 'crore') return Math.round(n * 10000000);
        if (unit === 'lakh' || unit === 'l') return Math.round(n * 100000);
        return Math.round(n);
    }

    function labelNodeOf(card) {
        const n = card.querySelector(SEL.label);
        if (n) return n;

        // If the CSS-module hash changes on a deploy, find the strapline by its wording.
        const scope = card.querySelector(SEL.pricing) || card;
        for (const c of scope.querySelectorAll('div, span, p')) {
            const t = (c.textContent || '').trim().toLowerCase();
            if (t === '+ other charges' || t === '+ extra charges' ||
                /^includes rc transfer/.test(t) || t === 'price negotiable') {
                return c.closest('div') || c;
            }
        }
        return null;
    }

    // Cars24 has shipped the price both ways, so measure instead of assuming: anything still owed on
    // top of the headline is the story, otherwise the hidden fact is how much of it is fees.
    function feeLabel(detail, headline) {
        const total = detail.total;
        const feesAreExtra = headline === null || total - headline > 1000;
        const showFees = !feesAreExtra && detail.fees > 0;

        const itemised = detail.lines
            .map((l) => l.title + ' ' + (l.note && /included/i.test(l.note) ? '(included)' : fmt.rupees(l.amount || 0)))
            .join(', ');

        return {
            main: showFees ? 'incl. ' + fmt.compact(detail.fees) + ' fees' : fmt.lakh(total) + ' all-in',
            short: showFees ? fmt.compact(detail.fees) + ' fees' : fmt.lakh(total),
            tooltip: (showFees
                ? 'Car ' + fmt.rupees(detail.base) + ' + ' + fmt.rupees(detail.fees) + ' fees = ' + fmt.rupees(total)
                : 'Total ' + fmt.rupees(total)) + (itemised ? ' — incl. ' + itemised : ''),
        };
    }

    function comparisonText(res, car) {
        switch (res && res.kind) {
            case 'discount':
                return {
                    suffix: (res.exact ? '' : '~') + res.pct + '% off',
                    tip: res.pct + '% cheaper than a new ' + res.variantName + ' at ' +
                        fmt.rupees(res.newPrice) + ' on-road' +
                        (res.cityMatched && res.citySlug ? ' in ' + titleCase(res.citySlug) : ' (Delhi-NCR)') +
                        (res.exact ? '.' : ', the closest current trim.'),
                };
            case 'discontinued':
                return {
                    suffix: 'not sold new',
                    tip: 'The ' + car.make + ' ' + car.model + ' is not sold new any more, so there ' +
                        'is no new price to compare against.',
                };
            case 'range':
                return {
                    suffix: 'new ' + fmt.lakhRange(res.range.min, res.range.max),
                    tip: 'A new ' + car.make + ' ' + car.model + ' runs ' + fmt.rupees(res.range.min) +
                        ' to ' + fmt.rupees(res.range.max) + ' on-road. Too much has changed since ' +
                        'this one to put a single figure on the gap.',
                };
            default:
                return null;
        }
    }

    function render(card, node, text, tooltip) {
        if (!node) return;
        card.setAttribute(MARK, '1');

        // The slot is 19px tall in a fixed-height card that clips, so there is no room to wrap.
        // Shed detail in order of least value; the percentage is the point, so it goes last.
        const steps = [
            [text.main, text.suffix],
            [text.short || text.main, text.suffix],
            [text.short || text.main, ''],
        ];
        for (const [main, suffix] of steps) {
            paint(node, main, suffix, tooltip);
            if (!overflowing(node)) return;
        }
    }

    function paint(node, main, suffix, tooltip) {
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

    /* -- pills over the photo ---------------------------------------------- */

    const TONE = {
        good: { fg: '#1B6B4A', bg: 'rgba(232,248,240,0.94)' },
        plain: { fg: '#3F4145', bg: 'rgba(255,255,255,0.94)' },
        warn: { fg: '#A33A2B', bg: 'rgba(253,236,233,0.94)' },
    };

    // Each pill arrives whenever its request finishes, so the stack is ordered explicitly - by
    // insertion the rows would shuffle between loads.
    const PILLS = ['km', 'age', 'saved'];

    function pillStack(card) {
        let stack = card.querySelector('[' + PILL_STACK + ']');
        if (stack) return stack;

        // The heart sits in an absolutely positioned box; hang the stack off its offset parent so it
        // tracks the heart wherever the card is laid out.
        const heart = card.querySelector(SEL.heart);
        const host = heart && heart.parentElement && heart.parentElement.parentElement;
        if (!host) return null;
        if (!host.style.position) host.style.position = 'relative';

        stack = document.createElement('div');
        stack.setAttribute(PILL_STACK, '1');
        stack.style.cssText = [
            'position:absolute',
            'top:40px',
            'right:8px',
            'z-index:9',
            'display:flex',
            'flex-direction:column',
            'align-items:flex-end',
            'gap:4px',
            'pointer-events:none',
        ].join(';');
        host.appendChild(stack);
        return stack;
    }

    function addPill(card, name, spec) {
        if (!spec) return;
        const marker = 'data-c24ce-' + name;
        if (card.querySelector('[' + marker + ']')) return;

        const stack = pillStack(card);
        if (!stack) return;

        const pill = document.createElement('div');
        pill.setAttribute(marker, '1');
        pill.style.cssText = [
            'order:' + (PILLS.indexOf(name) + 1),
            'padding:2px 6px',
            'border-radius:6px',
            'background:' + spec.tone.bg,
            'color:' + spec.tone.fg,
            'font-size:11px',
            'line-height:13px',
            'font-weight:var(--semibold, 600)',
            'text-align:right',
            'white-space:nowrap',
            'box-shadow:0 1px 3px rgba(0,0,0,0.12)',
        ].join(';');
        pill.innerHTML =
            '<span>' + spec.value + '</span>' +
            '<span style="font-weight:var(--regular, 400);opacity:0.75">' + (spec.unit || '') + '</span>';
        if (spec.tip) {
            pill.setAttribute('title', spec.tip);
            pill.style.pointerEvents = 'auto';
        }
        stack.appendChild(pill);
    }

    // 70,000 km is a lot on a 2021 car and unremarkable on a 2013 one.
    function kmPerYear(car) {
        const km = car.odometer && car.odometer.value;
        if (!km || !car.year) return null;
        return Math.round(km / yearsOld(car.year));
    }

    function kmSpec(car) {
        const perYear = kmPerYear(car);
        if (!perYear) return null;
        const ratio = perYear / CONFIG.avgKmPerYear;
        return {
            value: fmt.grouped(perYear),
            unit: ' km/yr',
            tone: ratio <= 0.75 ? TONE.good : ratio >= 1.4 ? TONE.warn : TONE.plain,
            tip: car.odometer.display
                ? car.odometer.display + ' over ' + yearsOld(car.year) + ' years'
                : '',
        };
    }

    function ageSpec(days) {
        if (days === null || days < 0) return null;
        const stale = days > CONFIG.staleDays;
        return {
            value: days === 0 ? 'listed today' : 'listed ' + days + 'd',
            tone: days < CONFIG.freshDays ? TONE.good : stale ? TONE.warn : TONE.plain,
            tip: days === 0
                ? 'Listed on Cars24 today'
                : 'First listed on Cars24 ' + days + (days === 1 ? ' day' : ' days') + ' ago' +
                  (stale ? ' - it has been sitting a while, so there may be room to negotiate' : ''),
        };
    }

    // Cars24 rounds this to the nearest ten, so it is a gauge of interest rather than a tally.
    function savedSpec(saved) {
        if (typeof saved !== 'number' || saved <= 0) return null;
        return {
            value: fmt.grouped(saved),
            unit: ' saved',
            tone: TONE.plain,
            tip: 'About ' + fmt.grouped(saved) + ' people have shortlisted this car',
        };
    }

    /* -- per card ---------------------------------------------------------- */

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

        const car = flight.get(appId) || scrape.fromCard(card) || {};

        // C2C listings are negotiable, so there is no fixed total to quote.
        if (car.businessVertical === 'C2C') return;

        const detailPromise = carDetail.get(appId, car.carSegment);

        addPill(card, 'km', kmSpec(car));
        listingAge.get(appId).then((days) => addPill(card, 'age', ageSpec(days))).catch(() => {});
        detailPromise.then((d) => addPill(card, 'saved', d && savedSpec(d.saved))).catch(() => {});

        const node = labelNodeOf(card);
        if (!node) return;

        const detail = await detailPromise;
        if (!detail) return;

        const label = feeLabel(detail, headlinePrice(card, car));
        render(card, node, label, label.tooltip);

        if (!car.make || !car.model) return;

        try {
            const res = await newCarCatalog.priceFor(car, detail.total);
            const said = comparisonText(res, car);
            if (said) {
                render(card, node, { main: label.main, short: label.short, suffix: said.suffix },
                    label.tooltip + '\n' + said.tip);
            } else if (res && res.reason) {
                LOG(appId, car.make, car.model, car.year, '->', res.reason);
            }
        } catch (e) {
            LOG('new-car lookup failed', e);
        }
    }

    /* -- discovery --------------------------------------------------------- */

    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            processCard(e.target);
        }
    }, { rootMargin: '200px 0px' });

    function scan() {
        flight.refresh();
        for (const c of document.querySelectorAll(SEL.card + ':not([' + MARK + '])')) {
            if (!done.has(c)) io.observe(c);
        }
    }

    let scanTimer = null;
    function scanSoon() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 150);
    }

    // Our own pills and labels also mutate the page, so ignore records that only touch them.
    function onMutation(records) {
        for (const r of records) {
            const t = r.target;
            if (t && t.closest && t.closest('[' + PILL_STACK + '],' + SEL.label)) continue;
            scanSoon();
            return;
        }
    }

    function start() {
        store.drop(true);
        scan();

        new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true });

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

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            fmt, tokenize, norm, appIdOf, flight, CONFIG,
            carDetail, listingAge, newCarCatalog,
            kmPerYear, feeLabel, comparisonText, parsePrice,
        };
    }
})();
