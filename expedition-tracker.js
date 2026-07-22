// ==UserScript==
// @name         OG Expedition Position Tracker
// @namespace    http://tampermonkey.net/
// @version      1.0.0-rc2
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
    const STORAGE_KEY   = 'expeditionVisited';   // { updDate: 'YYYY-MM-DD', visited: ['g:s:visitedCount', ...] }
    const MAX_SYSTEM    = 499;                   // systems per galaxy on your universe
    const DONUT_SYSTEM  = true;                  // circular system distance (donut universe)
    const DEFAULT_N     = 4;                     // fallback ONLY if slot detection fails
    const MAX_VISITS    = 10;                    // maximum visits allowed before position exhaustion

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
    // visited is an array of 'g:s:visitedCount' strings, e.g. '5:244:3'.
    // Legacy 'g:s' entries (no count) are accepted and mean count = 1.
    function loadStore() {
        let store = GM_getValue(STORAGE_KEY, null);
        if (typeof store === 'string') {
            try { store = JSON.parse(store); } catch (e) { store = null; }
        }
        // Migration from the interim dict format:
        // { 'g:s': { count, last } }  ->  ['g:s:count', ...]
        if (store && store.visited && !Array.isArray(store.visited) &&
            typeof store.visited === 'object') {
            store.visited = Object.keys(store.visited).map((key) => {
                const c = (store.visited[key] && store.visited[key].count) || 1;
                return `${key}:${c}`;
            });
            saveStore(store);
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
        // Entries are stored as "g:s:visitedCount" strings, e.g. "5:244:3".
        // Anchored regex: matches this exact g:s, with an optional ":count"
        // suffix captured in group 1. The anchors matter: without them,
        // "5:24" would also match "5:244".
        const re = new RegExp(`^${galaxy}:${system}(?::(\\d+))?$`);

        // Regex-based replacement for the old `store.visited.includes(key)`:
        const idx = store.visited.findIndex(entry => re.test(entry));

        if (idx === -1) {
            // Not visited yet today: create the entry with count = 1.
            store.visited.push(`${galaxy}:${system}:1`);
        } else {
            // Already visited: parse the current count and add +1.
            // A legacy entry without a count suffix ("g:s") counts as 1.
            const m = re.exec(store.visited[idx]);
            const count = (m && m[1] ? parseInt(m[1], 10) : 1) + 1;
            store.visited[idx] = `${galaxy}:${system}:${count}`;
        }
        saveStore(store);
    }

    function isVisited(store, galaxy, system) {
        // Matches both the legacy format "g:s" and the new "g:s:visitedCount".
        const re = new RegExp(`^${galaxy}:${system}(?::\\d+)?$`);
        return store.visited.some(entry => re.test(entry));
    }

    function getVisitCount(store, galaxy, system) { // -> 0 if never visited today
        const re = new RegExp(`^${galaxy}:${system}(?::(\\d+))?$`);
        for (const entry of store.visited) {
            const m = re.exec(entry);
            if (m) return m[1] ? parseInt(m[1], 10) : 1; // legacy "g:s" counts as 1
        }
        return 0;
    }

    // All positions visited today in this galaxy, sorted by distance
    // from `fromSystem`, with their visit count.
    function visitedInGalaxy(galaxy, fromSystem) {
        const store = loadStore();
        const entryRe = /^(\d+):(\d+)(?::(\d+))?$/; // g : s : optional count
        const results = [];
        for (const entry of store.visited) {
            const m = entryRe.exec(entry);
            if (!m) continue;
            const kg = parseInt(m[1], 10);
            const ks = parseInt(m[2], 10);
            if (kg !== galaxy || !Number.isInteger(ks)) continue;
            results.push({
                system: ks,
                dist: systemDistance(fromSystem, ks),
                count: m[3] ? parseInt(m[3], 10) : 1,
            });
        }
        results.sort((a, b) => a.dist - b.dist || a.system - b.system);
        return results;
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

        const inGalaxy = store.visited
            .filter(entry => entry.startsWith(`${g}:`)).length;
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

        // Shared chip factory. state: 'unvisited' (green, clickable),
        // 'visited' (grayed out, still clickable), 'exhausted' (blacked
        // out, count >= MAX_VISITS, NOT clickable).
        const CHIP_STYLES = {
            unvisited: 'border:1px solid #3f6f3f;background:rgba(0,40,0,0.4);color:#7fd17f;cursor:pointer;',
            visited:   'border:1px solid #555;background:rgba(70,70,70,0.35);color:#9a9a9a;cursor:pointer;opacity:0.75;',
            exhausted: 'border:1px solid #222;background:rgba(0,0,0,0.85);color:#555;cursor:not-allowed;',
        };
        const makeChip = (system, text, title, state) => {
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = text;
            a.style.cssText =
                'display:inline-block;padding:2px 7px;border-radius:3px;' +
                'text-decoration:none;white-space:nowrap;' + CHIP_STYLES[state];
            a.title = title;
            a.addEventListener('click', (e) => {
                e.preventDefault();
                if (state === 'exhausted') return; // blacked out: not clickable
                setCoords(g, system, 16);
            });
            return a;
        };

        const addSection = (labelText) => {
            const label = document.createElement('div');
            label.textContent = labelText;
            label.style.cssText = 'margin-top:4px;color:#fff;';
            box.appendChild(label);
            const chips = document.createElement('div');
            chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;';
            box.appendChild(chips);
            return chips;
        };

        // --- unvisited suggestions (green) ---
        const suggestions = closestUnvisited(g, refSystem, n);
        if (suggestions.length === 0) {
            const none = document.createElement('div');
            none.textContent = 'No unvisited systems left in this galaxy today!';
            box.appendChild(none);
        } else {
            const chips = addSection(useStart
                ? `Closest unvisited (d from start ${start.g}:${start.s}):`
                : 'Closest unvisited (d from target — start position not detected):');
            suggestions.forEach((sug) => {
                chips.appendChild(makeChip(
                    sug.system,
                    `${g}:${sug.system}:16 (d=${sug.dist})`,
                    'Click to fill coordinates',
                    'unvisited'
                ));
            });
        }

        // --- visited today: grayed out with (v: count); positions past
        // --- MAX_VISITS are exhausted and blacked out (not clickable).
        const visited = visitedInGalaxy(g, refSystem);
        if (visited.length > 0) {
            const chips = addSection(`Visited today (${visited.length}):`);
            visited.forEach((v) => {
                const exhausted = v.count >= MAX_VISITS;
                chips.appendChild(makeChip(
                    v.system,
                    `${g}:${v.system}:16 (d=${v.dist}, v: ${v.count})`,
                    exhausted
                        ? `Exhausted: visited ${v.count} times today (>= ${MAX_VISITS})`
                        : `Already visited ${v.count} time(s) today — click to fill anyway`,
                    exhausted ? 'exhausted' : 'visited'
                ));
            });
        }
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
