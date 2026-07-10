// ==UserScript==
// @name         OG Expedition Position Tracker
// @namespace    http://tampermonkey.net/
// @version      1.0.0-rc1
// @description  Tracks visited expedition positions (galaxy:system) per server day and suggests the n closest unvisited systems in the fleet dispatch view. n is bound to your Astrophysics expedition slots.
// @author       Wired
// @license      MIT
// @match        https://*.ogame.gameforge.com/game/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------- Configuration -------------------------
    const STORAGE_KEY   = 'expeditionVisited';   // { updDate: 'YYYY-MM-DD', visited: ['g:s', ...] }
    const MAX_SYSTEM    = 499;                   // systems per galaxy on your universe
    const DONUT_SYSTEM  = true;                  // circular system distance (donut universe)
    const DEFAULT_N     = 4;                     // fallback ONLY if slot detection fails

    // ------------------------- Date helpers --------------------------
    // Aligned with OGame SERVER time, read from the page's own meta tags:
    //   <meta name="ogame-timestamp" content="1751630000">   (unix seconds at page load)
    //   <meta name="ogame-timezone-offset" content="+02:00"> (server timezone)
    // This is the same source the on-page clock uses, so the daily reset
    // happens at server midnight, not local midnight.
    const pageLoadedAt = Date.now();

    function metaContent(name) {
        const el = document.querySelector(`meta[name="${name}"]`);
        return el ? el.getAttribute('content') : null;
    }

    function parseTzOffsetMs(str) { // "+02:00" -> milliseconds
        const m = /^([+-])(\d{2}):(\d{2})$/.exec((str || '').trim());
        if (!m) return null;
        const sign = m[1] === '-' ? -1 : 1;
        return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 60000;
    }

    function serverNowMs() {
        const ts = parseInt(metaContent('ogame-timestamp'), 10);
        if (!Number.isInteger(ts)) return null;
        // Server timestamp at page load + time elapsed since load.
        return ts * 1000 + (Date.now() - pageLoadedAt);
    }

    // Current SERVER date as YYYY-MM-DD. Comparing strings works because
    // the format is lexicographically sortable.
    function currDate() {
        const p = (x) => String(x).padStart(2, '0');
        const now = serverNowMs();
        const tz  = parseTzOffsetMs(metaContent('ogame-timezone-offset'));
        if (now !== null && tz !== null) {
            // Shift the UTC epoch by the server offset, then read UTC fields:
            // that yields the server's wall-clock date.
            const d = new Date(now + tz);
            return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
        }
        // Fallback: local time (close to server time on FR servers anyway).
        const d = new Date();
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    // ------------------------- Storage -------------------------------
    function loadStore() {
        let store = GM_getValue(STORAGE_KEY, null);
        if (typeof store === 'string') {
            try { store = JSON.parse(store); } catch (e) { store = null; }
        }
        if (!store || !store.updDate || !Array.isArray(store.visited)) {
            store = { updDate: currDate(), visited: [] };
            saveStore(store);
            return store;
        }
        // Daily reset: if today is later than the stored update date, wipe.
        if (currDate() > store.updDate) {
            store = { updDate: currDate(), visited: [] };
            saveStore(store);
        }
        return store;
    }

    function saveStore(store) {
        GM_setValue(STORAGE_KEY, JSON.stringify(store));
    }

    // ------------------- Expedition slots (Astrophysics) -------------
    // Max simultaneous expeditions in OGame = floor(sqrt(Astrophysics level))
    // (+ Discoverer class / premium bonuses). Rather than fetching the
    // research page, we read the value the game itself computed:
    //   1) the fleetDispatcher JS object, queried through the injected
    //      page-context bridge (see PAGE_CODE below) — no unsafeWindow;
    //   2) the "Expéditions a/b" slots display in the DOM as fallback.
    //
    // Bridge mechanics: dispatchEvent() runs listeners SYNCHRONOUSLY, and
    // the DOM is shared between the sandbox and the page. So we fire a
    // request event, the page-side listener writes the answer into
    // document.documentElement.dataset, and we read it back immediately.
    function getExpeditionSlots() { // -> { used, max } | null
        try {
            document.dispatchEvent(new CustomEvent('expoTracker:requestSlots'));
            const raw = document.documentElement.dataset.expoSlots;
            if (raw) {
                const o = JSON.parse(raw);
                if (o && Number.isInteger(o.max) && o.max > 0) {
                    return { used: Number.isInteger(o.used) ? o.used : 0, max: o.max };
                }
            }
        } catch (e) { /* fall through to DOM parsing */ }

        // DOM fallback: find the slots line mentioning expeditions.
        const candidates = document.querySelectorAll('#slots, #slots div, .fleetStatus, #fleetStatus, .fleetSlots');
        for (const el of candidates) {
            const txt = (el.textContent || '');
            if (/xp[ée]dition/i.test(txt)) {
                const m = /(\d+)\s*\/\s*(\d+)/.exec(txt.replace(/\s+/g, ' '));
                if (m) return { used: parseInt(m[1], 10), max: parseInt(m[2], 10) };
            }
        }
        return null;
    }

    // n is strictly bound to the Astrophysics-derived expedition slots.
    // When detection fails, fall back to DEFAULT_N and flag it.
    function getN() { // -> { n, detected, slots }
        const slots = getExpeditionSlots();
        if (slots && slots.max > 0) return { n: slots.max, detected: true, slots };
        return { n: DEFAULT_N, detected: false, slots: null };
    }

    function markVisited(galaxy, system) {
        const store = loadStore(); // loadStore handles the daily reset
        const key = `${galaxy}:${system}`;
        if (!store.visited.includes(key)) {
            store.visited.push(key);
            saveStore(store);
        }
    }

    function isVisited(store, galaxy, system) {
        return store.visited.includes(`${galaxy}:${system}`);
    }

    // ------------------------- Distance ------------------------------
    function systemDistance(a, b) {
        const diff = Math.abs(a - b);
        return DONUT_SYSTEM ? Math.min(diff, MAX_SYSTEM - diff) : diff;
    }

    // Returns up to n closest unvisited systems in the same galaxy,
    // sorted by distance from `fromSystem` (the target you typed in).
    function closestUnvisited(galaxy, fromSystem, n) {
        const store = loadStore();
        const results = [];
        for (let s = 1; s <= MAX_SYSTEM; s++) {
            if (isVisited(store, galaxy, s)) continue;
            results.push({ system: s, dist: systemDistance(fromSystem, s) });
        }
        results.sort((a, b) => a.dist - b.dist || a.system - b.system);
        return results.slice(0, n);
    }

    // ------------------------- UI ------------------------------------
    function getCoordInputs() {
        return {
            galaxy:   document.querySelector('#galaxy'),
            system:   document.querySelector('#system'),
            position: document.querySelector('#position'),
        };
    }

    // Origin ("Lieu de départ") coordinates, parsed from the departure box:
    //   <td id="start"> ... <div class="coords">Coordonnées: <span>2:436:8</span></div>
    // Distances (d=) must be relative to THIS position, not to the target inputs.
    function getStartCoords() { // -> { g, s, p } | null
        const el = document.querySelector('#start .coords') ||
                   document.querySelector('td#start .coords');
        if (!el) return null;
        const m = /(\d+)\s*:\s*(\d+)\s*:\s*(\d+)/.exec(el.textContent || '');
        if (!m) return null;
        return {
            g: parseInt(m[1], 10),
            s: parseInt(m[2], 10),
            p: parseInt(m[3], 10),
        };
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'expoTrackerPanel';
        panel.style.cssText = [
            'clear:both', 'display:block', 'margin:10px auto 6px',
            'padding:8px 10px', 'max-width:420px', 'box-sizing:border-box',
            'border:1px solid #4a6f8a', 'border-radius:4px',
            'background:rgba(0,0,0,0.35)', 'color:#9fc5e8',
            'font-size:11px', 'line-height:1.6', 'text-align:left',
        ].join(';');

        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap;">
                <b style="color:#fff;">Expedition tracker</b>
                <span id="expoTrackerNBadge"
                      title="Number of suggestions = your expedition slots, derived from Astrophysics"
                      style="margin-left:auto;padding:1px 8px;border:1px solid #4a6f8a;border-radius:10px;color:#fff;">
                    n = ?
                </span>
            </div>
            <div id="expoTrackerNInfo" style="opacity:0.75;font-style:italic;"></div>
            <div id="expoTrackerWarning" style="display:none;color:#ffb84d;margin:2px 0;"></div>
            <div id="expoTrackerVisitedCount"></div>
            <div id="expoTrackerSuggestions"></div>
        `;
        return panel;
    }

    function refreshPanel() {
        const panel = document.querySelector('#expoTrackerPanel');
        if (!panel) return;

        const { galaxy, system } = getCoordInputs();
        if (!galaxy || !system) return;

        const g = parseInt(galaxy.value, 10);
        const s = parseInt(system.value, 10);
        const store = loadStore();
        const { n, detected, slots } = getN();

        // n badge + short explanation, bound to Astrophysics expedition slots.
        const badge = panel.querySelector('#expoTrackerNBadge');
        if (badge) badge.textContent = `n = ${n}`;
        const info = panel.querySelector('#expoTrackerNInfo');
        if (info) {
            info.textContent = detected
                ? `n follows your expedition slots (from Astrophysics): ${slots.used}/${slots.max} in flight.`
                : `n should follow your Astrophysics expedition slots.`;
        }

        // Warning when the slot count could not be detected.
        const warn = panel.querySelector('#expoTrackerWarning');
        if (warn) {
            if (!detected) {
                warn.style.display = 'block';
                warn.textContent = `\u26A0 Expedition slots (Astrophysics) not detected — falling back to n = ${DEFAULT_N}.`;
            } else {
                warn.style.display = 'none';
                warn.textContent = '';
            }
        }

        const inGalaxy = store.visited.filter(v => v.startsWith(`${g}:`)).length;
        const countEl = panel.querySelector('#expoTrackerVisitedCount');
        countEl.textContent = `Visited today in G${g}: ${inGalaxy} system(s) — resets at server midnight (${store.updDate})`;
        countEl.style.cssText = 'opacity:0.85;';

        const box = panel.querySelector('#expoTrackerSuggestions');
        box.innerHTML = '';

        if (!Number.isInteger(g) || !Number.isInteger(s)) {
            box.textContent = 'Enter valid coordinates.';
            return;
        }

        // Reference for d=: the DEPARTURE planet, not the target inputs.
        // If the origin is in another galaxy (or unparseable), fall back to
        // the target system so suggestions keep working.
        const start = getStartCoords();
        const useStart = !!(start && start.g === g);
        const refSystem = useStart ? start.s : s;

        const suggestions = closestUnvisited(g, refSystem, n);
        if (suggestions.length === 0) {
            box.textContent = 'No unvisited systems left in this galaxy today!';
            return;
        }

        const label = document.createElement('div');
        label.textContent = useStart
            ? `Closest unvisited (d from start ${start.g}:${start.s}):`
            : 'Closest unvisited (d from target — start position not detected):';
        label.style.cssText = 'margin-top:4px;color:#fff;';
        box.appendChild(label);

        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;';
        box.appendChild(chips);

        suggestions.forEach((sug) => {
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = `${g}:${sug.system}:16 (d=${sug.dist})`;
            a.style.cssText = [
                'display:inline-block', 'padding:2px 7px',
                'border:1px solid #3f6f3f', 'border-radius:3px',
                'background:rgba(0,40,0,0.4)', 'color:#7fd17f',
                'text-decoration:none', 'cursor:pointer', 'white-space:nowrap',
            ].join(';');
            a.title = 'Click to fill coordinates';
            a.addEventListener('click', (e) => {
                e.preventDefault();
                setCoords(g, sug.system, 16);
            });
            chips.appendChild(a);
        });
    }

    function setCoords(g, s, p) {
        const inputs = getCoordInputs();
        // Exactly ONE 'change' event per field per click — no input/blur/
        // focus extras, which left OGame's mission options greyed out.
        // The value is only written when it differs; fields are never
        // cleared or rewritten needlessly.
        const set = (el, val) => {
            if (!el) return;
            if (String(el.value) !== String(val)) el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(inputs.galaxy, g);
        set(inputs.system, s);
        set(inputs.position, p);

        // Belt and braces: ask OGame's fleetDispatcher (via the injected
        // page-context bridge) to re-read the target inputs and recompute
        // the available missions, exactly as it does after a manual edit.
        try {
            document.dispatchEvent(new CustomEvent('expoTracker:updateTarget'));
        } catch (e) { /* ignore */ }

        setTimeout(refreshPanel, 100);
    }

    // ------------------------- Send hook -----------------------------
    // A system is marked visited only when the SERVER confirms the fleet
    // send (successful AJAX response), not on the button click. The click
    // is still observed, but only to snapshot coordinates as fallback data
    // and to keep the old behavior alive if the page bridge can't install.
    let pendingSend = null; // { g, s, p, ts } snapshotted at click time

    // The page script sets this dataset flag once its XHR hook is live.
    function ajaxHookActive() {
        return document.documentElement.dataset.expoAjaxHooked === '1';
    }

    function hookSendButton() {
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('#sendFleet, #sendall, .send_all, [id^="continueToFleet3"]');
            if (!btn) return;
            const { galaxy, system, position } = getCoordInputs();
            if (!galaxy || !system || !position) return;

            const g = parseInt(galaxy.value, 10);
            const s = parseInt(system.value, 10);
            const p = parseInt(position.value, 10);
            if (!Number.isInteger(g) || !Number.isInteger(s)) return;

            pendingSend = { g, s, p, ts: Date.now() };

            // Fallback: if the page bridge could not be installed (e.g. a
            // strict CSP blocked the injected script), keep the old
            // click-based behavior so tracking never silently dies.
            if (!ajaxHookActive() && p === 16) {
                markVisited(g, s);
            }
        }, true); // capture phase so we run even if OGame stops propagation
    }

    function handleConfirmedSend(params) {
        let g = null, s = null, p = null, m = null;
        if (params) ({ g, s, p, m } = params);
        // If the request body couldn't be parsed, fall back to the coords
        // snapshotted at click time (only if that click was recent).
        if ((!Number.isInteger(g) || !Number.isInteger(s)) &&
            pendingSend && Date.now() - pendingSend.ts < 30000) {
            ({ g, s, p } = pendingSend);
        }
        pendingSend = null;

        const isExpedition = (m === 15) || (p === 16); // mission 15 = expedition
        if (isExpedition && Number.isInteger(g) && Number.isInteger(s)) {
            markVisited(g, s);
            setTimeout(refreshPanel, 100); // no-op if the panel isn't there
        }
    }

    // --- Page-context bridge -----------------------------------------
    // Everything that needs the PAGE's JavaScript world (fleetDispatcher,
    // the real XMLHttpRequest/fetch that OGame uses) runs in this injected
    // script instead of via unsafeWindow. Communication back to the
    // sandbox: CustomEvents (with string details) and dataset attributes
    // on <html>, both of which cross the sandbox/page boundary.
    //
    // OGame's fleet page POSTs to ...component=fleetdispatch&action=sendFleet
    // (via jQuery/XHR) with a URL-encoded body containing galaxy, system,
    // position and mission, and answers JSON like {"success":true,...}.
    const PAGE_CODE = `(function () {
        'use strict';
        var DS = document.documentElement.dataset;

        // --- expedition slots, answered synchronously via dataset ---
        document.addEventListener('expoTracker:requestSlots', function () {
            try {
                var fd = window.fleetDispatcher;
                if (fd && Number.isInteger(fd.maxExpeditionCount) && fd.maxExpeditionCount > 0) {
                    DS.expoSlots = JSON.stringify({
                        used: Number.isInteger(fd.expeditionCount) ? fd.expeditionCount : 0,
                        max:  fd.maxExpeditionCount
                    });
                } else {
                    delete DS.expoSlots;
                }
            } catch (e) { delete DS.expoSlots; }
        });

        // --- target refresh after a suggestion-chip click ---
        document.addEventListener('expoTracker:updateTarget', function () {
            try {
                var fd = window.fleetDispatcher;
                if (!fd) return;
                if (typeof fd.updateTarget === 'function')  fd.updateTarget();
                if (typeof fd.refreshTarget === 'function') fd.refreshTarget();
                if (typeof fd.refresh === 'function')       fd.refresh();
            } catch (e) { /* ignore */ }
        });

        // --- confirm fleet sends via the server's AJAX response ---
        function isSendFleetUrl(url) {
            return typeof url === 'string' &&
                   /component=fleetdispatch/i.test(url) &&
                   /action=sendfleet/i.test(url);
        }
        function parseSendParams(body) { // -> { g, s, p, m } | null
            try {
                var qs = null;
                if (typeof body === 'string') qs = new URLSearchParams(body);
                else if (body && typeof body.get === 'function') qs = body; // FormData / URLSearchParams
                if (!qs) return null;
                var g = parseInt(qs.get('galaxy'),   10);
                var s = parseInt(qs.get('system'),   10);
                var p = parseInt(qs.get('position'), 10);
                var m = parseInt(qs.get('mission'),  10);
                if (Number.isInteger(g) && Number.isInteger(s)) return { g: g, s: s, p: p, m: m };
            } catch (e) { /* ignore */ }
            return null;
        }
        function responseIndicatesSuccess(text) {
            try {
                var r = JSON.parse(text);
                return !!r && (r.success === true || r.success === 'true' || r.success === 1);
            } catch (e) { return false; } // non-JSON answer: don't assume success
        }
        function confirmed(params) {
            document.dispatchEvent(new CustomEvent('expoTracker:sendConfirmed', {
                detail: JSON.stringify(params || null) // strings cross worlds safely
            }));
        }

        // XMLHttpRequest (what OGame's jQuery uses)
        try {
            var origOpen = XMLHttpRequest.prototype.open;
            var origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url) {
                this.__expoTrackerUrl = url;
                return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function (body) {
                var self = this;
                if (isSendFleetUrl(this.__expoTrackerUrl)) {
                    var params = parseSendParams(body);
                    this.addEventListener('load', function () {
                        if (self.status >= 200 && self.status < 300 &&
                            responseIndicatesSuccess(self.responseText)) {
                            confirmed(params);
                        }
                    });
                }
                return origSend.apply(this, arguments);
            };
            DS.expoAjaxHooked = '1'; // tell the sandbox the hook is live
        } catch (e) { /* sandbox keeps its click fallback */ }

        // fetch (future-proofing, in case OGame switches away from XHR)
        try {
            var origFetch = window.fetch;
            if (typeof origFetch === 'function') {
                window.fetch = function (input, init) {
                    var url = (typeof input === 'string') ? input : (input && input.url);
                    var params = isSendFleetUrl(url)
                        ? parseSendParams(init && init.body) : null;
                    var promise = origFetch.apply(this, arguments);
                    if (isSendFleetUrl(url)) {
                        promise.then(function (res) {
                            res.clone().text().then(function (t) {
                                if (res.ok && responseIndicatesSuccess(t)) confirmed(params);
                            }).catch(function () {});
                        }).catch(function () {});
                    }
                    return promise;
                };
            }
        } catch (e) { /* ignore */ }
    })();`;

    function injectPageScript() {
        try {
            const el = document.createElement('script');
            el.textContent = PAGE_CODE;
            (document.head || document.documentElement).appendChild(el);
            el.remove(); // the code has already executed
        } catch (e) { /* CSP blocked it: click fallback stays active */ }

        // Sandbox-side listener for confirmations coming from the page.
        document.addEventListener('expoTracker:sendConfirmed', (e) => {
            let params = null;
            try { params = JSON.parse(e.detail); } catch (err) { /* ignore */ }
            handleConfirmedSend(params);
        });
    }

    // ------------------------- Init ----------------------------------
    function initFleetDispatch() {
        const inputs = getCoordInputs();
        if (!inputs.galaxy || !inputs.system) return; // not the send-fleet view

        // Place the panel AFTER the coordinates table (table#mission inside
        // #fleetboxdestination) so it doesn't overlap the coordinate inputs.
        const missionTable = document.querySelector('#fleetboxdestination table#mission') ||
                             document.querySelector('table#mission');
        const anchor = missionTable ||
                       document.querySelector('#coords') ||
                       inputs.galaxy.closest('div') ||
                       document.querySelector('#fleetdispatchcomponent');
        if (anchor && !document.querySelector('#expoTrackerPanel')) {
            const panel = buildPanel();
            anchor.parentNode.insertBefore(panel, anchor.nextSibling);

            // fleetDispatcher may finish initializing after us; refresh again
            // so the Astrophysics-bound n picks it up once it's available.
            setTimeout(refreshPanel, 1500);
            setTimeout(refreshPanel, 4000);

            ['input', 'change'].forEach(evt => {
                inputs.galaxy.addEventListener(evt, refreshPanel);
                inputs.system.addEventListener(evt, refreshPanel);
            });

            refreshPanel();
        }
    }

    function main() {
        loadStore();            // triggers the daily-reset check on every page load
        injectPageScript();     // page-context bridge: slots + AJAX confirmation
        hookSendButton();       // coordinate snapshot + fallback

        const isFleetPage = /component=fleetdispatch/.test(location.href);
        if (isFleetPage) {
            // The fleet UI can render after DOMContentLoaded; poll briefly.
            let tries = 0;
            const t = setInterval(() => {
                initFleetDispatch();
                if (document.querySelector('#expoTrackerPanel') || ++tries > 20) clearInterval(t);
            }, 500);
        }
    }

    main();
})();

