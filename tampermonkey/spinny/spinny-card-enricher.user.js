// ==UserScript==
// @name         Spinny Card Enricher
// @namespace    spinny-card-enricher
// @version      1.2.1
// @description  Shows what a Spinny car actually costs all-in, how much of it is fees, km/year, how long it has been listed, how many people saved it - and strips the sale-discount pill and the "Save extra" loan banner off every card.
// @match        https://www.spinny.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

// @grant none is load-bearing: it keeps us in the page realm, where the taps below see Spinny's calls.

(function () {
    'use strict';

    const CONFIG = {
        topUpApi: 'https://api.spinny.com/v3/api/listing/v3/',
        detailApi: 'https://www.spinny.com/api/product-detail/fetch-page-data/',
        showAge: true,

        ttl: {
            topUp: 6 * 60 * 60 * 1000,
            topUpFail: 30 * 60 * 1000,
            addedOn: 30 * 24 * 60 * 60 * 1000,
            addedOnFail: 60 * 60 * 1000,
        },

        maxConcurrent: 4,
        requestGapMs: 120,
        topUpBatchSize: 40,
        topUpBatchWaitMs: 90,

        // How far outside the viewport a card still counts as worth paying a request for.
        viewportMargin: 200,
        // Debounce for the card sweep, and the longest it may be deferred - a continuous
        // scroll would otherwise keep resetting the timer and starve it indefinitely.
        scanDebounceMs: 150,
        scanMaxWaitMs: 500,
        // Backstop sweep. Every event-driven trigger is a guess about when Spinny changes
        // the grid; this one needs no guess to be right.
        sweepMs: 2000,

        avgKmPerYear: 12000,
        freshDays: 14,
        staleDays: 60,
        minPriceDrop: 10000,
        maxPills: 3,

        hideSalePill: true,
        hideLoanBanner: true,
        hideSlashedPrice: false,

        debug: false,
    };

    const LOG = (...a) => { if (CONFIG.debug) console.log('[spce]', ...a); };

    const SEL = {
        cell: '.CarListingDesktop__carListingCarWrapper',
        card: '[class*="carListingCardV2Root"],[class*="carListingCardV3Root"]',
        body: '[class*="carListingCarContainer"]',
        detail: '[class*="productDetailContainer"]',
        heart: '[data-id="shortlist_icon"]',
        link: 'a[href*="/buy-used-cars/"]',
        price: '[class*="priceWithRupeeSymbol"]',
    };

    const MARK = 'data-spce';
    const PILL_STACK = 'data-spce-pills';
    const LINE = 'data-spce-line';

    /* -- promo removal ------------------------------------------------------ */

    // CSS, not node removal: React re-renders these cards, and !important beats Spinny's inline styles.
    function stripPromos() {
        if (document.getElementById('spce-css')) return;

        const rules = [];

        if (CONFIG.hideSalePill) {
            rules.push('[class*="specialOfferBadgeWrapper"]{display:none!important}');
        }

        if (CONFIG.hideLoanBanner) {
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
        if (mount) {
            mount.appendChild(style);
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                (document.head || document.documentElement).appendChild(style);
            }, { once: true });
        }
    }

    /* -- the network tap --------------------------------------------------- */

    const tap = {
        cars: new Map(),

        install() {
            this.wrapXhr();
            this.wrapFetch();
        },

        harvest(data) {
            if (!data || typeof data !== 'object') return;

            const take = (car) => {
                if (car && typeof car === 'object' && car.id && car.make) this.merge(String(car.id), car);
            };

            for (const list of [data.results, data.data, data.content, data.cars]) {
                if (Array.isArray(list)) list.forEach(take);
            }

            const byId = data.listById || (data.productList && data.productList.listById);
            if (byId && typeof byId === 'object') Object.values(byId).forEach(take);
        },

        merge(id, car) {
            const prev = this.cars.get(id);
            this.cars.set(id, prev ? { ...prev, ...car } : car);
        },

        wrapXhr() {
            const XHR = window.XMLHttpRequest;
            if (!XHR || !XHR.prototype || XHR.prototype[MARK]) return;
            const send = XHR.prototype.send;

            XHR.prototype.send = function (...args) {
                this.addEventListener('load', () => {
                    try {
                        // Reading responseText on a responseType:"json" request throws; use .response.
                        const body = this.responseType === 'json'
                            ? this.response
                            : JSON.parse(this.responseText);
                        tap.harvest(body);
                        if (tap.cars.size) scanSoon();
                    } catch {}
                });
                return send.apply(this, args);
            };
            XHR.prototype[MARK] = 1;
        },

        wrapFetch() {
            const orig = window.fetch;
            if (typeof orig !== 'function' || orig[MARK]) return;

            const wrapped = function (...args) {
                return orig.apply(this, args).then((res) => {
                    // Clone: reading the body here would consume the caller's copy of it.
                    try {
                        res.clone().json().then((body) => {
                            tap.harvest(body);
                            if (tap.cars.size) scanSoon();
                        }, () => {});
                    } catch {}
                    return res;
                });
            };
            wrapped[MARK] = 1;
            window.fetch = wrapped;
        },

        get(id) { return this.cars.get(id) || null; },
    };

    tap.install();
    stripPromos();

    /* -- the React fallback ------------------------------------------------ */

    const fiber = {
        get(cell) {
            try {
                const key = Object.keys(cell).find((k) => k.startsWith('__reactFiber$'));
                if (!key) return null;

                let node = cell[key];
                for (let depth = 0; node && depth < 8; depth++) {
                    const props = node.memoizedProps;
                    if (props && props.id && props.make && props.model) return props;
                    node = node.child;
                }
            } catch {}
            return null;
        },
    };

    /* -- storage ----------------------------------------------------------- */

    // Every localStorage touch is wrapped: it throws outright in private mode and once quota is full.
    const store = {
        SCHEMA: 'v1',
        PREFIX: 'spce:',
        key(k) { return this.PREFIX + this.SCHEMA + ':' + k; },

        drop(staleOnly) {
            const mine = this.key('');
            try {
                Object.keys(localStorage)
                    .filter((k) => k.startsWith(this.PREFIX) && !(staleOnly && k.startsWith(mine)))
                    .forEach((k) => localStorage.removeItem(k));
            } catch {}
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
            } catch {
                try { localStorage.removeItem(this.key(k)); } catch {}
                return null;
            }
        },

        set(k, v, ttl) {
            const write = () => localStorage.setItem(this.key(k), JSON.stringify({ v, ts: Date.now(), ttl }));
            try {
                write();
            } catch {
                this.evictCheap();
                try { write(); } catch {}
            }
        },

        // added_on costs a 27 KB fetch to rebuild and never goes stale, so the top-ups go first.
        evictCheap() {
            const keep = this.key('ao:');
            try {
                const mine = Object.keys(localStorage).filter((k) => k.startsWith(this.PREFIX));
                const cheap = mine.filter((k) => !k.startsWith(keep));
                (cheap.length ? cheap : mine).forEach((k) => localStorage.removeItem(k));
            } catch {}
        },
    };

    /* -- formatting -------------------------------------------------------- */

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const fmt = {
        grouped(n) {
            const s = String(Math.round(n));
            if (s.length <= 3) return s;
            return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
        },

        lakh(n) {
            const l = n / 100000;
            if (l >= 100) return '₹' + (l / 100).toFixed(2) + 'Cr';
            return '₹' + l.toFixed(2) + 'L';
        },

        compact(n) {
            if (n >= 100000) return this.lakh(n);
            if (n >= 10000) return '₹' + (n / 1000).toFixed(1) + 'k';
            return '₹' + this.grouped(n);
        },

        rupees(n) { return '₹' + this.grouped(n); },

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

    // Spinny's timestamps are naive IST strings, so the +05:30 offset has to be stated explicitly.
    function parseIst(s) {
        if (!s) return null;
        const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + '+05:30');
        return isFinite(t) ? t : null;
    }

    function daysSince(iso) {
        const t = parseIst(iso);
        if (t === null) return null;
        // floor here, ceil in daysUntil: a car added four hours ago was listed today, not yesterday.
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
                    (value) => { release(); job.resolve(value); },
                    (err) => { release(); job.reject(err); }
                );
            }
        },
    };

    function httpGet(url) {
        return fetch(url, { credentials: 'omit' }).then((r) => {
            if (!r.ok) {
                const e = new Error('HTTP ' + r.status);
                e.status = r.status;
                throw e;
            }
            return r.json();
        });
    }

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

    /* -- the top-up -------------------------------------------------------- */

    const topUp = {
        queue: new Map(),
        timer: null,

        get(id) {
            const cached = store.get('tu:' + id);
            if (cached) return Promise.resolve(cached.miss ? null : cached);

            return new Promise((resolve) => {
                if (!this.queue.has(id)) this.queue.set(id, []);
                this.queue.get(id).push(resolve);

                if (this.queue.size >= CONFIG.topUpBatchSize) this.flush();
                else if (!this.timer) this.timer = setTimeout(() => this.flush(), CONFIG.topUpBatchWaitMs);
            });
        },

        flush() {
            clearTimeout(this.timer);
            this.timer = null;
            if (!this.queue.size) return;

            const batch = Array.from(this.queue.keys()).slice(0, CONFIG.topUpBatchSize);
            const waiting = new Map();
            for (const id of batch) {
                waiting.set(id, this.queue.get(id));
                this.queue.delete(id);
            }

            const url = CONFIG.topUpApi + '?ids=' + batch.join(',') + '&size=' + batch.length;

            gate.run(() => httpGet(url))
                .then((data) => {
                    const found = new Map();
                    for (const car of (data && data.results) || []) {
                        if (car && car.id) {
                            found.set(String(car.id), car);
                            tap.merge(String(car.id), car);
                        }
                    }

                    for (const id of batch) {
                        const car = found.get(id);
                        const rec = car
                            ? {
                                saved: typeof car.shortlist_count === 'number' ? car.shortlist_count : null,
                                readyOn: car.upcoming ? car.available_on || null : null,
                            }
                            : { miss: true };
                        store.set('tu:' + id, rec, car ? CONFIG.ttl.topUp : CONFIG.ttl.topUpFail);
                        this.settle(waiting.get(id), rec.miss ? null : rec);
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
    };

    /* -- days listed ------------------------------------------------------- */

    function listingAgeOf(id) {
        if (!CONFIG.showAge) return Promise.resolve(null);

        return cachedFetch(
            'ao:' + id,
            () => httpGet(CONFIG.detailApi + encodeURIComponent(id) + '/'),
            (_err, data) => {
                const detail = data && (data.productDetail || data.product_detail || data);
                const added = detail && detail.added_on;
                return added
                    ? { v: { added }, ttl: CONFIG.ttl.addedOn }
                    : { v: { miss: true }, ttl: CONFIG.ttl.addedOnFail };
            }
        ).then((rec) => (rec && rec.added ? daysSince(rec.added) : null));
    }

    /* -- the price --------------------------------------------------------- */

    // One fee line's value is the string "included", so anything non-numeric has to count as zero.
    const numeric = (line) => (line && typeof line.value === 'number' ? line.value : 0);
    const sum = (list) => (Array.isArray(list) ? list.reduce((total, line) => total + numeric(line), 0) : 0);

    const saleLive = (sale) => !!(sale && sale.value > 0 && sale.adjusted_mid_listing_price > 0);

    const HEADLINE_TOLERANCE = 1500;

    // v2 and v3 name different quantities identically - never mix them, and never drop one.
    function modelsOf(car) {
        const out = [];
        if (car.price_breakdown_v3) {
            out.push({
                breakdown: car.price_breakdown_v3,
                sale: car.discount_v3 || car.discount || { value: 0 },
                version: 'v3',
            });
        }
        if (car.price_breakdown_v2) {
            out.push({
                breakdown: car.price_breakdown_v2,
                sale: car.discount || { value: 0 },
                version: 'v2',
            });
        }
        return out;
    }

    function decompose(model) {
        const { breakdown, sale, version } = model;
        if (!breakdown || typeof breakdown.base_listing_price !== 'number') return null;

        const discount = saleLive(sale) ? sale.value : 0;

        return {
            breakdown,
            sale,
            version,
            discount,
            base: breakdown.base_listing_price - discount,
            feesInside: sum(breakdown.base_add_on_data_list),
            mandatory: sum(breakdown.mandatory_paid_add_ons_data_list),
            taxes: sum(breakdown.tax_add_on_data_list),
            gst: numeric(breakdown.gst),
        };
    }

    function priceOf(car, shownOnCard) {
        const parts = modelsOf(car).map(decompose).filter(Boolean);
        if (!parts.length) return null;

        // Both slicings are real: some cards print the inside-only figure, some add mandatory + taxes.
        const options = parts.flatMap((part) => {
            const inside = part.base + part.feesInside;
            return [
                { part, headline: inside },
                { part, headline: inside + part.mandatory + part.taxes },
            ];
        });

        const pick = shownOnCard
            ? options.find((o) => Math.abs(o.headline - shownOnCard) <= HEADLINE_TOLERANCE)
            : options[0];
        if (!pick) return null;

        const { breakdown, sale, version, discount, base, feesInside, mandatory, taxes, gst } = pick.part;
        const headline = pick.headline;

        const allIn = base + feesInside + mandatory + taxes + gst;
        if (!(allIn > 0)) return null;

        const lines = [];
        const addLine = (line, where) => {
            if (!line || !line.display_name) return;
            lines.push({
                label: line.display_name,
                amount: typeof line.value === 'number' ? line.value : null,
                included: line.value === 'included',
                where,
            });
        };
        for (const line of breakdown.base_add_on_data_list || []) addLine(line, 'inside');
        for (const line of breakdown.mandatory_paid_add_ons_data_list || []) addLine(line, 'onTop');
        for (const line of breakdown.tax_add_on_data_list || []) addLine(line, 'onTop');
        addLine(breakdown.gst, 'onTop');

        return {
            base,
            fees: allIn - base,
            allIn,
            headline,
            onTop: allIn - headline,
            struck: saleLive(sale) ? breakdown.listing_price_without_tax : null,
            discount,
            lines,
            version,
            drop: priceDropOf(car),
        };
    }

    function priceDropOf(car) {
        const v2 = car.price_breakdown_v2;
        if (!v2 || v2.is_same_listing_price_update) return null;

        const byTotal = (v2.original_price || 0) - (v2.listing_price_without_gst || 0);
        const byBase = (v2.original_base_listing_price || 0) - (v2.base_listing_price || 0);

        const amount = Math.max(byTotal, byBase);
        if (!(amount >= CONFIG.minPriceDrop)) return null;

        return { amount, previous: v2.original_price || null };
    }

    // The ₹ is optional: the headline renders it as an inline <svg>, so its textContent has none.
    function parsePrice(text) {
        const m = String(text || '').match(/([\d.,]+)\s*(lakh|l|cr|crore)?\b/i);
        if (!m) return null;

        const n = parseFloat(m[1].replace(/,/g, ''));
        if (!isFinite(n) || n <= 0) return null;

        switch ((m[2] || '').toLowerCase()) {
            case 'cr':
            case 'crore':
                return Math.round(n * 10000000);
            case 'l':
            case 'lakh':
                return Math.round(n * 100000);
            default:
                return Math.round(n);
        }
    }

    function shownPriceOf(card) {
        const el = card.querySelector(SEL.price);
        if (el) return parsePrice(el.textContent);

        const money = [];
        for (const n of card.querySelectorAll('span,div,p')) {
            if (n.children.length) continue;
            if (parsePrice(n.textContent)) money.push(n);
        }

        const asking = money.filter((n) => !struckThrough(n));
        const pick = (asking.length ? asking : money).pop();
        return pick ? parsePrice(pick.textContent) : null;
    }

    function struckThrough(el) {
        try {
            const style = window.getComputedStyle && window.getComputedStyle(el);
            return !!style && /line-through/.test(style.textDecorationLine || style.textDecoration || '');
        } catch {
            return false;
        }
    }

    /* -- the line under the card ------------------------------------------- */

    function feeText(p) {
        const inside = p.lines.filter((line) => line.where === 'inside');
        const onTop = p.lines.filter((line) => line.where === 'onTop');

        const itemise = (list) => list
            .map((line) => line.label + ' ' + (line.included ? '(included)' : fmt.rupees(line.amount || 0)))
            .join(', ');

        const tip = [
            'Car ' + fmt.rupees(p.base) + ' + ' + fmt.rupees(p.fees) + ' fees = ' +
                fmt.rupees(p.allIn) + ' all-in.',
            p.onTop > 0
                ? 'The card shows ' + fmt.rupees(p.headline) + ', so ' + fmt.rupees(p.onTop) +
                  ' is still owed on top' + (onTop.length ? ' - ' + itemise(onTop) : '') + '.'
                : '',
            inside.length ? 'Inside the shown price: ' + itemise(inside) + '.' : '',
            p.discount > 0 ? 'Includes a ' + fmt.rupees(p.discount) + ' sale discount.' : '',
        ].filter(Boolean).join('\n');

        return {
            main: fmt.lakh(p.allIn) + ' all-in',
            mid: fmt.compact(p.fees) + ' fees',
            tip,
        };
    }

    function dropSuffix(p) {
        if (!p.drop) return null;
        return {
            label: 'price cut ' + fmt.compact(p.drop.amount),
            tip: 'Spinny has cut the asking price by ' + fmt.rupees(p.drop.amount) +
                (p.drop.previous ? ', down from ' + fmt.rupees(p.drop.previous) : '') +
                '. It cut the car\'s own base price, not the fees, and it shows this nowhere on the ' +
                'site. Read it with how long the car has been listed: on Spinny the cars that get ' +
                'marked down are overwhelmingly the ones that have been sitting.\n' +
                'The date of the cut is not published, so none is claimed here.',
        };
    }

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    function renderLine(card, text, suffix) {
        const host = card.querySelector(SEL.detail);
        if (!host) return false;

        let node = host.querySelector('[' + LINE + ']');
        if (!node) {
            node = document.createElement('div');
            node.setAttribute(LINE, '1');
            node.style.cssText = [
                'position:relative',
                'z-index:3',
                'display:flex',
                'align-items:baseline',
                'gap:6px',
                'margin-top:8px',
                'font-size:12px',
                'line-height:16px',
                'white-space:nowrap',
                'overflow:hidden',
                'cursor:default',
            ].join(';');
            host.appendChild(node);
        }

        const steps = [
            [text.main, text.mid, suffix],
            [text.main, text.mid, null],
            [text.main, null, null],
        ];
        for (const [main, mid, suf] of steps) {
            paint(node, main, mid, suf, text.tip + (suffix && suffix.tip ? '\n\n' + suffix.tip : ''));
            if (node.scrollWidth <= node.clientWidth || !node.clientWidth) break;
        }

        card.setAttribute(MARK, '1');
        return true;
    }

    function paint(node, main, mid, suffix, tip) {
        node.innerHTML =
            '<span style="font-weight:600;color:#2e054e">' + esc(main) + '</span>' +
            (mid ? '<span style="color:#555">&middot; ' + esc(mid) + '</span>' : '') +
            (suffix ? '<span style="color:#1b6b4a;font-weight:600">&middot; ' + esc(suffix.label) + '</span>' : '');
        node.setAttribute('title', tip || '');
    }

    /* -- pills over the photo ---------------------------------------------- */

    const TONE = {
        good: { fg: '#1B6B4A', bg: 'rgba(232,248,240,0.94)' },
        plain: { fg: '#3F4145', bg: 'rgba(255,255,255,0.94)' },
        warn: { fg: '#A33A2B', bg: 'rgba(253,236,233,0.94)' },
    };

    // Priority order: earlier wins a slot when there is not room, and sets the top-to-bottom order.
    const PILLS = ['age', 'km', 'owners', 'ready', 'saved'];

    function pillStack(card) {
        const existing = card.querySelector('[' + PILL_STACK + ']');
        if (existing) return existing;

        const host = card.querySelector(SEL.body) || card;
        const position = getComputedStyle(host).position;
        if (!position || position === 'static') host.style.position = 'relative';

        const stack = document.createElement('div');
        stack.setAttribute(PILL_STACK, '1');
        stack.style.cssText = [
            'position:absolute',
            'top:44px',
            'right:12px',
            'z-index:3',
            'display:flex',
            'flex-direction:column',
            'align-items:flex-end',
            'gap:3px',
            'pointer-events:none',
        ].join(';');
        host.appendChild(stack);
        return stack;
    }

    function addPill(card, name, spec) {
        if (!spec) return;

        const marker = 'data-spce-' + name;
        if (card.querySelector('[' + marker + ']')) return;

        const stack = pillStack(card);
        const rank = PILLS.indexOf(name);

        // Cheap pills arrive first, so making room means evicting a placed pill, not refusing this one.
        if (stack.children.length >= CONFIG.maxPills) {
            const worst = Array.from(stack.children)
                .reduce((w, el) => (Number(el.dataset.rank) > Number(w.dataset.rank) ? el : w));
            if (Number(worst.dataset.rank) <= rank) return;
            worst.remove();
        }

        const pill = document.createElement('div');
        pill.setAttribute(marker, '1');
        pill.dataset.rank = String(rank);
        pill.style.cssText = [
            'order:' + (rank + 1),
            'padding:1px 5px',
            'border-radius:6px',
            'background:' + spec.tone.bg,
            'color:' + spec.tone.fg,
            'font-size:10px',
            'line-height:12px',
            'font-weight:600',
            'text-align:right',
            'white-space:nowrap',
            'box-shadow:0 1px 3px rgba(0,0,0,0.12)',
        ].join(';');
        pill.innerHTML =
            '<span>' + esc(spec.value) + '</span>' +
            (spec.unit ? '<span style="font-weight:400;opacity:0.75">' + esc(spec.unit) + '</span>' : '');

        if (spec.tip) {
            pill.setAttribute('title', spec.tip);
            pill.style.pointerEvents = 'auto';
        }

        stack.appendChild(pill);
    }

    function kmSpec(car) {
        const km = car.mileage;
        const year = car.registration_year || car.make_year;
        if (!km || !year) return null;

        const years = Math.max(1, new Date().getFullYear() - year);
        const perYear = Math.round(km / years);
        if (!isFinite(perYear) || perYear <= 0) return null;

        const ratio = perYear / CONFIG.avgKmPerYear;
        let tone = TONE.plain;
        if (ratio <= 0.75) tone = TONE.good;
        else if (ratio >= 1.4) tone = TONE.warn;

        return {
            value: fmt.grouped(perYear),
            unit: ' km/yr',
            tone,
            tip: fmt.grouped(km) + ' km over ' + years + ' years since registration',
        };
    }

    function ageSpec(days) {
        if (days === null || days < 0) return null;

        const stale = days > CONFIG.staleDays;
        let tone = TONE.plain;
        if (days < CONFIG.freshDays) tone = TONE.good;
        else if (stale) tone = TONE.warn;

        return {
            value: days === 0 ? 'listed today' : 'listed ' + days + 'd',
            tone,
            tip: (days === 0
                ? 'First listed on Spinny today'
                : 'First listed on Spinny ' + days + (days === 1 ? ' day' : ' days') + ' ago') +
                (stale ? ' - it has been sitting a while, so there may be room to negotiate' : ''),
        };
    }

    function savedSpec(saved) {
        if (typeof saved !== 'number' || saved <= 0) return null;
        return {
            value: fmt.grouped(saved),
            unit: ' saved',
            tone: TONE.plain,
            tip: fmt.grouped(saved) + (saved === 1 ? ' person has' : ' people have') +
                ' shortlisted this car. This tracks how long the car has been listed more than it ' +
                'tracks demand, so read it against the days-listed pill rather than on its own.',
        };
    }

    function ownersSpec(car) {
        const n = car.no_of_owners;
        if (typeof n !== 'number' || n <= 1) return null;
        return {
            value: fmt.ordinal(n) + ' owner',
            tone: n >= 3 ? TONE.warn : TONE.plain,
            tip: 'This car has had ' + n + ' registered owners',
        };
    }

    function readySpec(readyOn) {
        if (!readyOn) return null;

        const days = daysUntil(readyOn);
        if (days === null || days < 0) return null;

        return {
            value: 'ready ' + fmt.day(readyOn),
            tone: TONE.plain,
            tip: 'Still in refurbishment - available from ' + fmt.day(readyOn) +
                (days <= 0 ? '' : ', about ' + days + (days === 1 ? ' day' : ' days') + ' away'),
        };
    }

    /* -- per card ---------------------------------------------------------- */

    function idOf(card) {
        const heart = card.querySelector(SEL.heart);
        if (heart && heart.dataset && /^\d{5,}$/.test(heart.dataset.label || '')) return heart.dataset.label;

        const link = card.querySelector(SEL.link);
        const href = link ? link.getAttribute('href') || '' : '';
        const m = href.match(/\/(\d{5,})\/?(?:[?#]|$)/);
        return m ? m[1] : null;
    }

    const enriched = new WeakSet();
    const toppedUp = new WeakSet();

    function carFor(card) {
        return tap.get(idOf(card)) || fiber.get(card.closest(SEL.cell) || card);
    }

    const skip = (car) => car.sold || car.booked || car.soft_unpublish;

    const carRequested = new Set();

    // Third data source, and the one that makes the script independent of timing. If neither
    // the tap nor React's fiber can produce the car, ask for it by id: the batched top-up
    // folds everything it fetches back into the tap, so the next sweep enriches the card the
    // ordinary way. The tap only sees requests made after it is installed, and a userscript
    // manager cannot always guarantee that it wins that race - without this, losing the race
    // once means the page is never enriched at all.
    function requestCar(id) {
        if (!id || carRequested.has(id)) return;
        carRequested.add(id);
        topUp.get(id).catch(() => {});
    }

    // Everything here is already in the tapped payload, so it costs no request and runs as
    // soon as the card exists rather than waiting for the card to be looked at. Returns
    // whether the car was resolved, so the caller can go and fetch it if it was not.
    function enrichCard(card) {
        const id = idOf(card);
        if (!id) return true;  // Not a card we can key; nothing to fetch either.

        const car = carFor(card);
        if (!car) return false;
        enriched.add(card);
        if (skip(car)) return true;

        addPill(card, 'km', kmSpec(car));
        addPill(card, 'owners', ownersSpec(car));

        const p = priceOf(car, shownPriceOf(card));
        if (!p) {
            LOG(id, car.make, car.model, '-> price not decomposable, leaving the card alone');
            return true;
        }

        renderLine(card, feeText(p), dropSuffix(p));
        return true;
    }

    // These two cost a request each, so they wait until the card is near the viewport.
    function topUpCard(card) {
        const id = idOf(card);
        if (!id) return;

        const car = carFor(card);
        if (!car) return;
        toppedUp.add(card);
        if (skip(car)) return;

        listingAgeOf(id).then((days) => addPill(card, 'age', ageSpec(days))).catch(() => {});

        topUp.get(id).then((extras) => {
            if (!extras) return;
            addPill(card, 'saved', savedSpec(extras.saved));
            addPill(card, 'ready', readySpec(extras.readyOn));
        }).catch(() => {});
    }

    /* -- discovery --------------------------------------------------------- */

    // An IntersectionObserver is the wrong primitive for this grid. Spinny mounts cards
    // lazily - on a filtered page they can appear twenty seconds in, at zero height - and
    // the observer's first callback then reports every one of them as not intersecting.
    // Nothing calls it again, so the whole page stays unenriched. A plain sweep over the
    // cards that exist right now, re-run on anything that could have changed them, cannot
    // get wedged that way.
    const nearViewport = (card) => {
        const r = card.getBoundingClientRect();
        if (!r.width && !r.height) return false;
        const margin = CONFIG.viewportMargin;
        return r.bottom > -margin && r.top < (window.innerHeight || 0) + margin;
    };

    // Each card is isolated. One card that throws - an unfamiliar payload, a node React is
    // midway through replacing - must never take the rest of the page with it, and must not
    // be retried forever either, or every sweep dies at the same card.
    function sweepCard(card) {
        try {
            if (!enriched.has(card) && !enrichCard(card)) requestCar(idOf(card));
            if (!toppedUp.has(card) && nearViewport(card)) topUpCard(card);
        } catch (e) {
            enriched.add(card);
            toppedUp.add(card);
            LOG('card threw, skipping it', e);
        }
    }

    function scan() {
        if (document.hidden) return;
        document.querySelectorAll(SEL.card).forEach(sweepCard);
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

    function onMutation(records) {
        for (const r of records) {
            const t = r.target;
            if (t && t.closest && t.closest('[' + PILL_STACK + '],[' + LINE + ']')) continue;
            scanSoon();
            return;
        }
    }

    // Order matters: every trigger is registered before the first sweep runs. Sweeping first
    // would mean a throw in that sweep silently costs us the observer, the listeners and the
    // backstop timer - one bad card at load, and the script is dead for the whole session.
    function start() {
        try { store.drop(true); } catch (_) {}

        new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true });

        // Scrolling is what brings a card into range, so it drives the sweep directly
        // rather than being inferred from a mutation.
        window.addEventListener('scroll', scanSoon, { passive: true });
        window.addEventListener('resize', scanSoon, { passive: true });
        window.addEventListener('popstate', scanSoon);
        document.addEventListener('visibilitychange', scanSoon);

        // The events above cover everything observed, but they are still a model of how
        // Spinny behaves, and this page has already broken one such model. The sweep is a
        // WeakSet check per card, so running it unconditionally costs nothing and removes
        // the need for the model to be complete.
        setInterval(scan, CONFIG.sweepMs);

        for (const m of ['pushState', 'replaceState']) {
            const orig = history[m];
            history[m] = function (...args) {
                const r = orig.apply(this, args);
                scanSoon();
                return r;
            };
        }

        scan();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // Support hook. This script has now failed twice for reasons invisible from the outside -
    // a wedged observer, then a suspected lost race for the network tap - and both times the
    // only way to tell "not running" from "running but finding nothing" was to guess. Run
    // spinnyEnricher.status() in the console and it says which.
    window.spinnyEnricher = {
        version: '1.2.1',
        status() {
            const cards = document.querySelectorAll(SEL.card);
            const withLine = document.querySelectorAll('[' + LINE + ']').length;
            return {
                running: true,
                cardsOnPage: cards.length,
                cardsWithPriceLine: withLine,
                carsFromTap: tap.cars.size,
                tapInstalled: !!XMLHttpRequest.prototype[MARK] && !!window.fetch[MARK],
                promoCssInjected: !!document.getElementById('spce-css'),
                idOfFirstCard: cards[0] ? idOf(cards[0]) : null,
                firstCardHasData: cards[0] ? !!carFor(cards[0]) : null,
                pageHidden: document.hidden,
            };
        },
        rescan: scan,
        CONFIG,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            fmt, parsePrice, parseIst, daysSince, daysUntil, priceOf, priceDropOf, modelsOf, decompose,
            feeText, dropSuffix, kmSpec, ageSpec, savedSpec, ownersSpec, readySpec, CONFIG,
        };
    }
})();
