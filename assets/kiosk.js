// The kiosk: a full-screen wall display built from TILES (see kiosk.php, api/kiosk.php, docs: kiosk-spec.md).
// A tile is a builder returning { el, load(), tick() }: load() fetches its data, tick() runs every 20 s (refetch when due, otherwise re-render
// locally, e.g. countdowns). Each tile owns its error state — it keeps the last data and says so. Add a tile = add a builder to TILES.
(function () {
    'use strict';
    var root = document.getElementById('kiosk');
    if (!root) return;
    var grid = document.getElementById('kioskTiles'), clockEl = document.getElementById('kioskClock'), dateEl = document.getElementById('kioskDate');
    var DA = (navigator.language || '').toLowerCase().indexOf('da') === 0;
    function da(en, dk) { return DA ? dk : en; }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }
    // Line icons (24 x 24, drawn with the text colour): the kiosk uses these instead of words wherever it can.
    var ICONS = {
        bulb: 'M9 18h6M10 21.5h4M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7v1h6v-1c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z',
        bolt: 'M13.5 2 4.5 14h6.5l-1 8 9-12.5h-6.5z',
        flame: 'M12 2.5c.6 3.6 5.5 6 5.5 11.2a5.5 5.5 0 0 1-11 0c0-2.4 1.2-3.7 2.3-5 .3 1.6 1 2.5 1.9 3C10.5 8.6 11 5.5 12 2.5z',
        minus: 'M5 12h14',
        plus: 'M5 12h14M12 5v14',
        close: 'M5 5l14 14M19 5L5 19',
        off: 'M12 3v8.5M7 6.2a8 8 0 1 0 10 0',
        check: 'M4.5 12.5l5 5 10-11'
    };
    function ico(name, cls) { var s = el('span', 'ic' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + ICONS[name] + '"/></svg>'; return s; }
    /** A flat icon-only button (label = tooltip + screen-reader name). */
    function iconBtn(name, label, onClick, cls) {
        var b = el('button', 'k-btn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.appendChild(ico(name));
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

    /** JSON call to api/kiosk.php; throws Error(message) on a non-ok answer. A 401 (token revoked) reloads into the "not signed in" page. */
    function api(query, body) {
        var opts = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
        if (body) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch('api/kiosk.php' + query, opts).then(function (r) {
            if (r.status === 401) { location.reload(); throw new Error('signed out'); }
            return r.json().catch(function () { return {}; }).then(function (j) {
                if (!r.ok || j.ok === false || j.error) throw new Error(j.error || ('HTTP ' + r.status));
                return j;
            });
        });
    }

    var COMPACT = window.matchMedia('(max-width: 700px)');   // phones: a normal scrolling page, no fitting

    /**
     * A tile: title, body, note line. Everything inside the body is sized in em from the body's font-size, which is --k x a viewport unit; refit() starts
     * at maxK and shrinks k until the content no longer overflows the body — so whatever a tile shows always fits the space the grid gave it.
     * Call refit() after every render. A tile may set afterFit (e.g. the price chart draws itself at the size the fit left).
     */
    function tile(title, extraClass, maxK, icon) {
        var t = el('section', 'kiosk-tile ' + (extraClass || ''));
        var head = el('div', 'kiosk-tile-head');
        var ttl = el('div', 'kiosk-tile-title');
        if (icon) ttl.appendChild(ico(icon));
        ttl.appendChild(el('span', '', title));
        head.appendChild(ttl);
        var upd = el('div', 'kiosk-tile-upd');
        head.appendChild(upd);
        t.appendChild(head);
        var body = el('div', 'kiosk-tile-body');
        t.appendChild(body);
        var note = el('div', 'kiosk-note');
        t.appendChild(note);
        var lastTs = 0, staleMs = 0;
        var api_ = {
            el: t, body: body, afterFit: null,
            /** Data of this tile was refreshed just now (ts = ms). Shows "updated 14:32"; it turns amber when older than staleMs (the tile's own rhythm x 3). */
            updated: function (ts, stale) { lastTs = ts || Date.now(); staleMs = stale || 0; api_.updRefresh(); },
            updRefresh: function () {
                if (!lastTs) return;
                var d = new Date(lastTs);
                upd.textContent = da('updated ', 'opdateret ') + pad(d.getHours()) + ':' + pad(d.getMinutes());
                upd.classList.toggle('stale', staleMs > 0 && Date.now() - lastTs > staleMs);
            },
            note: function (msg) { note.textContent = msg || ''; note.hidden = !msg; api_.refit(); },
            refit: function () {
                if (COMPACT.matches) { body.style.removeProperty('--k'); if (api_.afterFit) api_.afterFit(); return; }
                var k = maxK || 2;
                for (var i = 0; i < 30; i++) {
                    body.style.setProperty('--k', k.toFixed(3));
                    if (body.scrollHeight <= body.clientHeight + 1 && body.scrollWidth <= body.clientWidth + 1) break;
                    k *= 0.94;
                    if (k < 0.3) break;
                }
                if (api_.afterFit) api_.afterFit();
            }
        };
        allTiles.push(api_);
        return api_;
    }
    var allTiles = [];

    // ---- Electricity: price now, the cheapest coming stretch of N hours, the bars ahead ----
    function buildPowerTile() {
        var t = tile(da('Electricity', 'Elpris'), 'kiosk-wide', 1.6, 'bolt'), chartCard = null, chartBox = null, lastWin = null, pendingAnim = { appear: true }, selIdx = null, selTimer = null, readout = el('div', 'kp-readout');
        var data = null, loadedAt = 0, loadedHour = -1;
        var windowLen = 3;   // the cheapest stretch is always 3 h (dishwasher / washer length); no selector
        function hourNow() { return Math.floor(Date.now() / 3600000); }   // hour boundaries are the same in UTC and Danish time

        function load() {
            loadedAt = Date.now();
            api('?part=power&window=3&last_hours=36')
                .then(function (j) { data = j; loadedHour = hourNow(); t.updated(Date.now(), 15 * 60000); t.note(''); render(); })
                .catch(function (e) { console.warn('kiosk power:', e); t.note(da('Could not refresh the prices — showing the last ones.', 'Kunne ikke opdatere priserne — viser de sidste.')); render(); });
        }

        /** Cheapest run of n consecutive hours from hour idx on (lowest average all-in price); null if none fits. */
        function bestWindow(hs, idx, n) {
            var best = null;
            for (var i = idx; i + n <= hs.length; i++) {
                var sum = 0, ok = true;
                for (var k = 0; k < n; k++) {
                    if (k > 0 && hs[i + k].ts - hs[i + k - 1].ts !== 3600) { ok = false; break; }
                    sum += +hs[i + k].t;
                }
                if (ok && (best === null || sum / n < best.avg - 1e-9)) best = { from: i, len: n, avg: Math.round(sum / n * 1000) / 1000 };
            }
            if (!best) return null;
            var last = hs[best.from + n - 1];
            best.start = hs[best.from].s; best.start_ts = hs[best.from].ts;
            best.end = pad((parseInt(String(last.s).slice(11, 13), 10) + 1) % 24) + ':00';
            return best;
        }

        function render() {
            t.body.innerHTML = '';
            chartBox = null; chartCard = null;
            if (!data) { t.body.textContent = da('Fetching prices…', 'Henter priser…'); return; }
            var card = data.card, hs = card.hours || [], nowSec = Date.now() / 1000, idx = -1;
            hs.forEach(function (h, i) { if (h.ts <= nowSec && nowSec < h.ts + 3600) idx = i; });   // by timestamp: the device's timezone does not matter
            if (idx < 0) { t.body.textContent = da('Updating…', 'Opdaterer…'); return; }
            card = Object.assign({}, card, { now_index: idx });
            var cur = hs[idx];
            var vals = hs.slice(idx).map(function (h) { return +h.t; });
            var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), f = hi === lo ? 0 : (cur.t - lo) / (hi - lo);
            var tone = f < 0.34 ? 'cheap' : (f < 0.67 ? 'mid' : 'dear');

            var layout = el('div', 'kp-layout'), left = el('div', 'kp-left');
            layout.appendChild(left); t.body.appendChild(layout);

            var now = el('div', 'kp-now');
            now.appendChild(el('span', 'kp-big ' + tone, PowerChart.fmt(cur.t)));
            now.appendChild(el('span', 'kp-unit', 'kr/kWh ' + da('now', 'nu')));
            left.appendChild(now);

            // The cheapest stretch is worked out here from the hourly prices (same rule as the server): so changing 2 h -> 3 h is instant and can animate.
            var w = bestWindow(hs, idx, windowLen), best = el('div', 'kp-best');
            if (w) {
                card.window = w;
                var mins = Math.max(0, Math.round((w.start_ts * 1000 - Date.now()) / 60000));
                var when = mins < 1 ? da('now', 'nu') : (mins < 60 ? da('in ', 'om ') + mins + ' min' : da('in ', 'om ') + Math.floor(mins / 60) + da(' h ', ' t ') + pad(mins % 60) + ' min');
                best.innerHTML = '<div class="kp-best-l">' + esc(da('Cheapest ', 'Billigst ') + w.len + da(' h', ' t')) + '</div>'
                    + '<div class="kp-best-v">' + esc(PowerChart.day(w.start).split(' ')[0] + ' ' + PowerChart.hm(w.start) + '–' + w.end) + '</div>'
                    + '<div class="kp-best-s">' + esc(PowerChart.fmt(w.avg) + ' kr/kWh · ' + when) + '</div>';
            }
            left.appendChild(best);

            chartBox = el('div', 'kp-chart'); chartCard = card;
            // Tap a bar -> its hour, all-in price and the spot part, for a few seconds (kept across the 20 s redraws).
            chartBox.addEventListener('click', function (e) {
                var hit = e.target.closest ? e.target.closest('[data-idx]') : null;
                if (!hit) return;
                selIdx = parseInt(hit.getAttribute('data-idx'), 10);
                clearTimeout(selTimer); selTimer = setTimeout(function () { selIdx = null; t.refit(); }, 12000);
                t.refit();
            });
            layout.appendChild(chartBox);
            if (card.incomplete) t.note(da('⚠ A tariff is missing — the price may be too low.', '⚠ En tarif mangler — prisen kan være for lav.'));
            t.refit();
        }
        /** The cheapest-window rectangle glides (position + width) from the old window to the new one, or fades/grows in the first time. */
        function animateWindow() {
            var win = chartCard.window, rect = chartBox.querySelector('.pw-window'), a = pendingAnim;
            lastWin = win ? { from: win.from, len: win.len } : null;
            if (!rect || !win || !a || !rect.animate) { pendingAnim = null; return; }
            pendingAnim = null;
            var step = rect.getBBox().width / win.len;
            rect.style.transformBox = 'fill-box';
            rect.style.transformOrigin = a.prev ? '0 50%' : '50% 50%';
            var from = a.prev
                ? { transform: 'translateX(' + ((a.prev.from - win.from) * step).toFixed(1) + 'px) scaleX(' + (a.prev.len / win.len).toFixed(4) + ')', opacity: 1 }
                : { transform: 'scale(0.25, 0.6)', opacity: 0 };
            rect.animate([from, { transform: 'none', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.3,.8,.3,1)' });
        }
        // The bars are drawn 1:1 at the size the layout left for them (so labels stay crisp), after every fit and resize.
        t.afterFit = function () {
            if (!chartBox || !chartCard || !chartBox.isConnected) return;
            var w = Math.max(200, chartBox.clientWidth), h = Math.max(90, chartBox.clientHeight);
            chartBox.innerHTML = PowerChart.svg(chartCard, [w, h], parseFloat(getComputedStyle(chartBox).fontSize) || 12, { nowLabel: da('now', 'nu') }).replace('<svg ', '<svg preserveAspectRatio="none" ');
            animateWindow();
            var hs = chartCard.hours || [], sel = selIdx != null ? hs[selIdx] : null;
            if (sel) {
                Array.prototype.forEach.call(chartBox.querySelectorAll('.pw-bar[data-idx="' + selIdx + '"]'), function (b) { b.classList.add('sel'); });
                readout.innerHTML = '<b>' + esc(PowerChart.day(sel.s).split(' ')[0] + ' ' + PowerChart.hm(sel.s)) + '</b> · ' + esc(PowerChart.fmt(sel.t)) + ' kr/kWh'
                    + '<span class="kp-readout-s"> ' + esc(da('of which spot ', 'heraf spot ') + PowerChart.fmt(sel.sp)) + '</span>';
                chartBox.appendChild(readout);
            }
        };

        return {
            el: t.el, load: load,
            // New hour -> refetch (the bars and the "now" price move); otherwise every 5 min; the countdown re-renders locally.
            tick: function () {
                if (!data) { if (Date.now() - loadedAt > 15000) load(); return; }
                if (hourNow() !== loadedHour || Date.now() - loadedAt > 5 * 60000) load(); else render();
            }
        };
    }

    // ---- Lights: one big button per room (tap = all on / all off), brightness − / +, and the room's single lights as chips ----
    function buildLightsTile() {
        var t = tile(da('Lights', 'Lys'), '', 1.5, 'bulb');
        var data = null, loadedAt = 0, busyUntil = 0;
        var STEP = 20;

        function load() {
            loadedAt = Date.now();
            api('?part=lights')
                .then(function (j) { data = j; t.updated(j.cached_at ? j.cached_at * 1000 : Date.now(), 12 * 60000); t.note(j.note || ''); render(); })
                .catch(function (e) { console.warn('kiosk lights:', e); t.note(data ? da('Could not refresh — showing the last state.', 'Kunne ikke opdatere — viser sidste tilstand.') : (e.message || '')); render(); });
        }
        /** Optimistic: change the local state, redraw at once, send; on failure say why and re-read the bridge. */
        function send(body, apply) {
            busyUntil = Date.now() + 8000;
            apply(); render();
            api('', body).then(function () { t.note(''); }).catch(function (e) { t.note(da('The change did not go through: ', 'Ændringen blev ikke gennemført: ') + e.message); busyUntil = 0; load(); });
        }
        function roomOn(r, on) {
            if (r.group_id) {
                send({ action: 'group', id: r.group_id, on: on }, function () { r.on = on; r.lights.forEach(function (l) { l.on = on; }); });
            } else {
                r.lights.forEach(function (l) { api('', { action: 'light', id: l.id, on: on }).catch(function () { load(); }); });
                busyUntil = Date.now() + 8000; r.on = on; r.lights.forEach(function (l) { l.on = on; }); render();
            }
        }
        function roomBri(r, delta) {
            var next = Math.max(5, Math.min(100, (r.brightness == null ? 50 : r.brightness) + delta));
            if (r.group_id) send({ action: 'group', id: r.group_id, on: true, brightness: next }, function () { r.on = true; r.brightness = next; });
            else r.lights.forEach(function (l) { if (l.dim) api('', { action: 'light', id: l.id, on: true, brightness: next }).catch(function () { load(); }); });
        }
        function lightToggle(l) { send({ action: 'light', id: l.id, on: !l.on }, function () { l.on = !l.on; }); }

        /** Press and hold (0.55 s) opens the colour panel; a normal tap still toggles. onTap is skipped when the hold fired. */
        function pressable(node, onTap, onHold) {
            var timer = null, held = false;
            function cancel() { clearTimeout(timer); timer = null; }
            node.addEventListener('pointerdown', function (e) {
                if (e.button > 0) return;
                held = false; cancel();
                timer = setTimeout(function () { held = true; if (navigator.vibrate) { try { navigator.vibrate(30); } catch (x) { /* none */ } } onHold(); }, 550);
            });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { node.addEventListener(ev, cancel); });
            node.addEventListener('contextmenu', function (e) { e.preventDefault(); });
            node.addEventListener('click', function (e) { if (held) { held = false; e.preventDefault(); return; } onTap(); });
        }

        var QUICK = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#00c7be', '#0a84ff', '#7d5cff', '#ff5aa5'];
        var panel = null;
        function closePanel() { if (panel) { panel.remove(); panel = null; } busyUntil = Date.now() + 1500; setTimeout(load, 1500); }
        function hsvHex(h) {   // a fully saturated colour of hue h (0-360)
            var c = 1, x = 1 - Math.abs((h / 60) % 2 - 1), r = 0, g = 0, b = 0;
            if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
            function t(n) { return ('0' + Math.round(n * 255).toString(16)).slice(-2); }
            return '#' + t(r) + t(g) + t(b);
        }
        /**
         * The colour panel for one light or a whole room (the bridge takes colour per light, so a room's choice goes to each of its lights; brightness for a room
         * goes to the room itself). Brightness, quick colours, a hue slider, and whites from warm to cool — only what the lights can do.
         */
        function openPanel(title, lights, group) {
            if (panel) panel.remove();
            panel = el('div', 'kc-back');
            var box = el('div', 'kc-box'); panel.appendChild(box);
            var head = el('div', 'kc-head'); head.appendChild(el('div', 'kc-title', title));
            head.appendChild(iconBtn('close', da('Close', 'Luk'), closePanel, 'kc-x')); box.appendChild(head);
            panel.addEventListener('click', function (e) { if (e.target === panel) closePanel(); });
            function sendAll(body) {
                busyUntil = Date.now() + 8000;
                lights.forEach(function (l) { api('', Object.assign({ action: 'light', id: l.id }, body)).catch(function (e) { t.note(e.message); }); });
            }
            function row(label, node) { var r = el('div', 'kc-row'); r.appendChild(el('div', 'kc-label', label)); r.appendChild(node); box.appendChild(r); }
            var debounce = null;
            function slider(min, max, val, cls, onChange) {
                var i = el('input', 'kc-slider ' + cls); i.type = 'range'; i.min = min; i.max = max; i.value = val;
                i.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(function () { onChange(+i.value); }, 180); });
                return i;
            }
            var dim = lights.some(function (l) { return l.dim; }), col = lights.some(function (l) { return l.color; }), ct = lights.some(function (l) { return l.ct; });
            var cur = lights.filter(function (l) { return l.on && l.brightness != null; })[0];
            if (dim) row(da('Brightness', 'Lysstyrke'), slider(1, 100, cur ? cur.brightness : 60, 'kc-bri', function (v) {
                if (group) api('', { action: 'group', id: group, on: true, brightness: v }).catch(function (e) { t.note(e.message); }); else sendAll({ on: true, brightness: v });
            }));
            if (col) {
                var sw = el('div', 'kc-swatches');
                QUICK.forEach(function (c) {
                    var b = el('button', 'kc-sw'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c);
                    b.addEventListener('click', function () { sendAll({ on: true, color: c }); });
                    sw.appendChild(b);
                });
                row(da('Colour', 'Farve'), sw);
                row(da('Hue', 'Nuance'), slider(0, 359, 200, 'kc-hue', function (v) { sendAll({ on: true, color: hsvHex(v) }); }));
            }
            if (ct) row(da('White', 'Hvid'), slider(153, 500, 330, 'kc-white', function (v) { sendAll({ on: true, mirek: 653 - v }); }));   // left = warm (high mirek), right = cool
            var foot = el('div', 'kc-foot');
            var off = el('button', 'kc-btn'); off.type = 'button'; off.appendChild(ico('off')); off.appendChild(el('span', '', da('Off', 'Sluk'))); off.addEventListener('click', function () { if (group) api('', { action: 'group', id: group, on: false }); else sendAll({ on: false }); closePanel(); });
            var done = el('button', 'kc-btn kc-done'); done.type = 'button'; done.appendChild(ico('check')); done.appendChild(el('span', '', da('Done', 'Færdig'))); done.addEventListener('click', closePanel);
            foot.appendChild(off); foot.appendChild(done); box.appendChild(foot);
            root.appendChild(panel);
        }

        function roomEl(r) {
            var on = r.lights.filter(function (l) { return l.on; }).length;
            var box = el('div', 'kl-room' + (r.on ? ' is-on' : ''));
            // The whole top row is the switch: tap = room on / off, hold = colours.
            var main = el('button', 'kl-main'); main.type = 'button'; main.setAttribute('aria-pressed', r.on ? 'true' : 'false');
            var txt = el('span', 'kl-txt');
            txt.appendChild(el('span', 'kl-name', r.name));
            txt.appendChild(el('span', 'kl-count', r.on ? on + '/' + r.lights.length + (r.brightness != null ? ' · ' + r.brightness + '%' : '') : da('off', 'slukket')));
            main.appendChild(txt);
            pressable(main, function () { roomOn(r, !r.on); }, function () { openPanel(r.name, r.lights, r.group_id); });
            box.appendChild(main);
            var tools = el('div', 'kl-tools');
            if (r.lights.length > 1) {
                r.lights.forEach(function (l) {
                    var c = el('button', 'kl-lamp' + (l.on ? ' on' : '')); c.type = 'button'; c.title = l.name; c.setAttribute('aria-pressed', l.on ? 'true' : 'false');
                    var ic = ico('bulb'); if (l.on && l.hex) ic.style.color = l.hex;
                    c.appendChild(ic); c.appendChild(el('span', 'nm', l.name));
                    pressable(c, function () { lightToggle(l); }, function () { openPanel(l.name, [l], null); });
                    tools.appendChild(c);
                });
            }
            if (r.lights.some(function (l) { return l.dim; })) {
                tools.appendChild(el('span', 'kl-sp'));
                tools.appendChild(iconBtn('minus', da('Dimmer', 'Dæmp'), function () { roomBri(r, -STEP); }));
                tools.appendChild(iconBtn('plus', da('Brighter', 'Lysere'), function () { roomBri(r, STEP); }));
            }
            if (tools.childNodes.length) box.appendChild(tools);
            return box;
        }

        function render() {
            t.body.innerHTML = '';
            if (!data) { t.body.textContent = da('Waking up the lamps…', 'Vækker lamperne…'); return; }
            var rooms = (data.rooms || []).slice();
            if ((data.other || []).length) rooms.push({ name: da('Other', 'Andre'), group_id: null, on: data.other.some(function (l) { return l.on; }), brightness: null, lights: data.other });
            var g = el('div', 'kl-grid');
            rooms.forEach(function (r) { g.appendChild(roomEl(r)); });
            t.body.appendChild(g);
            t.refit();
        }

        return {
            el: t.el, load: load,
            tick: function () { if (Date.now() > busyUntil && Date.now() - loadedAt > 60000) load(); }
        };
    }

    // ---- Thermostats: each valve's temperature now and its target with − / + (sent a moment after the last tap) ----
    function buildThermostatsTile() {
        var t = tile(da('Heating', 'Varme'), '', 1.5, 'flame');
        var rows = null, loadedAt = 0, busyUntil = 0, timers = {};
        function load() {
            loadedAt = Date.now();
            api('?part=thermostats')
                .then(function (j) { rows = j.thermostats || []; t.updated(j.cached_at ? j.cached_at * 1000 : Date.now(), 12 * 60000); t.note(''); render(); })
                .catch(function (e) { console.warn('kiosk thermostats:', e); t.note(rows ? da('Could not refresh — showing the last readings.', 'Kunne ikke opdatere — viser sidste målinger.') : (e.message || '')); render(); });
        }
        var editing = null;   // id of the radiator whose target is being typed
        function setTarget(r, delta) {
            var cur = r.pending != null ? r.pending : r.target_c;
            if (cur == null) return;
            applyTarget(r, cur + delta, 1200);
        }
        /** Show the new target at once and send it after `delay` ms (the − / + taps wait a moment so several taps become one command). */
        function applyTarget(r, value, delay) {
            r.pending = Math.max(5, Math.min(30, Math.round(value * 2) / 2));
            busyUntil = Date.now() + 15000;
            render();
            clearTimeout(timers[r.id]);
            timers[r.id] = setTimeout(function () {
                var want = r.pending;
                api('', { action: 'thermostat', id: r.id, target: want })
                    .then(function () { r.target_c = want; r.pending = null; t.note(''); render(); })
                    .catch(function (e) { r.pending = null; t.note(da('The thermostat did not take that: ', 'Termostaten tog ikke imod det: ') + e.message); render(); });
            }, delay);
        }
        /** Typed entry: "21", "21,5" or "21.5"; anything else is ignored. Half degrees, 5-30. */
        function commitTyped(r, raw) {
            editing = null; busyUntil = 0;
            var v = parseFloat(String(raw).replace(',', '.'));
            if (isNaN(v)) { render(); return; }
            applyTarget(r, v, 150);
        }
        function fmtC(v) { return v == null ? '–' : (Math.round(v * 10) / 10).toLocaleString(DA ? 'da-DK' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

        function render() {
            t.body.innerHTML = '';
            if (!rows) { t.body.textContent = da('Asking the thermostats…', 'Spørger termostaterne…'); return; }
            if (!rows.length) { t.body.textContent = da('No thermostats set up.', 'Ingen termostater sat op.'); return; }
            var g = el('div', 'kt-grid');
            rows.forEach(function (r) {
                var heating = !r.error && r.valve_open_pct > 0;
                var box = el('div', 'kt-box' + (r.error ? ' has-error' : '') + (heating ? ' heating' : ''));
                box.appendChild(el('div', 'kt-name', r.name));
                if (r.error) { box.appendChild(el('div', 'kt-err', da('Not answering', 'Svarer ikke'))); g.appendChild(box); return; }
                var main = el('div', 'kt-main');
                main.appendChild(el('span', 'kt-cur', fmtC(r.current_c) + '°'));
                var sub = [];
                if (r.valve_open_pct != null) sub.push(da('valve ', 'ventil ') + r.valve_open_pct + '%');
                if (r.battery_pct != null && r.battery_pct <= 20) sub.push(da('battery ', 'batteri ') + r.battery_pct + '%');
                main.appendChild(el('span', 'kt-sub', sub.join(' · ')));
                box.appendChild(main);
                var ctl = el('div', 'kt-ctl');
                ctl.appendChild(iconBtn('minus', da('Colder', 'Koldere'), function () { setTarget(r, -0.5); }));
                var shown = r.pending != null ? r.pending : r.target_c;
                if (editing === r.id) {
                    var inp = el('input', 'kt-input'); inp.type = 'text'; inp.setAttribute('inputmode', 'decimal'); inp.setAttribute('aria-label', da('Target temperature', 'Måltemperatur')); inp.value = shown == null ? '' : String(shown).replace('.', DA ? ',' : '.');
                    var done = false;
                    inp.addEventListener('keydown', function (e) {
                        if (e.key === 'Enter') { done = true; commitTyped(r, inp.value); } else if (e.key === 'Escape') { done = true; editing = null; busyUntil = 0; render(); }
                    });
                    inp.addEventListener('blur', function () { if (!done) { done = true; commitTyped(r, inp.value); } });
                    ctl.appendChild(inp);
                    setTimeout(function () { inp.focus(); inp.select(); }, 0);
                } else {
                    var tb = el('button', 'kt-target' + (r.pending != null ? ' pending' : ''), fmtC(shown) + '°'); tb.type = 'button'; tb.title = da('Tap to type a temperature', 'Tryk for at skrive en temperatur');
                    tb.addEventListener('click', function () { editing = r.id; busyUntil = Date.now() + 60000; render(); });
                    ctl.appendChild(tb);
                }
                ctl.appendChild(iconBtn('plus', da('Warmer', 'Varmere'), function () { setTarget(r, 0.5); }));
                box.appendChild(ctl);
                g.appendChild(box);
            });
            t.body.appendChild(g);
            t.refit();
        }

        return {
            el: t.el, load: load,
            tick: function () { if (Date.now() > busyUntil && Date.now() - loadedAt > 5 * 60000) load(); }
        };
    }

    var TILES = [buildPowerTile, buildLightsTile, buildThermostatsTile];
    var tiles = [];

    function tickClock() {
        var d = new Date();
        clockEl.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
        dateEl.textContent = d.toLocaleDateString(DA ? 'da-DK' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    }
    // Light by day, dark after sunset: the look follows the sun (computed here, no network). Location = Copenhagen (DK2); a degree or two changes the
    // time by minutes only. The light / dark looks are the ones chosen in Appearance (data-light / data-dark on #kiosk).
    var LAT = 55.68, LON = 12.57, DUSK_MS = 30 * 60000;   // dark starts 30 min after sunset (a bright evening sky still looks dim on a light screen)
    function sunTimes(now) {
        var rad = Math.PI / 180, d0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        var N = Math.floor((d0 - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000), lngH = LON / 15;
        function at(rising) {
            var t = N + ((rising ? 6 : 18) - lngH) / 24, M = 0.9856 * t - 3.289;
            var L = (M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634 + 720) % 360;
            var RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = (RA + 360) % 360; RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90; RA /= 15;
            var sinD = 0.39782 * Math.sin(L * rad), cosD = Math.cos(Math.asin(sinD));
            var cosH = (Math.cos(90.833 * rad) - sinD * Math.sin(LAT * rad)) / (cosD * Math.cos(LAT * rad));
            if (cosH > 1) return null; if (cosH < -1) return Infinity;   // sun never rises / never sets
            var H = Math.acos(cosH) / rad; if (rising) H = 360 - H; H /= 15;
            var UT = ((H + RA - 0.06571 * t - 6.622 - lngH) % 24 + 24) % 24;
            return d0 + UT * 3600000;
        }
        return { rise: at(true), set: at(false) };
    }
    function isNight(now) {
        var s = sunTimes(now);
        if (s.rise === null || s.set === null) return true;
        if (s.rise === Infinity || s.set === Infinity) return false;
        return now.getTime() < s.rise || now.getTime() >= s.set + DUSK_MS;
    }
    function followSun() {
        var theme = isNight(new Date()) ? (root.getAttribute('data-dark') || 'aurora') : (root.getAttribute('data-light') || 'paper');
        if (document.documentElement.getAttribute('data-theme') !== theme) document.documentElement.setAttribute('data-theme', theme);
    }
    window.__kioskSun = { sunTimes: sunTimes, isNight: isNight };

    // An always-on display reloads itself once a night (04:00-04:59, at most once an hour), so it picks up new deploys and a changed look.
    var startedAt = Date.now();
    function nightlyReload() { if (Date.now() - startedAt > 3600000 && new Date().getHours() === 4) location.reload(); }
    function tick() { nightlyReload(); followSun(); tickClock(); allTiles.forEach(function (t) { t.updRefresh(); }); tiles.forEach(function (t) { try { t.tick(); } catch (e) { console.warn('kiosk tile:', e); } }); }

    // Keep the screen awake, and ask for browser fullscreen (honoured only from a tap: the first tap anywhere retries).
    var wake = null;
    function requestWake() {
        try {
            if (navigator.wakeLock && document.visibilityState === 'visible') navigator.wakeLock.request('screen').then(function (l) { wake = l; }).catch(function () {});
        } catch (e) { /* no wake lock: the OS may dim the screen */ }
    }
    function goFullscreen() {
        try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {}); } catch (e) { /* not allowed */ }
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { requestWake(); tick(); } });
    root.addEventListener('click', function (e) { if (!e.target.closest('button, a')) goFullscreen(); });

    var resizeTimer = null;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { allTiles.forEach(function (t) { t.refit(); }); }, 150); });
    tiles = TILES.map(function (build) { var t = build(); grid.appendChild(t.el); t.load(); return t; });
    tick();
    setInterval(tick, 20000);
    requestWake();
})();
