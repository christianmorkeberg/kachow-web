'use strict';

// Chat frontend: talks only to /api/chat.php. Keeps the current conversation id
// in localStorage so a reload continues the same thread.

(function () {
    const messages = document.getElementById('messages');
    const form = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const newChatBtn = document.getElementById('newChat');
    // Still frame normally; the animated GIF only while the assistant is "thinking".
    const AVATAR_STILL = '/assets/hummingbird_still.png';
    const AVATAR_FLYING = '/assets/hummingbird_no_background.gif';

    // ---- Icons: one flat, consistent set (Lucide subset in assets/icons.js) -----------
    // icon(name) → SVG markup string; iconEl(name) → a node; setIconText(el, name, text)
    // → icon + label (replaces the old "🚗 Label" emoji strings). hydrateIcons() fills the
    // server-rendered <span data-icon="…"> placeholders in index.php.
    var ICONS = window.KACHOW_ICONS || {};
    function icon(name, cls) {
        var inner = ICONS[name];
        if (!inner) return '';
        return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
            + inner + '</svg>';
    }
    function iconEl(name, cls) {
        var t = document.createElement('span');
        t.innerHTML = icon(name, cls);
        return t.firstChild || document.createTextNode('');
    }
    function setIconText(el, name, text) {
        el.textContent = '';
        if (name && ICONS[name]) el.appendChild(iconEl(name, 'ic-lead'));
        el.appendChild(document.createTextNode(text == null ? '' : String(text)));
        return el;
    }
    function hydrateIcons(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('[data-icon]'), function (el) {
            if (el.getAttribute('data-icon-done')) return;
            el.setAttribute('data-icon-done', '1');
            var ic = iconEl(el.getAttribute('data-icon'), el.hasAttribute('data-icon-only') ? '' : 'ic-lead');
            el.insertBefore(ic, el.firstChild);
        });
    }
    hydrateIcons(document);

    const CONV_KEY = 'kachow.conversation_id';
    let conversationId = Number(localStorage.getItem(CONV_KEY)) || null;
    let busy = false;
    let sendController = null;  // AbortController for the in-flight chat request (Stop button)
    let quickActions = null;   // cached suggestions for the empty-screen chips
    let resumeConversation = null;      // {id,title} offered as a "pick up where you left off" pill
    const IDLE_RESUME_SECONDS = 3600;   // only auto-resume the last chat if <1h since its last message
    let deviceLocation = null; // {lat, lon, acc, at} from the browser, for weather, "here" etc.

    function showEmptyHint() {
        if (messages.children.length) return;
        const wrap = document.createElement('div');
        wrap.className = 'empty';
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.textContent = 'Ask about your shopping list, workouts, or calendar.';
        wrap.appendChild(hint);
        const cards = document.createElement('div');
        cards.className = 'empty-cards';
        wrap.appendChild(cards);
        fillStartTiles(cards);
        const chips = document.createElement('div');
        chips.className = 'chips';
        wrap.appendChild(chips);
        messages.appendChild(wrap);
        renderChips(chips);
    }

    // The user's start cards as tiles on a fresh chat (phones have no card rail; on desktop the rail already shows them — CSS hides this there).
    function fillStartTiles(box) {
        box.innerHTML = '';
        if (typeof homeCards === 'undefined' || !homeCards || !homeCards.length || typeof HOME_CARDS === 'undefined' || !HOME_CARDS) return;
        homeCards.forEach(function (k) {
            var c = HOME_CARDS[k];
            if (!c) return;
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'start-tile';
            b.innerHTML = icon(c.icon, 'ic-lead') + '<span></span>';
            b.querySelector('span').textContent = daText(c.en, c.da);
            b.addEventListener('click', function () { openHomeCard(k, 'open'); });
            box.appendChild(b);
        });
    }
    function refreshStartTiles() {
        var box = messages.querySelector('.empty .empty-cards');
        if (box) fillStartTiles(box);
    }

    // Quick-action chips: frequent-first suggestions from the server, preceded by a
    // "pick up where you left off" pill when an idle gap started a fresh chat.
    function renderChips(container) {
        container.innerHTML = '';

        if (resumeConversation && resumeConversation.id) {
            const da = (navigator.language || '').toLowerCase().indexOf('da') === 0;
            const rb = document.createElement('button');
            rb.type = 'button';
            rb.className = 'chip chip-resume';
            setIconText(rb, 'undo-2', da ? 'Fortsæt hvor du slap' : 'Pick up where you left off');
            rb.addEventListener('click', function () {
                const id = resumeConversation.id;
                resumeConversation = null;
                loadConversation(id).catch(function () { /* non-fatal */ });
            });
            container.appendChild(rb);
        }

        (quickActions || []).forEach(function (text) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip';
            b.textContent = text;
            b.addEventListener('click', function () { onChip(text); });
            container.appendChild(b);
        });
    }

    function onChip(text) {
        const t = String(text).trim();
        // Templates end in "…" (or "..."): drop into the box to finish; others send.
        if (/(…|\.\.\.)$/.test(t)) {
            input.value = t.replace(/\s*(…|\.\.\.)\s*$/, '') + ' ';
            autogrow();
            input.focus();
        } else {
            send(text);
        }
    }

    function fetchQuickActions() {
        fetch('/api/quick-actions.php', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (data && Array.isArray(data.actions)) {
                    quickActions = data.actions;
                    const chips = messages.querySelector('.empty .chips');
                    if (chips) renderChips(chips);
                }
            })
            .catch(function () { /* non-fatal */ });
    }

    function clearEmptyHint() {
        const hint = messages.querySelector('.empty');
        if (hint) hint.remove();
    }

    // atLocal: optional "YYYY-MM-DD HH:MM:SS" (the DB's created_at) for restoring a past
    // conversation's real send time. NOT UTC despite config.php's date_default_timezone_set
    // ('UTC') — that governs PHP's own clock, but this column is MySQL's own
    // DEFAULT CURRENT_TIMESTAMP, stamped in the DB connection's session zone (confirmed by a
    // 2h-off hover time otherwise) — the same "TIMESTAMP renders server-local" gotcha already
    // hit once with location_points.received_at. Parsed with no 'Z', so the browser reads it
    // as wall-clock time directly — correct as long as the browser is also Europe/Copenhagen,
    // a safe bet (Christian is the only user). Omitted for a message created live, which just
    // means "now" either way.
    // Plain text → DOM with http(s) URLs as tappable links (never innerHTML, so nothing in the
    // text can inject markup). Used for user/notification/plain bubbles.
    function appendLinkified(el, text) {
        var re = /https?:\/\/[^\s<>"']+/g, str = String(text), last = 0, m;
        while ((m = re.exec(str)) !== null) {
            var url = m[0], tail = '';
            while (url.length > 8 && (/[.,;:!?]$/.test(url) || (url.slice(-1) === ')' && url.split('(').length < url.split(')').length))) {
                tail = url.slice(-1) + tail;
                url = url.slice(0, -1);
            }
            if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
            var a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url;
            el.appendChild(a);
            if (tail) el.appendChild(document.createTextNode(tail));
            last = m.index + m[0].length;
        }
        if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
    }

    function addMessage(text, role, html, atLocal) {
        clearEmptyHint();

        const bubble = document.createElement('div');
        bubble.className = 'msg ' + role;
        if (role === 'assistant' && typeof html === 'string' && html) {
            // Server-rendered, HTML-escaped markdown (see Support\Markdown).
            bubble.innerHTML = html;
        } else {
            appendLinkified(bubble, text);
        }
        var when = atLocal ? new Date(String(atLocal).replace(' ', 'T')) : new Date();
        if (!isNaN(when.getTime())) {
            var whenLabel = emailDate(when.toISOString());
            bubble.title = whenLabel;   // hover, on desktop
            var timeTag = document.createElement('span');
            timeTag.className = 'msg-time-tag';
            timeTag.textContent = whenLabel;
            bubble.appendChild(timeTag);   // tap to reveal, on any device
        }

        // Assistant messages carry the hummingbird avatar next to the bubble.
        // Returns the row so callers (e.g. the typing placeholder) can style/remove
        // the whole unit, avatar included.
        let el = bubble;
        if (role === 'assistant') {
            el = document.createElement('div');
            el.className = 'row assistant';
            const avatar = document.createElement('img');
            avatar.className = 'avatar';
            avatar.src = AVATAR_STILL;
            avatar.alt = '';
            avatar.setAttribute('aria-hidden', 'true');
            el.appendChild(avatar);
            el.appendChild(bubble);
        }

        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;
        return el;
    }

    // Tap a message bubble to toggle its timestamp (hover already shows it on desktop, but
    // touch has no hover). Delegated once on the container since bubbles come and go.
    // Ignored on a link/button tap so it doesn't also fire alongside their own click.
    messages.addEventListener('click', function (e) {
        if (e.target.closest('a, button')) return;
        var bubble = e.target.closest('.msg');
        if (bubble) bubble.classList.toggle('msg-time-open');
    });

    // ---- Developer mode: per-message diagnostics + "report to developer" ----------
    var DEV_KEY = 'kachow.dev';
    var devMode = localStorage.getItem(DEV_KEY) === '1';

    function applyDevMode() {
        document.body.classList.toggle('devmode', devMode);
        var b = document.getElementById('devModeToggle');
        if (b) {
            b.classList.toggle('tm-on', devMode);
            b.setAttribute('aria-pressed', devMode ? 'true' : 'false');
            setIconText(b, 'wrench', devMode ? 'Developer mode — on' : 'Developer mode');
        }
    }
    (function initDevMode() {
        var b = document.getElementById('devModeToggle');
        if (b) b.addEventListener('click', function () {
            devMode = !devMode;
            localStorage.setItem(DEV_KEY, devMode ? '1' : '0');
            applyDevMode();
        });
        applyDevMode();
    })();

    // ---- Insights: in-app usage/perf dashboard (admin-gated by the API) ------------
    // Fetches the diagnostics rollup (api/usage-stats.php) and renders it as cards +
    // bars + a daily trend, with a live auto-refresh and per-tool drill-down. All
    // charts are plain CSS (CSP-safe, no external lib).
    var insights = { days: 7, live: true, timer: null, expanded: null, loading: false };

    function openInsights() {
        if (document.getElementById('insightsOverlay')) return;
        var ov = document.createElement('div');
        ov.id = 'insightsOverlay';
        ov.className = 'insights-overlay';
        ov.innerHTML =
            '<div class="insights-box" role="dialog" aria-label="Usage insights">' +
            '  <div class="insights-head">' +
            '    <div class="insights-title">' + icon('chart-column', 'ic-lead') + 'Insights</div>' +
            '    <div class="insights-ranges" id="insRanges"></div>' +
            '    <label class="insights-live"><input type="checkbox" id="insLive"> live</label>' +
            '    <button type="button" class="insights-refresh" id="insRefresh" title="Refresh" aria-label="Refresh">' + icon('refresh-cw') + '</button>' +
            '    <button type="button" class="insights-close" id="insClose" aria-label="Close">' + icon('x') + '</button>' +
            '  </div>' +
            '  <div class="insights-body" id="insBody"><div class="insights-loading">Loading…</div></div>' +
            '</div>';
        document.body.appendChild(ov);

        var ranges = [['1', '24h'], ['7', '7d'], ['30', '30d'], ['', 'all']];
        var rc = ov.querySelector('#insRanges');
        ranges.forEach(function (r) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'ins-range';
            b.dataset.days = r[0];
            b.textContent = r[1];
            if ((r[0] === '' ? null : parseInt(r[0], 10)) === insights.days) b.classList.add('on');
            b.addEventListener('click', function () {
                insights.days = r[0] === '' ? null : parseInt(r[0], 10);
                insights.expanded = null;
                ov.querySelectorAll('.ins-range').forEach(function (x) { x.classList.remove('on'); });
                b.classList.add('on');
                loadInsights();
            });
            rc.appendChild(b);
        });

        var live = ov.querySelector('#insLive');
        live.checked = insights.live;
        live.addEventListener('change', function () { insights.live = live.checked; scheduleInsights(); });
        ov.querySelector('#insRefresh').addEventListener('click', loadInsights);
        ov.querySelector('#insClose').addEventListener('click', closeInsights);
        ov.addEventListener('click', function (e) { if (e.target === ov) closeInsights(); });

        loadInsights();
        scheduleInsights();
    }

    function closeInsights() {
        if (insights.timer) { clearInterval(insights.timer); insights.timer = null; }
        var ov = document.getElementById('insightsOverlay');
        if (ov) ov.remove();
    }

    function scheduleInsights() {
        if (insights.timer) { clearInterval(insights.timer); insights.timer = null; }
        if (insights.live && document.getElementById('insightsOverlay')) {
            insights.timer = setInterval(loadInsights, 10000);
        }
    }

    function loadInsights() {
        if (insights.loading) return;
        insights.loading = true;
        var qs = insights.days ? ('?days=' + insights.days) : '';
        fetch('/api/usage-stats.php' + qs, { credentials: 'same-origin' })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                insights.loading = false;
                var body = document.getElementById('insBody');
                if (!body) return;
                if (!res.ok || !res.j || !res.j.ok) {
                    body.innerHTML = '<div class="insights-error">' +
                        progEsc((res.j && res.j.error) || 'Could not load insights.') + '</div>';
                    return;
                }
                renderInsights(res.j.stats);
            })
            .catch(function () {
                insights.loading = false;
                var body = document.getElementById('insBody');
                if (body) body.innerHTML = '<div class="insights-error">Network error.</div>';
            });
    }

    function insBar(label, value, max, unit, cls) {
        var pctW = max > 0 ? Math.max(2, Math.round(100 * value / max)) : 0;
        return '<div class="ins-bar-row"><span class="ins-bar-label">' + progEsc(label) + '</span>' +
            '<span class="ins-bar-track"><span class="ins-bar-fill ' + (cls || '') + '" style="width:' + pctW + '%"></span></span>' +
            '<span class="ins-bar-val">' + value + (unit || '') + '</span></div>';
    }

    function renderInsights(s) {
        var body = document.getElementById('insBody');
        if (!body) return;
        var m = s.meta || {};
        var lat = s.latency || {};
        var html = '';

        // Meta line
        html += '<div class="ins-meta">' + (m.turns || 0) + ' turns · ' +
            progEsc(m.first_at || '—') + ' → ' + progEsc(m.last_at || '—') +
            (m.days ? ' · last ' + m.days + 'd' : ' · all history') + '</div>';

        if (!m.turns) {
            body.innerHTML = html + '<div class="insights-loading">No turns in this range yet.</div>';
            return;
        }

        // Summary cards
        var errTotal = (s.errors || []).reduce(function (a, e) { return a + e.count; }, 0);
        html += '<div class="ins-cards">' +
            insCard(m.turns, 'turns') +
            insCard(s.gemini_calls_avg, 'avg round-trips') +
            insCard((lat.total && lat.total.p50 || 0) + 'ms', 'total p50') +
            insCard((lat.gemini && lat.gemini.p95 || 0) + 'ms', 'gemini p95') +
            insCard(errTotal, 'tool errors') +
            '</div>';

        // Latency bars (p50, with p95 in the value)
        var latMax = Math.max(1, (lat.total && lat.total.p95) || 1);
        html += '<div class="ins-section"><h4>Latency (p50 bar · p95 label)</h4>';
        [['total', 'total turn', ''], ['gemini', 'gemini http', 'ins-fill-g'], ['tool', 'tool exec', 'ins-fill-t'], ['app', 'app/db', 'ins-fill-a']].forEach(function (row) {
            var b = lat[row[0]] || { p50: 0, p95: 0 };
            html += '<div class="ins-bar-row"><span class="ins-bar-label">' + row[1] + '</span>' +
                '<span class="ins-bar-track"><span class="ins-bar-fill ' + row[2] + '" style="width:' +
                Math.max(2, Math.round(100 * b.p50 / latMax)) + '%"></span></span>' +
                '<span class="ins-bar-val">' + b.p50 + ' / ' + b.p95 + 'ms</span></div>';
        });
        html += '</div>';

        // Daily trend (turns as column height; title carries detail)
        if ((s.daily || []).length) {
            var dMaxTurns = Math.max.apply(null, s.daily.map(function (d) { return d.turns; }).concat([1]));
            html += '<div class="ins-section"><h4>Daily</h4><div class="ins-spark">';
            s.daily.forEach(function (d) {
                var h = Math.max(4, Math.round(100 * d.turns / dMaxTurns));
                var t = d.date + ': ' + d.turns + ' turns, total p50 ' + d.total_p50 + 'ms, gemini p50 ' +
                    d.gemini_p50 + 'ms, ' + d.errors + ' err';
                html += '<span class="ins-spark-col" title="' + progEsc(t) + '">' +
                    '<span class="ins-spark-bar' + (d.errors ? ' has-err' : '') + '" style="height:' + h + '%"></span>' +
                    '<span class="ins-spark-x">' + progEsc(d.date.slice(5)) + '</span></span>';
            });
            html += '</div></div>';
        }

        // Routing + chaining side by side
        html += '<div class="ins-two">';
        var rMax = Math.max.apply(null, (s.routing || []).map(function (r) { return r.count; }).concat([1]));
        html += '<div class="ins-section"><h4>Routing</h4>';
        (s.routing || []).forEach(function (r) { html += insBar(r.group, r.count, rMax, '', 'ins-fill-r'); });
        html += '</div>';
        var cMax = Math.max.apply(null, (s.calls_per_turn || []).map(function (c) { return c.count; }).concat([1]));
        html += '<div class="ins-section"><h4>Tool calls / turn</h4>';
        (s.calls_per_turn || []).forEach(function (c) {
            var lbl = c.n === 0 ? '0 (direct)' : (c.n === 1 ? '1 tool' : c.n + ' chained');
            html += insBar(lbl, c.count, cMax, '', 'ins-fill-c');
        });
        html += '</div></div>';

        // Most-used tools with drill-down
        html += '<div class="ins-section"><h4>Tools (' + (s.tools || []).length + ')</h4>';
        html += '<div class="ins-tools">';
        (s.tools || []).forEach(function (t) {
            var open = insights.expanded === t.name;
            html += '<div class="ins-tool' + (open ? ' open' : '') + '" data-tool="' + progEsc(t.name) + '">' +
                '<div class="ins-tool-hd">' +
                '<span class="ins-tool-name">' + progEsc(t.name) + '</span>' +
                '<span class="ins-tool-stat">' + t.count + '×</span>' +
                '<span class="ins-tool-stat' + (t.err_pct > 0 ? ' bad' : '') + '">' + t.err_pct + '% err</span>' +
                '<span class="ins-tool-stat">' + t.ms_p50 + '/' + t.ms_p95 + 'ms</span>' +
                '<span class="ins-tool-stat">r' + t.avg_round + '</span>' +
                '</div>';
            if (open) html += insToolDetail(t);
            html += '</div>';
        });
        html += '</div></div>';

        // Top errors
        if ((s.errors || []).length) {
            html += '<div class="ins-section"><h4>Top errors</h4><ul class="ins-errs">';
            s.errors.forEach(function (e) {
                html += '<li><span class="ins-err-n">' + e.count + '×</span> <code>' + progEsc(e.tool) +
                    '</code> ' + progEsc(e.msg) + '</li>';
            });
            html += '</ul></div>';
        }

        body.innerHTML = html;

        // Wire tool drill-down toggles.
        body.querySelectorAll('.ins-tool-hd').forEach(function (hd) {
            hd.addEventListener('click', function () {
                var name = hd.parentNode.dataset.tool;
                insights.expanded = (insights.expanded === name) ? null : name;
                renderInsights(s); // re-render from the same snapshot (no refetch)
            });
        });
    }

    function insCard(value, label) {
        return '<div class="ins-card"><span class="ins-card-v">' + progEsc(String(value)) +
            '</span><span class="ins-card-l">' + progEsc(label) + '</span></div>';
    }

    function insToolDetail(t) {
        var html = '<div class="ins-tool-detail">';
        var days = Object.keys(t.daily || {}).sort();
        if (days.length) {
            var mx = Math.max.apply(null, days.map(function (d) { return t.daily[d]; }).concat([1]));
            html += '<div class="ins-spark small">';
            days.forEach(function (d) {
                html += '<span class="ins-spark-col" title="' + progEsc(d + ': ' + t.daily[d]) + '">' +
                    '<span class="ins-spark-bar" style="height:' + Math.max(6, Math.round(100 * t.daily[d] / mx)) + '%"></span>' +
                    '<span class="ins-spark-x">' + progEsc(d.slice(5)) + '</span></span>';
            });
            html += '</div>';
        }
        if ((t.errors || []).length) {
            html += '<ul class="ins-errs">';
            t.errors.forEach(function (e) {
                html += '<li><span class="ins-err-n">' + e.count + '×</span> ' + progEsc(e.msg || '(no message)') + '</li>';
            });
            html += '</ul>';
        } else {
            html += '<div class="ins-tool-clean">no errors</div>';
        }
        return html + '</div>';
    }

    (function initInsights() {
        var b = document.getElementById('insightsBtn');
        if (b) b.addEventListener('click', openInsights);
    })();

    function toast(msg) {
        var t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        document.body.appendChild(t);
        requestAnimationFrame(function () { t.classList.add('show'); });
        setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2600);
    }

    // Tags a rendered message with its DB id (enabling "report to developer") and,
    // for assistant turns, appends a collapsible diagnostics panel (shown only in
    // developer mode via CSS).
    // ---- What the assistant is doing (dev idea: show tools used live) ----------------
    // Tool name → icon + a short sentence, derived rather than hand-listed for all ~115
    // tools: the DOMAIN (a word in the name) picks the icon + object, the VERB prefix picks
    // the action; a few tools get their own phrasing. EN/DA via daText.
    var TOOL_DOMAINS = [
        [/weather|forecast/,                    'cloud-sun',     'the weather',        'vejret'],
        [/calendar/,                            'calendar',      'your calendar',      'din kalender'],
        [/shopping|_item$|checked_items/,       'shopping-cart', 'the shopping list',  'indkøbslisten'],
        [/workout|exercise|week_plan/,          'dumbbell',      'your training',      'din træning'],
        [/work_log|work_time/,                  'notebook-pen',  'your work log',      'din arbejdslog'],
        [/work_|clock/,                         'clock',         'your work hours',    'dine arbejdstimer'],
        [/email/,                               'mail',          'your email',         'din mail'],
        [/cycle|period/,                        'moon',          'your cycle',         'din cyklus'],
        [/vinyl/,                               'disc-3',        'your records',       'dine plader'],
        [/wishlist/,                            'gift',          'the wishlist',       'ønskelisten'],
        [/receipt|expense/,                     'receipt',       'your expenses',      'dine udgifter'],
        [/invoice|income/,                      'file-text',     'your income',        'dine indtægter'],
        [/owner_draw/,                          'wallet',        'owner draws',        'hævninger'],
        [/books/,                               'book-open',     'your books',         'dit regnskab'],
        [/cash/,                                'landmark',      'your cash position', 'din likviditet'],
        [/moms/,                                'percent',       'your VAT',           'din moms'],
        [/profit_loss/,                         'trending-up',   'profit & loss',      'resultatet'],
        [/mileage|trip|driving/,                'car',           'your driving log',   'din kørsel'],
        [/dev_idea/,                            'lightbulb',     'the dev backlog',    'udviklingslisten'],
        [/feedback|diagnostics/,                'wrench',        'feedback',           'feedback'],
        [/reminder/,                            'alarm-clock',   'reminders',          'påmindelser'],
        [/about_me/,                            'brain',         'what I know about you', 'hvad jeg ved om dig'],
        [/instruction/,                         'list-checks',   'your preferences',   'dine præferencer'],
        [/connection|invite/,                   'users',         'your connections',   'dine forbindelser'],
        [/setting|appearance|my_name|company/,  'settings',      'your settings',      'dine indstillinger'],
        [/home_/,                               'house',         'your home devices',  'dine hjemmeenheder'],
        [/chart/,                               'chart-column',  'a chart',            'en graf']
    ];
    // Every tool has its own line (the generic verb + domain fallback below only catches tools added later).
    var TOOL_TEXT = {
        accept_connection_request: ['Accepting the connection request', 'Accepterer forbindelsesanmodningen'],
        add_expense: ['Saving the expense', 'Gemmer udgiften'],
        add_income: ['Saving the income', 'Gemmer indtægten'],
        add_owner_draw: ['Recording the owner draw', 'Registrerer ejeruddraget'],
        add_plan_exercise: ['Adding an exercise to the plan', 'Tilføjer en øvelse til planen'],
        add_program_days: ['Adding days to the programme', 'Tilføjer dage til programmet'],
        add_to_shopping_list: ['Adding to the shopping list', 'Lægger på indkøbslisten'],
        add_vinyl: ['Adding the record to your collection', 'Tilføjer pladen til din samling'],
        add_wishlist_item: ['Adding to the wishlist', 'Tilføjer til ønskelisten'],
        attach_email_file: ['Attaching the file to the email', 'Vedhæfter filen til mailen'],
        cancel_reminder: ['Cancelling the reminder', 'Annullerer påmindelsen'],
        cancel_scheduled_task: ['Cancelling the scheduled task', 'Annullerer den planlagte opgave'],
        check_off_exercise: ['Ticking off exercises', 'Afkrydser øvelser'],
        check_off_item: ['Ticking off on the list', 'Afkrydser på listen'],
        clear_checked_items: ['Clearing the ticked items', 'Rydder de afkrydsede'],
        create_invite: ['Creating an invitation', 'Opretter en invitation'],
        create_routine: ['Creating the routine', 'Opretter rutinen'],
        create_workout_plan: ['Creating the workout plan', 'Opretter træningsplanen'],
        delete_calendar_event: ['Deleting the calendar event', 'Sletter kalenderbegivenheden'],
        delete_place: ['Deleting the place', 'Sletter stedet'],
        delete_receipt: ['Deleting the receipt', 'Sletter kvitteringen'],
        delete_shopping_list: ['Deleting the shopping list', 'Sletter indkøbslisten'],
        delete_training_program: ['Deleting the training programme', 'Sletter træningsprogrammet'],
        delete_trip: ['Deleting the trip', 'Sletter turen'],
        delete_wishlist_item: ['Removing from the wishlist', 'Fjerner fra ønskelisten'],
        delete_work_event: ['Deleting the work entry', 'Sletter arbejdsregistreringen'],
        delete_workout: ['Deleting the workout', 'Sletter træningen'],
        delete_workout_plan: ['Deleting the workout plan', 'Sletter træningsplanen'],
        explain_capabilities: ['Listing what I can do', 'Gennemgår hvad jeg kan'],
        export_data: ['Building the export', 'Laver eksporten'],
        export_expenses_csv: ['Exporting the expenses', 'Eksporterer udgifterne'],
        export_work_log: ['Exporting the work log', 'Eksporterer arbejdsloggen'],
        find_program_in_memory: ['Looking for a saved programme in memory', 'Leder efter et gemt program i hukommelsen'],
        forget_about_me: ['Forgetting that', 'Glemmer det'],
        forget_instruction: ['Removing the preference', 'Fjerner præferencen'],
        get_about_me: ['Recalling what I know about you', 'Husker hvad jeg ved om dig'],
        get_appearance: ['Checking your appearance settings', 'Tjekker dine udseendeindstillinger'],
        get_books: ['Opening your books', 'Åbner dit regnskab'],
        get_calendar_events: ['Reading your calendar', 'Læser din kalender'],
        get_cash: ['Checking your cash position', 'Tjekker din kassebeholdning'],
        get_connected_calendar: ['Reading their calendar', 'Læser deres kalender'],
        get_connected_cycle: ['Checking their cycle', 'Tjekker deres cyklus'],
        get_connected_vinyls: ['Looking at their records', 'Kigger på deres plader'],
        get_connected_wishlist: ['Reading their wishlist', 'Læser deres ønskeliste'],
        get_connected_work_hours: ['Checking their work hours', 'Tjekker deres arbejdstimer'],
        get_connected_workout_plan: ['Reading their workout plan', 'Læser deres træningsplan'],
        get_connected_workout_progress: ['Checking their training progress', 'Tjekker deres træningsfremgang'],
        get_connected_workouts: ['Reading their workouts', 'Læser deres træninger'],
        get_cycle_status: ['Checking your cycle', 'Tjekker din cyklus'],
        get_expenses: ['Reading your expenses', 'Læser dine udgifter'],
        get_income: ['Reading your income', 'Læser dine indtægter'],
        get_instructions: ['Reading your preferences', 'Læser dine præferencer'],
        get_location_day: ['Reading your day on the map', 'Læser din dag på kortet'],
        get_location_tracking_setup: ['Checking the location tracking setup', 'Tjekker opsætningen af positionssporing'],
        get_mileage: ['Reading your driving log', 'Læser din kørebog'],
        get_moms: ['Working out the VAT', 'Beregner momsen'],
        get_owner_draws: ['Reading the owner draws', 'Læser ejeruddragene'],
        get_profit_loss: ['Working out profit and loss', 'Beregner resultatet'],
        get_sensor_setup: ['Checking the sensor setup', 'Tjekker sensoropsætningen'],
        get_settings: ['Reading your settings', 'Læser dine indstillinger'],
        get_shopping_list: ['Opening the shopping list', 'Åbner indkøbslisten'],
        get_stays: ['Reading your stays', 'Læser dine ophold'],
        get_thermostats: ['Checking the thermostats', 'Tjekker termostaterne'],
        get_training_program: ['Opening your training programme', 'Åbner dit træningsprogram'],
        get_trips: ['Reading your trips', 'Læser dine ture'],
        get_vinyls: ['Looking through your records', 'Kigger dine plader igennem'],
        get_voice_log: ['Reading the voice log', 'Læser stemmeloggen'],
        get_week_plan: ['Checking the week’s training', 'Tjekker ugens træning'],
        get_wishlist: ['Reading the wishlist', 'Læser ønskelisten'],
        get_work_clock: ['Checking the work clock', 'Tjekker arbejdsuret'],
        get_work_hours: ['Adding up your work hours', 'Lægger dine arbejdstimer sammen'],
        get_work_log: ['Reading your work log', 'Læser din arbejdslog'],
        get_work_tracking_setup: ['Checking the work tracking setup', 'Tjekker opsætningen af arbejdssporing'],
        get_workout_history: ['Reading your workout history', 'Læser din træningshistorik'],
        get_workout_plan: ['Checking the day’s training', 'Tjekker dagens træning'],
        get_workout_progress: ['Checking your progress', 'Tjekker din fremgang'],
        hue_color: ['Setting the light colour', 'Sætter lysets farve'],
        insert_calendar_event: ['Adding the event to your calendar', 'Lægger begivenheden i din kalender'],
        list_calendars: ['Listing your calendars', 'Finder dine kalendere'],
        list_connections: ['Listing your connections', 'Finder dine forbindelser'],
        list_dev_ideas: ['Reading the dev ideas', 'Læser udviklingsidéerne'],
        list_email_accounts: ['Listing your mailboxes', 'Finder dine postkasser'],
        list_feedback: ['Reading the error reports', 'Læser fejlrapporterne'],
        list_places: ['Listing your places', 'Finder dine steder'],
        list_reminders: ['Listing your reminders', 'Finder dine påmindelser'],
        list_scheduled_tasks: ['Listing your scheduled tasks', 'Finder dine planlagte opgaver'],
        list_shopping_lists: ['Listing your shopping lists', 'Finder dine indkøbslister'],
        log_connected_workout: ['Logging a workout for them', 'Logger en træning for dem'],
        log_cycle_day: ['Logging the cycle day', 'Logger cyklusdagen'],
        log_period: ['Logging the period', 'Logger menstruationen'],
        log_trip: ['Logging the trip', 'Logger turen'],
        log_work_event: ['Logging the work entry', 'Logger arbejdsregistreringen'],
        log_work_time: ['Logging the work time', 'Logger arbejdstiden'],
        log_workout: ['Logging your sets', 'Logger dine sæt'],
        mark_emails_read: ['Marking the emails as read', 'Markerer mails som læst'],
        mark_expense_reimbursed: ['Marking the expense as reimbursed', 'Markerer udgiften som refunderet'],
        mark_invoice_paid: ['Marking the invoice as paid', 'Markerer fakturaen som betalt'],
        merge_exercises: ['Merging the exercises', 'Slår øvelserne sammen'],
        note_dev_idea: ['Saving the dev idea', 'Gemmer udviklingsidéen'],
        notify_me: ['Setting up the notification', 'Sætter notifikationen op'],
        rate_vinyl: ['Rating the record', 'Bedømmer pladen'],
        record_cash_movement: ['Recording the cash movement', 'Registrerer kassebevægelsen'],
        refresh_home_devices: ['Refreshing your home devices', 'Opdaterer dine hjemmeenheder'],
        remember_instruction: ['Saving the preference', 'Gemmer præferencen'],
        remove_connection: ['Removing the connection', 'Fjerner forbindelsen'],
        remove_dev_idea: ['Removing the dev idea', 'Fjerner udviklingsidéen'],
        remove_from_shopping_list: ['Taking it off the shopping list', 'Tager det af indkøbslisten'],
        remove_period: ['Removing the period', 'Fjerner menstruationen'],
        remove_plan_exercise: ['Removing an exercise from the plan', 'Fjerner en øvelse fra planen'],
        remove_program_days: ['Removing days from the programme', 'Fjerner dage fra programmet'],
        remove_vinyl: ['Removing the record', 'Fjerner pladen'],
        resolve_feedback: ['Resolving the error report', 'Lukker fejlrapporten'],
        run_routine: ['Running the routine', 'Kører rutinen'],
        save_place: ['Saving the place', 'Gemmer stedet'],
        save_region: ['Saving the region', 'Gemmer området'],
        save_training_program: ['Saving the training programme', 'Gemmer træningsprogrammet'],
        schedule_task: ['Scheduling the task', 'Planlægger opgaven'],
        send_connection_request: ['Sending the connection request', 'Sender forbindelsesanmodningen'],
        set_company_profile: ['Saving your company details', 'Gemmer dine firmaoplysninger'],
        set_dev_idea_status: ['Updating the dev idea status', 'Opdaterer udviklingsidéens status'],
        set_diagnostics: ['Updating the error report', 'Opdaterer fejlrapporten'],
        set_list_grouping: ['Changing how the list is grouped', 'Ændrer listens gruppering'],
        set_my_name: ['Saving your name', 'Gemmer dit navn'],
        set_reminder: ['Setting the reminder', 'Sætter påmindelsen'],
        set_scheduled_task_active: ['Switching the scheduled task', 'Skifter den planlagte opgave'],
        set_thermostat: ['Setting the thermostat', 'Indstiller termostaten'],
        show_home: ['Opening your home devices', 'Åbner dine hjemmeenheder'],
        suggest_places: ['Finding places nearby', 'Finder steder i nærheden'],
        training_load: ['Working out your training load', 'Beregner din træningsbelastning'],
        uncheck_exercise: ['Unticking an exercise', 'Fjerner afkrydsning af en øvelse'],
        uncheck_item: ['Unticking on the list', 'Fjerner afkrydsning på listen'],
        undo_routine: ['Undoing the routine', 'Fortryder rutinen'],
        update_about_me: ['Updating what I know about you', 'Opdaterer hvad jeg ved om dig'],
        update_calendar_event: ['Changing the calendar event', 'Ændrer kalenderbegivenheden'],
        update_connection_sharing: ['Changing what you share', 'Ændrer hvad du deler'],
        update_dev_idea: ['Editing the dev idea', 'Redigerer udviklingsidéen'],
        update_income: ['Editing the income', 'Redigerer indtægten'],
        update_place: ['Editing the place', 'Redigerer stedet'],
        update_receipt: ['Editing the receipt', 'Redigerer kvitteringen'],
        update_routine: ['Editing the routine', 'Redigerer rutinen'],
        update_setting: ['Changing the setting', 'Ændrer indstillingen'],
        update_system_task: ['Updating the system task', 'Opdaterer systemopgaven'],
        update_training_program: ['Editing the training programme', 'Redigerer træningsprogrammet'],
        update_trip: ['Editing the trip', 'Redigerer turen'],
        update_vinyl: ['Editing the record', 'Redigerer pladen'],
        update_wishlist_item: ['Editing the wishlist item', 'Redigerer ønskelisteemnet'],
        update_workout: ['Editing the workout', 'Redigerer træningen'],
        where_am_i: ['Checking where you are', 'Tjekker hvor du er']
    };
    var TOOL_SPECIAL = {
        get_current_weather:  ['Checking the weather', 'Tjekker vejret'],
        get_weather_forecast: ['Checking the forecast', 'Tjekker vejrudsigten'],
        get_emails:           ['Checking your inbox', 'Tjekker din indbakke'],
        read_email:           ['Reading the email', 'Læser mailen'],
        draft_email:          ['Drafting an email', 'Skriver et mailudkast'],
        send_email:           ['Sending the email', 'Sender mailen'],
        get_driving_distance: ['Working out the route', 'Beregner ruten'],
        show_chart:           ['Drawing a chart', 'Tegner en graf'],
        get_work_summary:     ['Adding up your hours', 'Lægger dine timer sammen'],
        create_invoice:       ['Creating the invoice', 'Opretter fakturaen'],
        recommend_vinyl:      ['Finding a record for you', 'Finder en plade til dig'],
        assess_vinyl:         ['Looking at the record', 'Kigger på pladen'],
        remember_about_me:    ['Remembering that', 'Husker det'],
        home_device_call:     ['Talking to your home devices', 'Taler med dine hjemmeenheder'],
        get_home_agent_setup: ['Checking your home agent', 'Tjekker din hjemmeagent'],
        web_search:           ['Searching the web', 'Søger på nettet'],
        fetch_webpage:        ['Reading the web page', 'Læser websiden'],
        set_place_reminder:   ['Setting a place reminder', 'Sætter en stedpåmindelse'],
        get_calendar_month:   ['Opening your month', 'Åbner din måned'],
        get_workout_plan:     ['Checking the day’s training', 'Tjekker dagens træning'],
        get_week_plan:        ['Checking the week’s training', 'Tjekker ugens træning'],
        get_training_program: ['Opening your training programme', 'Åbner dit træningsprogram'],
        check_off_exercise:   ['Ticking off exercises', 'Afkrydser øvelser'],
        log_workout:          ['Logging your sets', 'Logger dine sæt'],
        export_data:          ['Building the export', 'Laver eksporten'],
        add_to_shopping_list: ['Adding to the shopping list', 'Lægger på indkøbslisten'],
        where_am_i:           ['Checking where you are', 'Tjekker hvor du er'],
        run_routine:          ['Running the routine', 'Kører rutinen'],
        undo_routine:         ['Undoing the routine', 'Fortryder rutinen']
    };
    function toolInfo(name) {
        name = String(name || '');
        var dom = null;
        for (var i = 0; i < TOOL_DOMAINS.length; i++) {
            if (TOOL_DOMAINS[i][0].test(name)) { dom = TOOL_DOMAINS[i]; break; }
        }
        var iconName = dom ? dom[1] : 'sparkles';
        var fixed = TOOL_SPECIAL[name] || TOOL_TEXT[name];
        if (fixed) return { icon: iconName, text: daText(fixed[0], fixed[1]) };
        var obj = dom ? daText(dom[2], dom[3]) : daText('something', 'noget');
        var verb = /^(get|list|read|search|export|find)_/.test(name) ? ['Looking up', 'Slår op i']
            : /^add_/.test(name) ? ['Adding to', 'Tilføjer til']
            : /^log_/.test(name) ? ['Logging to', 'Logger i']
            : /^(delete|remove|forget|cancel|clear)_/.test(name) ? ['Removing from', 'Fjerner fra']
            : /^(update|merge|mark|rate|check_off|uncheck|resolve|set_diagnostics)/.test(name) ? ['Updating', 'Opdaterer']
            : /^(send|accept)_/.test(name) ? ['Sending via', 'Sender via']
            : ['Saving to', 'Gemmer i'];
        return { icon: iconName, text: daText(verb[0], verb[1]) + ' ' + obj };
    }

    function newTurnId() {
        var a = new Uint8Array(12);
        (window.crypto || window.msCrypto).getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    // Polls api/progress.php while a turn runs and draws the steps inside the typing
    // bubble. Returns stop(). Never overlaps requests; silently gives up on errors.
    function startToolProgress(row, turnId) {
        var bubble = row.querySelector('.msg');
        if (!bubble) return function () {};
        var box = document.createElement('div');
        box.className = 'tool-live';
        bubble.appendChild(box);
        var stopped = false, timer = null, failures = 0, lastKey = '', shown = 0;
        function render(st) {
            var steps = (st && st.steps) || [];
            // Only the TWO newest lines are shown at a time (dev idea #68): the steps so far, then a last line for what the model
            // is doing between them — reading the message, going through a result, writing the answer.
            // The same tool several times in a row (four log_workout calls) is ONE line with a count, not four identical ones.
            var lines = [];
            steps.forEach(function (x) {
                var prev = lines.length ? lines[lines.length - 1] : null;
                if (prev && prev.kind === 'step' && prev.x.tool === x.tool) {
                    prev.n++;
                    prev.x = { tool: x.tool, status: (x.status === 'running' || prev.x.status === 'running') ? 'running'
                        : (x.status === 'error' || prev.x.status === 'error') ? 'error' : 'done' };
                } else {
                    lines.push({ kind: 'step', x: x, n: 1 });
                }
            });
            if (st && st.phase === 'thinking' && !steps.length) {
                lines.push({ kind: 'phase', ic: 'message-square', text: daText('Reading your message', 'Læser din besked') });
            } else if (st && st.phase === 'answering') {
                lines.push({ kind: 'phase', ic: 'sparkles', text: steps.length
                    ? daText('Going through what I found', 'Gennemgår det jeg fandt')
                    : daText('Putting the answer together', 'Samler svaret') });
            }
            if (!lines.length) return;
            // Redraw only on change, and fade in only NEW lines (a full redraw per poll
            // would restart the animation and leave every line half-transparent).
            var key = JSON.stringify([st.phase, steps]);
            if (key === lastKey) return;
            lastKey = key;
            row.classList.add('has-tools');
            var first = Math.max(0, lines.length - 2), prevShown = shown;
            shown = lines.length;
            box.innerHTML = lines.slice(first).map(function (ln, i) {
                var fresh = (first + i) >= prevShown ? ' tl-new' : '';
                if (ln.kind === 'phase') {
                    return '<div class="tl-step tl-running' + fresh + '">' + icon(ln.ic, 'tl-ic')
                        + '<span class="tl-text">' + progEsc(ln.text) + '</span>' + icon('loader-circle', 'tl-spin') + '</div>';
                }
                var x = ln.x, info = toolInfo(x.tool);
                var mark = x.status === 'running' ? icon('loader-circle', 'tl-spin')
                    : x.status === 'error' ? icon('circle-x', 'tl-err') : icon('check', 'tl-ok');
                return '<div class="tl-step tl-' + progEsc(x.status) + fresh + '">' + icon(info.icon, 'tl-ic')
                    + '<span class="tl-text">' + progEsc(info.text + (ln.n > 1 ? ' ×' + ln.n : '')) + '</span>' + mark + '</div>';
            }).join('');
        }
        function tick() {
            if (stopped) return;
            fetch('/api/progress.php?turn=' + turnId, { credentials: 'same-origin', cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (st) { if (!stopped && st) render(st); })
                .catch(function () { failures++; })
                .then(function () { if (!stopped && failures < 5) timer = setTimeout(tick, 650); });
        }
        timer = setTimeout(tick, 350);
        return function stop() { stopped = true; if (timer) clearTimeout(timer); };
    }

    // After the reply: a compact strip of the tools this turn used (icons; tap for the
    // sentences). Built from the stored diagnostics, so reopened chats show it too.
    function buildToolStrip(calls) {
        var seen = {}, list = [];
        (calls || []).forEach(function (c) {
            if (!c || !c.name || seen[c.name]) return;
            seen[c.name] = true;
            list.push({ name: c.name, ok: c.ok !== false });
        });
        if (!list.length) return null;
        var strip = document.createElement('button');
        strip.type = 'button';
        strip.className = 'tool-strip';
        strip.setAttribute('aria-label', daText('Tools used', 'Brugte værktøjer'));
        strip.innerHTML = list.map(function (t) {
            var info = toolInfo(t.name);
            return '<span class="ts-item' + (t.ok ? '' : ' ts-err') + '" title="' + progEsc(info.text) + '">'
                + icon(info.icon) + '<span class="ts-text">' + progEsc(info.text) + '</span></span>';
        }).join('');
        strip.addEventListener('click', function () { strip.classList.toggle('open'); });
        return strip;
    }

    function attachMessageMeta(el, meta) {
        if (!el || !meta) return;
        var bubble = (el.classList && el.classList.contains('msg')) ? el : el.querySelector('.msg');
        if (!bubble) return;
        if (meta.id) {
            bubble.dataset.msgId = meta.id;
            // Only assistant replies get the report affordance (you report a bad answer;
            // the snapshot already carries the surrounding user turn as context).
            if (bubble.classList.contains('assistant')) wireReport(bubble, meta.id);
        }
        if (meta.diagnostics) {
            // Insert after the whole message unit (the row/bubble that sits in `messages`),
            // so the panel is full-width below the bubble, not inside the flex row.
            el.insertAdjacentElement('afterend', buildDiagPanel(meta.diagnostics));
            // Tools-used strip (everyone, not just dev mode) — directly under the bubble.
            var strip = bubble.classList.contains('assistant') ? buildToolStrip(meta.diagnostics.calls) : null;
            if (strip) el.insertAdjacentElement('afterend', strip);
        }
    }

    function wireReport(bubble, msgId) {
        if (bubble._reportWired) return;
        bubble._reportWired = true;
        bubble.classList.add('reportable');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-report-btn';
        btn.title = 'Report to developer';
        btn.setAttribute('aria-label', 'Report to developer');
        btn.innerHTML = icon('flag');
        btn.addEventListener('click', function (e) { e.stopPropagation(); openReportDialog(msgId); });
        bubble.appendChild(btn);
        // No right-click / long-press shortcut: it hijacked the browser's own menu (copy, paste,
        // inspect). The visible flag button is the only way in.
    }

    function buildDiagPanel(d) {
        var wrap = document.createElement('details');
        wrap.className = 'msg-diag';
        var sum = document.createElement('summary');
        setIconText(sum, 'settings', 'diagnostics');   // flat line icon, not the ⚙ emoji
        wrap.appendChild(sum);

        var parts = [];
        parts.push('<div><b>routing:</b> ' + progEsc((d.routing || []).join(', ') || '—')
            + ' · <b>tools sent:</b> ' + (d.tools_sent != null ? d.tools_sent : '?')
            + (d.model ? ' · <b>model:</b> ' + progEsc(d.model) : '') + '</div>');
        if (d.timing) {
            var t = d.timing;
            var net = t.net_last
                ? ' · net ' + t.net_last.conn + '/' + t.net_last.tls + '/' + t.net_last.think + 'ms (conn/tls/think)'
                : '';
            parts.push('<div class="diag-timing"><b>timing:</b> total ' + t.total_ms + 'ms · gemini '
                + t.gemini_ms + 'ms (' + t.gemini_calls + ' call' + (t.gemini_calls === 1 ? '' : 's')
                + ') · tools ' + t.tools_ms + 'ms · app ' + t.app_ms + 'ms · req ' + t.req_kb + 'kb' + net + '</div>');
        }
        if (d.calls && d.calls.length) {
            parts.push('<ul class="diag-calls">' + d.calls.map(function (c) {
                return '<li><code>' + progEsc(c.name) + '</code> '
                    + (c.ok === false ? '<span class="diag-err">✗ ' + progEsc(c.error || '') + '</span>' : '✓')
                    + (c.ms != null ? ' <span class="diag-ms">' + c.ms + 'ms</span>' : '')
                    + (c.args ? ' <span class="diag-args">' + progEsc(c.args) + '</span>' : '') + '</li>';
            }).join('') + '</ul>');
        } else {
            parts.push('<div class="diag-none">no tool calls</div>');
        }
        if (d.thoughts && d.thoughts.length) {
            parts.push('<div class="diag-thoughts-h"><b>thoughts:</b></div>'
                + d.thoughts.map(function (t) { return '<div class="diag-thought">' + progEsc(t) + '</div>'; }).join(''));
        }
        var body = document.createElement('div');
        body.className = 'msg-diag-body';
        body.innerHTML = parts.join('');
        wrap.appendChild(body);
        return wrap;
    }

    function openReportDialog(msgId) {
        if (document.getElementById('reportOverlay')) return;
        var ov = document.createElement('div');
        ov.id = 'reportOverlay';
        ov.className = 'report-overlay';
        var box = document.createElement('div');
        box.className = 'report-box';
        box.innerHTML = '<div class="report-title">Report to developer</div>'
            + '<div class="report-sub">Something off with this message? Add a note (optional).</div>';
        var ta = document.createElement('textarea');
        ta.className = 'report-note';
        ta.rows = 3;
        ta.placeholder = 'What looked wrong?';
        var actions = document.createElement('div');
        actions.className = 'report-actions';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'report-cancel';
        cancel.textContent = 'Cancel';
        var sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'report-send';
        sendBtn.textContent = 'Send to developer';
        actions.appendChild(cancel);
        actions.appendChild(sendBtn);
        box.appendChild(ta);
        box.appendChild(actions);
        ov.appendChild(box);
        document.body.appendChild(ov);
        ta.focus();

        function close() { ov.remove(); }
        cancel.addEventListener('click', close);
        ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        sendBtn.addEventListener('click', function () {
            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending…';
            fetch('/api/report.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ message_id: Number(msgId), note: ta.value || undefined })
            }).then(function (r) { return r.json(); }).then(function (res) {
                close();
                toast(res && res.ok ? 'Sent to developer — thanks!' : ((res && res.error) || 'Could not send.'));
            }).catch(function () { close(); toast('Network error sending report.'); });
        });
    }

    // ---- Persistent card panel (mobile-first "canvas") -------------------------
    // Cards live in their own foldable panel above the composer rather than being
    // re-posted into the transcript on every turn. "add milk" updates the panel in
    // place; switching topic swaps the card; the prose reply stays in the chat as
    // the running log.
    var cardPanel      = document.getElementById('cardPanel');
    var cardPanelBody  = document.getElementById('cardPanelBody');
    var cardPanelTitle = document.getElementById('cardPanelTitle');
    var cardPanelSub   = document.getElementById('cardPanelSub');
    var panelKind      = null;
    var panelCard      = null;   // the card currently in the panel (for the live refresh)

    // kind → [icon, title]. Icon names come from assets/icons.js (Lucide).
    var CARD_TITLES = {
        shopping_list: ['shopping-cart', 'Shopping list'],
        workout_plan:  ['dumbbell', 'Workout plan'],
        agenda:        ['calendar', 'Agenda'],
        calendar_month: ['calendar', 'Month'],
        weather:       ['cloud-sun', 'Weather'],
        work_hours:    ['clock', 'Work hours'],
        work_chart:    ['chart-column', 'Work hours'],
        chart:         ['chart-column', 'Chart'],
        work_log:      ['notebook-pen', 'Work log'],
        progression:   ['trending-up', 'Progression'],
        cycle:         ['moon', 'Cycle'],
        receipt:       ['receipt', 'Receipt'],
        expenses:      ['credit-card', 'Expenses'],
        income:        ['file-text', 'Income'],
        export_preview: ['file-text', 'Export'],
        income_summary:['trending-up', 'Income'],
        owner_draws:   ['wallet', 'Owner draws'],
        bookkeeping:   ['book-open', 'Books'],
        moms:          ['percent', 'Moms'],
        cash:          ['landmark', 'Cash'],
        pl:            ['trending-up', 'P&L'],
        mileage:       ['car', 'Mileage'],
        location_day:  ['map', 'Location'],
        places:        ['map-pin', 'Places'],
        email_list:    ['inbox', 'Inbox'],
        email:         ['mail', 'Email'],
        email_draft:   ['pencil-line', 'Draft'],
        feedback:      ['wrench', 'Feedback'],
        dev_ideas:     ['lightbulb', 'Dev ideas'],
        scheduled_tasks: ['repeat', 'Routines'],
        personality:   ['drama', 'Personality'],
        home_cards:    ['list-checks', 'Start cards'],
        home:          ['house', 'Home'],
        training_program: ['dumbbell', 'Programme'],
        appearance:    ['palette', 'Appearance'],
        notice:        ['circle-alert', 'Note']
    };

    // Personality dial: 1–5 (1 = off, 5 = max). Number label + blurb + a sample reply per
    // level, bilingual — the sample uses a workout-PR moment so the tone escalation is obvious.
    var PERSONALITY_LEVELS = [
        {
            value: '1',
            en: { label: '1', blurb: 'Off — plain and neutral.',        ex: 'Logged. New squat PR: 140 kg.' },
            da: { label: '1', blurb: 'Fra — neutral og enkel.',         ex: 'Noteret. Ny squat-rekord: 140 kg.' }
        },
        {
            value: '2',
            en: { label: '2', blurb: 'A faint touch of character.',      ex: 'Nice — new squat PR, 140 kg.' },
            da: { label: '2', blurb: 'Et svagt strejf af personlighed.', ex: 'Flot — ny squat-rekord, 140 kg.' }
        },
        {
            value: '3',
            en: { label: '3', blurb: 'A balanced amount of personality.', ex: 'Solid! New squat PR at 140 kg 💪' },
            da: { label: '3', blurb: 'Afbalanceret personlighed.',        ex: 'Stærkt! Ny squat-rekord på 140 kg 💪' }
        },
        {
            value: '4',
            en: { label: '4', blurb: 'Clearly characterful.',           ex: "Yesss, 140 kg squat — that's a PR! 🔥" },
            da: { label: '4', blurb: 'Tydelig personlighed.',           ex: 'Yes, 140 kg squat — det er rekord! 🔥' }
        },
        {
            value: '5',
            en: { label: '5', blurb: 'Full-on, all the energy.',        ex: "LET'S GOOO! 140 kg squat, NEW PR — absolute unit! 🔥💪" },
            da: { label: '5', blurb: 'Fuld knald på, al energien.',      ex: 'KOM SÅ! 140 kg squat, NY REKORD — din maskine! 🔥💪' }
        }
    ];

    // Visual themes. The palettes live in styles.css ([data-theme="…"]); these entries
    // drive the picker swatches + the browser theme-color. Keep ids in sync with the CSS
    // and with UserSettings::THEMES on the server. `dark` marks the looks device dark mode may use
    // (keep in step with UserSettings::DARK_THEMES).
    var THEMES = [
        { id: 'aurora',   label: 'Aurora',   bg: '#0f172a', panel: '#16233f', accent: '#38bdf8', text: '#e6edf7', radius: 14, dark: true },
        { id: 'noir',     label: 'Noir',     bg: '#141414', panel: '#242424', accent: '#e0a24e', text: '#eaeaea', radius: 10, dark: true },
        { id: 'paper',    label: 'Paper',    bg: '#f5f5f4', panel: '#ffffff', accent: '#2563eb', text: '#1c1c1c', radius: 10, dark: false },
        { id: 'lavender', label: 'Lavender', bg: '#f3f0fb', panel: '#faf8ff', accent: '#8b5cf6', text: '#2e2545', radius: 16, dark: false },
        { id: 'blush',    label: 'Blush',    bg: '#fdf2f6', panel: '#fffafc', accent: '#ec4899', text: '#3d2233', radius: 18, dark: false },
        { id: 'disco',    label: 'Disco',    bg: '#0d0221', panel: '#2a0e52', accent: '#ff2d95', text: '#ffe9ff', radius: 20, dark: true }
    ];
    // The saved choice is a look's id, or 'auto' = follow the device's light/dark setting (which an iPhone
    // can itself switch at sunset), using the chosen light look by day and the chosen dark look at night.
    var THEME_KEY = 'kachow-theme';
    var THEME_DARK_KEY = 'kachow-theme-dark';
    var THEME_LIGHT_KEY = 'kachow-theme-light';

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function themeById(id) { return THEMES.filter(function (x) { return x.id === id; })[0] || null; }

    // The look in use right now (the CSS attribute) — for 'auto', whichever look the device's mode picked.
    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') || lsGet(THEME_KEY) || 'aurora';
    }
    // What the user chose: a look's id or 'auto'.
    function themeChoice() {
        var c = lsGet(THEME_KEY);
        return c === 'auto' || themeById(c) ? c : currentTheme();
    }
    // The looks 'auto' uses (a stored value of the wrong kind falls back to the default of its kind).
    function themePair() {
        var d = themeById(lsGet(THEME_DARK_KEY)), l = themeById(lsGet(THEME_LIGHT_KEY));
        return { dark: d && d.dark ? d.id : 'aurora', light: l && !l.dark ? l.id : 'paper' };
    }
    function systemDark() {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    function saveSetting(key, value) {
        fetch('/api/settings.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ key: key, value: value })
        }).catch(function () { /* non-fatal — localStorage already holds it */ });
    }

    // Apply a choice everywhere: set the CSS attribute, cache the choice (instant on next load),
    // sync the browser chrome colour, and (when save) persist server-side for other devices.
    function applyTheme(choice, save) {
        var auto = choice === 'auto';
        var pair = themePair();
        var t = themeById(auto ? (systemDark() ? pair.dark : pair.light) : choice) || THEMES[0];
        document.documentElement.setAttribute('data-theme', t.id);
        lsSet(THEME_KEY, auto ? 'auto' : t.id);
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', t.bg);
        if (save) saveSetting('theme', auto ? 'auto' : t.id);
    }

    // Choose the look 'auto' uses at night ('dark') or by day ('light').
    function setThemePair(kind, id, save) {
        lsSet(kind === 'dark' ? THEME_DARK_KEY : THEME_LIGHT_KEY, id);
        if (save) saveSetting(kind === 'dark' ? 'theme_dark' : 'theme_light', id);
        if (themeChoice() === 'auto') applyTheme('auto', false);
    }

    // The device flips between light and dark (sunset, or the user toggles it): follow it live.
    (function followDevice() {
        if (!window.matchMedia) return;
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () { if (lsGet(THEME_KEY) === 'auto') applyTheme('auto', false); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    })();

    // A theme change made from chat arrives as an appearance card — apply it now. (Cards reopened from
    // history never do, so an old card can't flip the look back.)
    function applyAppearanceFromCard(card) {
        if (!card || card.kind !== 'appearance') return;
        if (card.theme_dark) lsSet(THEME_DARK_KEY, card.theme_dark);
        if (card.theme_light) lsSet(THEME_LIGHT_KEY, card.theme_light);
        if (card.theme) applyTheme(card.theme, false);
    }

    function openAppearanceCard() {
        var p = themePair();
        presentCard({ kind: 'appearance', theme: themeChoice(), theme_dark: p.dark, theme_light: p.light });
    }

    function cardIconFor(card) {
        return (CARD_TITLES[card.kind] || [])[0] || 'folder';
    }

    function cardTitleFor(card) {
        var base = (CARD_TITLES[card.kind] || [])[1] || (card.title || 'Card');
        // Attribute a connected person's card (e.g. "Progression · Alex").
        if (card.person && card.person.name) return base + ' · ' + card.person.name;
        return base;
    }

    function cardSubFor(card) {
        if (card.kind === 'training_program') {
            var nw = (card.weeks || []).length;
            return nw + daText(nw === 1 ? ' week' : ' weeks', nw === 1 ? ' uge' : ' uger');
        }
        if (card.kind === 'personality' && card.level) {
            return daText('Level ', 'Niveau ') + card.level + '/5';
        }
        if (card.kind === 'appearance') {
            if (card.theme === 'auto') return daText('Match device', 'Følg enheden');
            var th = THEMES.filter(function (t) { return t.id === (card.theme || currentTheme()); })[0];
            return th ? th.label : '';
        }
        // Minimised header = the card's one-line answer, so it's useful without opening.
        if ((card.kind === 'work_hours' || card.kind === 'work_chart') && card.total) {
            return card.total + (card.range ? ' · ' + card.range : '');
        }
        if (card.kind === 'cycle' && card.has_data) {
            return (card.season_label || '') + ' · ' + daText('day ', 'dag ') + card.cycle_day;
        }
        if (card.kind === 'weather' && card.current && card.current.temp_c != null) {
            return Math.round(card.current.temp_c) + '°';
        }
        if (card.kind === 'chart' && card.title) return card.title;
        if (card.kind === 'calendar_month' && card.month) {
            var mf = new Date(card.month + '-01T12:00:00');
            return isNaN(mf) ? (card.title || '') : mf.toLocaleDateString(daText('en-GB', 'da-DK'), { month: 'long', year: 'numeric' });
        }
        if (card.kind === 'dev_ideas' && card.counts) {
            return (card.counts.new || 0) + ' ' + devStatusLabel('new').toLowerCase() + ' · '
                + (card.counts.in_progress || 0) + ' ' + devStatusLabel('in_progress').toLowerCase();
        }
        if (card.kind === 'scheduled_tasks') {
            var on = (card.items || []).filter(function (t) { return t.status === 'active'; }).length;
            var off = (card.items || []).filter(function (t) { return t.status === 'paused'; }).length;
            var q = (card.requests || []).length;
            return (q ? q + ' ' + daText('waiting for you', 'venter på dig') + ' · ' : '') + on + ' ' + daText('active', 'aktive') + (off ? ' · ' + off + ' ' + daText('paused', 'på pause') : '');
        }
        if (card.kind === 'places') {
            var pc = card.count != null ? card.count : (card.places || []).length;
            return pc + ' ' + (pc === 1 ? daText('place', 'sted') : daText('places', 'steder'));
        }
        if (card.kind === 'location_day') {
            var ls = card.stats || {};
            return (card.title || '') + (ls.points ? ' · ' + ls.distance_km + ' km' : '');
        }
        if (card.kind === 'shopping_list' && Array.isArray(card.items)) {
            var openN = card.items.filter(function (i) { return !i.done; }).length;   // hidden checked don't count
            return openN + (openN === 1 ? ' item' : ' items');
        }
        if (typeof card.remaining === 'number') return card.remaining + ' left';
        if (Array.isArray(card.items)) return card.items.length + (card.items.length === 1 ? ' item' : ' items');
        return '';
    }

    // What the user currently has open (dev idea #42), sent with each chat message so
    // the model can resolve an ambiguous reference ("add one for yesterday") to the
    // visible card without being told its name. Prefers the card's OWN title (e.g. a
    // named list like "Pakkeliste") over the generic per-kind label.
    function currentOpenView() {
        if (!panelCard || !panelCard.kind || !cardPanel || cardPanel.hidden) return null;
        return {
            kind:    panelCard.kind,
            title:   panelCard.title || cardTitleFor(panelCard),
            summary: cardSubFor(panelCard)
        };
    }

    function setPanelState(state) {
        if (!cardPanel) return;
        cardPanel.setAttribute('data-state', state);
        var tgl = document.getElementById('cardPanelToggle');
        if (tgl) tgl.setAttribute('aria-label', state === 'min' ? 'Expand' : 'Minimise');
    }

    function hidePanel() {
        if (!cardPanel) return;
        cardPanel.hidden = true;
        setPanelState('hidden');
        cardPanelBody.innerHTML = '';
        panelKind = null;
        panelCard = null;
        // On desktop the panel is a permanent column (CSS keeps it visible even when
        // "hidden"); reset the header so a cleared column reads as the neutral empty
        // state rather than a stale card title.
        if (cardPanelTitle) cardPanelTitle.textContent = 'Workspace';
        if (cardPanelSub) cardPanelSub.textContent = '';
        renderRail();
    }

    function flashPanel() {
        if (!cardPanel) return;
        cardPanel.classList.remove('cp-flash');
        void cardPanel.offsetWidth;          // reflow so the animation can retrigger
        cardPanel.classList.add('cp-flash');
    }

    // Draw a card into the panel instead of the message stream. Every renderX()
    // appends its node via messages.appendChild(); we briefly redirect that to the
    // panel body, so none of the ~16 renderers need to change. Interactive updates
    // (period toggles, checkboxes) mutate the card in place, so they keep working.
    // mode (from the server's card_mode): 'open' = show it; 'min' = the reply already answers,
    // so on a phone the card waits minimised (header summary, one tap away); undefined =
    // rail/notification opens, which keep the default behaviour below.
    function presentCard(card, mode) {
        if (!card || !card.kind) return;
        if (!cardPanel) { renderCard(card); return; }   // graceful fallback

        var sameKind = (panelKind === card.kind);
        var wasMin   = cardPanel.getAttribute('data-state') === 'min';

        cardPanelBody.innerHTML = '';
        cardPanel.hidden = false;   // visible before drawing, so charts can measure the panel
        var orig = messages.appendChild;
        messages.appendChild = function (node) { return cardPanelBody.appendChild(node); };
        try {
            renderCard(card);
        } finally {
            messages.appendChild = orig;   // restore the real method no matter what
        }

        panelKind = card.kind;
        panelCard = card;
        recordRailCard(card);
        renderRail();
        setIconText(cardPanelTitle, cardIconFor(card), cardTitleFor(card));
        cardPanelSub.textContent   = cardSubFor(card);
        cardPanel.hidden = false;
        // Desktop keeps the card column open. On a phone: an explicit 'open' wins; 'min'
        // prepares it minimised; otherwise respect a deliberate minimise only when the SAME
        // card refreshes — a new kind (or a reopened panel) pops open so you see what changed.
        var desktop = window.matchMedia && window.matchMedia('(min-width: 1024px)').matches;
        if (mode === 'open' || desktop) {
            setPanelState('open');
        } else if (mode === 'min' || (sameKind && wasMin)) {
            setPanelState('min');
        } else {
            setPanelState('open');
        }
        flashPanel();
        // On desktop, every card open (fresh from chat, from the rail, reopened) re-fetches a
        // card that's known to go stale (location/income/receipt/bookkeeping/work hours) so you
        // never land on an old snapshot. No-ops for kinds freshenPanelCard doesn't cover.
        if (desktop) freshenPanelCard();
    }

    // ---- Live refresh of an open work card (desktop) ----------------------------------
    // While a work session is running, re-fetch the open work_hours / work_chart card once a
    // minute and redraw it in place, so the running clock keeps counting on the desktop
    // canvas. Only on desktop, only while the tab is visible, only while the card shows an
    // ongoing session — so it stops by itself after clock-out. Quiet: no flash, no state or
    // rail changes, scroll position kept.
    var LIVE_REFRESH_MS = 60000;

    function workCardIsLive(card) {
        if (!card || card.person) return false;   // a shared card is someone else's clock — never refresh it from ours
        if (card.kind === 'work_hours') return !!card.ongoing;
        if (card.kind === 'work_chart') return (card.bars || []).some(function (b) { return b.ongoing; });
        return false;
    }

    function refetchWorkCard(card) {
        var url, body;
        if (card.kind === 'work_hours') {
            var q = card.query || {};
            url = '/api/work-hours.php';
            body = { period: q.period || undefined, scope: q.scope || (q.period ? undefined : 'today'), date: q.date || undefined,
                to: q.to || undefined, place: q.place || undefined, bucket: q.bucket || undefined };
        } else {
            var f = card.filter || {};
            url = '/api/work-summary.php';
            body = { period: card.mode, place: f.place || undefined, from: f.from || undefined, to: f.to || undefined, bucket: f.bucket || undefined };
        }
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            // Keep the bar the user had tapped, so a refresh doesn't snap the lines back.
            if (j && j.card && card._sel !== undefined) j.card._sel = card._sel;
            return j;
        });
    }

    // Redraw the panel's card without presentCard's side effects.
    function refreshPanelCard(card) {
        if (!cardPanel || !card || card.kind !== panelKind) return;
        var scroll = cardPanelBody.scrollTop;
        cardPanelBody.innerHTML = '';
        var orig = messages.appendChild;
        messages.appendChild = function (node) { return cardPanelBody.appendChild(node); };
        try { renderCard(card); } finally { messages.appendChild = orig; }
        panelCard = card;
        cardPanelSub.textContent = cardSubFor(card);
        cardPanelBody.scrollTop = scroll;
        // Keep the rail's stored copy current too, so switching back never shows old data.
        railRecents.forEach(function (r) { if (r.kind === card.kind) r.card = card; });
    }

    // Re-fetch the card now in the panel if it's one that goes stale (work hours/charts),
    // e.g. right after restoring it from the rail. Other kinds keep their snapshot.
    function freshenPanelCard() {
        var card = panelCard;
        if (card && card.kind === 'location_day' && card.date === locToday()) {
            fetchLocationDay(card.date).then(function (j) {
                if (j && j.card && panelCard === card) refreshPanelCard(j.card);
            }).catch(function () { /* keep the snapshot */ });
            return;
        }
        // Bookkeeping cards change outside the chat (Confirm on the card, an upload, the
        // cockpit) — a reopened snapshot showed an entry as unconfirmed when it was long
        // booked (report #31), so re-read these from the server too.
        var booksUrl = null;
        if (card && card.kind === 'income' && card.id) {
            booksUrl = '/api/books.php?action=entry&id=' + encodeURIComponent(card.id);
        } else if (card && card.kind === 'receipt' && card.id) {
            booksUrl = '/api/books.php?action=expense&id=' + encodeURIComponent(card.id);
        } else if (card && card.kind === 'bookkeeping') {
            booksUrl = '/api/books.php?granularity=' + encodeURIComponent(card.granularity || 'quarter')
                + '&offset=' + encodeURIComponent(card.offset || 0);
        }
        if (booksUrl) {
            fetch(booksUrl, { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    if (j && j.card && panelCard === card) refreshPanelCard(j.card);
                })
                .catch(function () { /* keep the snapshot */ });
            return;
        }

        // Reports are resolved from chat, from other devices and from the card — re-read the list (same status filter).
        if (card && card.kind === 'feedback') {
            fetch('/api/feedback.php?status=' + encodeURIComponent(card.status || 'new') + (card.limit ? '&limit=' + encodeURIComponent(card.limit) : ''), { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    if (j && j.card && panelCard === card) refreshPanelCard(j.card);
                    else if (!j) toast(daText('Could not refresh the reports.', 'Kunne ikke opdatere rapporterne.'));
                })
                .catch(function () { toast(daText('Could not refresh the reports.', 'Kunne ikke opdatere rapporterne.')); });
            return;
        }

        // Scheduled tasks run, pause and resume without the chat noticing — re-read them when the card is reopened.
        if (card && card.kind === 'scheduled_tasks') {
            fetch('/api/scheduled-tasks.php', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) { if (j && j.card && panelCard === card) refreshPanelCard(j.card); })
                .catch(function () { /* keep the snapshot */ });
            return;
        }

        // Dev ideas change status from chat and from the card itself.
        if (card && card.kind === 'dev_ideas') {
            fetch('/api/dev-ideas.php?filter=' + encodeURIComponent(card.filter || 'open'), { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) { if (j && j.card && panelCard === card) refreshPanelCard(j.card); })
                .catch(function () { /* keep the snapshot */ });
            return;
        }

        if (!card || card.person || (card.kind !== 'work_hours' && card.kind !== 'work_chart')) return;
        refetchWorkCard(card).then(function (j) {
            if (j && j.card && panelCard === card) refreshPanelCard(j.card);
        }).catch(function () { /* keep the snapshot */ });
    }

    setInterval(function () {
        var desktop = window.matchMedia && window.matchMedia('(min-width: 1024px)').matches;
        if (!desktop || document.visibilityState !== 'visible' || !cardPanel || cardPanel.hidden) return;
        var card = panelCard;
        if (!workCardIsLive(card)) return;
        refetchWorkCard(card).then(function (j) {
            // Still the same card on screen? (the user may have switched meanwhile)
            if (j && j.card && panelCard === card) refreshPanelCard(j.card);
        }).catch(function () { /* next minute */ });
    }, LIVE_REFRESH_MS);

    (function wireCardPanel() {
        if (!cardPanel) return;
        var head    = document.getElementById('cardPanelHead');
        var close   = document.getElementById('cardPanelClose');
        var tgl     = document.getElementById('cardPanelToggle');
        var expand  = document.getElementById('cardPanelExpand');
        var refresh = document.getElementById('cardPanelRefresh');
        var workspace = document.getElementById('workspace');
        function manualRefresh(e) {
            if (e) e.stopPropagation();
            var ic = refresh ? refresh.querySelector('svg') : null;
            if (ic) ic.classList.add('tl-spin');
            freshenPanelCard();
            setTimeout(function () { if (ic) ic.classList.remove('tl-spin'); }, 500);
        }
        function toggleMin(e) {
            if (e) e.stopPropagation();
            setPanelState(cardPanel.getAttribute('data-state') === 'min' ? 'open' : 'min');
        }
        // Desktop-only: expand the card canvas to the full viewport width (collapse the
        // chat rail) for large widgets, and back. The class does nothing on mobile.
        function toggleExpand(e) {
            if (e) e.stopPropagation();
            if (!workspace) return;
            var full = workspace.classList.toggle('ws-focus-card');
            if (expand) {
                expand.innerHTML = icon(full ? 'minimize-2' : 'maximize-2');
                expand.setAttribute('aria-label', full ? 'Collapse to split view' : 'Expand to full width');
            }
        }
        if (head)    head.addEventListener('click', toggleMin);
        if (tgl)     tgl.addEventListener('click', toggleMin);
        if (expand)  expand.addEventListener('click', toggleExpand);
        if (refresh) refresh.addEventListener('click', manualRefresh);
        if (close)   close.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
    })();

    // Draggable divider: resize the desktop chat rail between 23% and 60% of the width,
    // persisted. Does nothing on mobile (the divider is display:none, so no events fire).
    (function wireSplitter() {
        var workspace = document.getElementById('workspace');
        var divider   = document.getElementById('wsDivider');
        if (!workspace || !divider) return;
        var KEY = 'kachow-chat-w';
        try { var saved = localStorage.getItem(KEY); if (saved) workspace.style.setProperty('--chat-w', saved); } catch (e) { /* private mode */ }

        var dragging = false;
        function onMove(e) {
            if (!dragging) return;
            var rect = workspace.getBoundingClientRect();
            if (rect.width <= 0) return;
            var pct = (e.clientX - rect.left) / rect.width * 100;
            pct = Math.max(23, Math.min(60, pct));
            workspace.style.setProperty('--chat-w', pct.toFixed(1) + '%');
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove('ws-resizing');
            try { localStorage.setItem(KEY, workspace.style.getPropertyValue('--chat-w') || ''); } catch (e) { /* ignore */ }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        }
        divider.addEventListener('pointerdown', function (e) {
            dragging = true;
            document.body.classList.add('ws-resizing');
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
    })();

    // ---- Desktop card rail: staple quick-cards + this session's opened cards ----
    // Staples are always present and open FRESH (live). Recents accumulate the other
    // cards you open (deduped by kind, newest first, max 6) and restore their snapshot.
    var RAIL_STAPLES = [
        { kind: 'bookkeeping', icon: 'book-open', label: 'Books',      open: function () { openBooksFresh(); } },
        { kind: 'moms',        icon: 'percent', label: 'Moms',       open: function () { openMomsFresh(); } },
        { kind: 'cash',        icon: 'landmark', label: 'Cash',       open: function () { openCashFresh(); } },
        { kind: 'pl',          icon: 'trending-up', label: 'P&L',        open: function () { openPlFresh(); } },
        { kind: 'mileage',     icon: 'car', label: 'Mileage',    open: function () { openMileageFresh(); } },
        { kind: 'appearance',  icon: 'palette', label: 'Appearance', open: function () { openAppearanceCard(); } }
    ];
    var railRecents = [];

    // ---- Start cards: the cards the user picked (setting home_cards) open at the start screen and replace the rail's default staples ----
    function cardFromUrl(url, pick) {
        return function () {
            return fetch(url, { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('load failed')); })
                .then(function (j) { return pick ? pick(j) : (j && j.card); });
        };
    }
    var HOME_CARDS = {
        work_hours:      { kind: 'work_hours',      icon: 'clock',         en: "Today's hours",   da: 'Dagens timer',   load: cardFromUrl('/api/card.php?for=work_hours', function (j) { return j && j.card; }) },
        work_week:       { kind: 'work_hours',      icon: 'chart-column',  en: 'Last week',       da: 'Sidste uge',     load: cardFromUrl('/api/card.php?for=work_week', function (j) { return j && j.card; }) },
        work_log:        { kind: 'work_log',        icon: 'notebook-pen',  en: 'Work log',        da: 'Arbejdslog',     load: cardFromUrl('/api/card.php?for=work_log', function (j) { return j && j.card; }) },
        location:        { kind: 'location_day',    icon: 'map-pin',       en: 'Location',        da: 'Lokation',       load: function () { return fetchLocationDay(locToday()).then(function (j) { return j && j.card; }); } },
        calendar:        { kind: 'calendar_month',  icon: 'calendar',      en: 'Calendar',        da: 'Kalender',       load: cardFromUrl('/api/calendar-month.php') },
        cycle:           { kind: 'cycle',           icon: 'moon',          en: 'Cycle',           da: 'Cyklus',         load: cardFromUrl('/api/card.php?for=cycle', function (j) { return j && j.card; }) },
        books:           { kind: 'bookkeeping',     icon: 'book-open',     en: 'Books',           da: 'Regnskab',       load: cardFromUrl('/api/books.php?granularity=quarter&offset=0') },
        moms:            { kind: 'moms',            icon: 'percent',       en: 'Moms',            da: 'Moms',           load: cardFromUrl('/api/moms.php?offset=0') },
        cash:            { kind: 'cash',            icon: 'landmark',      en: 'Cash',            da: 'Kontanter',      load: cardFromUrl('/api/cash.php') },
        pl:              { kind: 'pl',              icon: 'trending-up',   en: 'P&L',             da: 'Resultat',       load: cardFromUrl('/api/pl.php?granularity=year&offset=0') },
        mileage:         { kind: 'mileage',         icon: 'car',           en: 'Mileage',         da: 'Kørsel',         load: cardFromUrl('/api/mileage.php?offset=0') },
        scheduled_tasks: { kind: 'scheduled_tasks', icon: 'repeat',        en: 'Routines & tasks', da: 'Rutiner og opgaver', load: cardFromUrl('/api/scheduled-tasks.php') },
        feedback:        { kind: 'feedback',        icon: 'wrench',        en: 'Reports',         da: 'Rapporter',      load: cardFromUrl('/api/feedback.php') },
        home:            { kind: 'home',            icon: 'house',         en: 'Home',            da: 'Hjem',           load: function () { return Promise.resolve({ kind: 'home', title: 'Home' }); } },
        dev_ideas:       { kind: 'dev_ideas',       icon: 'lightbulb',     en: 'Dev ideas',       da: 'Udviklingsidéer', load: cardFromUrl('/api/dev-ideas.php') }
    };
    var HOME_CARD_ORDER = ['work_hours', 'work_week', 'work_log', 'location', 'calendar', 'cycle', 'books', 'moms', 'cash', 'pl', 'mileage', 'scheduled_tasks', 'feedback', 'dev_ideas', 'home'];
    var homeCards = [];             // the chosen keys, in order ([] = the default rail, nothing opened at start)
    var homeCardsReady = null;      // resolves with homeCards once the saved setting is read

    function cleanHomeCards(list) {
        var out = [];
        (list || []).forEach(function (k) { if (HOME_CARDS[k] && out.indexOf(k) === -1) out.push(k); });
        return out;
    }
    // The start-card picker's list (checkbox + order per row), shared by the ☰ menu modal and the chat card:
    // state.chosen is the ordered keys; every change calls rerender().
    function fillHomeCardsList(list, state, rerender) {
        list.innerHTML = '';
        var rest = HOME_CARD_ORDER.filter(function (k) { return state.chosen.indexOf(k) === -1; });
        state.chosen.concat(rest).forEach(function (k) {
            var on = state.chosen.indexOf(k) !== -1;
            var c = HOME_CARDS[k];
            var li = document.createElement('li');
            li.className = 'hc-row' + (on ? ' is-on' : '');
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = on;
            cb.id = 'hc-' + list.id + '-' + k;
            cb.addEventListener('change', function () {
                if (cb.checked) {
                    state.chosen.push(k);
                } else state.chosen = state.chosen.filter(function (x) { return x !== k; });
                rerender();
            });
            var lab = document.createElement('label');
            lab.htmlFor = cb.id;
            lab.innerHTML = icon(c.icon, 'ic-lead') + progEsc(daText(c.en, c.da)) + (on && state.chosen[0] === k ? ' <small>' + progEsc(daText('opens at start', 'åbner ved start')) + '</small>' : '');
            li.appendChild(cb);
            li.appendChild(lab);
            if (on) {
                var i = state.chosen.indexOf(k);
                [['↑', -1], ['↓', 1]].forEach(function (d) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'hc-move';
                    b.textContent = d[0];
                    b.setAttribute('aria-label', d[1] < 0 ? daText('Move up', 'Flyt op') : daText('Move down', 'Flyt ned'));
                    b.disabled = i + d[1] < 0 || i + d[1] >= state.chosen.length;
                    b.addEventListener('click', function () {
                        var t = state.chosen[i + d[1]]; state.chosen[i + d[1]] = state.chosen[i]; state.chosen[i] = t;
                        rerender();
                    });
                    li.appendChild(b);
                });
            }
            list.appendChild(li);
        });
    }
    // Saves the start cards (same setting on every device) and applies them to the rail; calls done(ok, message).
    function saveHomeCards(value, done) {
        fetch('/api/settings.php', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ key: 'home_cards', value: value })
        })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (r) {
                if (!r.ok || !r.j || !r.j.ok) { done(false, (r.j && r.j.error) || daText('Could not save.', 'Kunne ikke gemme.')); return; }
                homeCards = cleanHomeCards(String(r.j.value || '').split(','));
                renderRail();
                refreshStartTiles();
                done(true, homeCards.length ? daText('Start cards saved.', 'Startkort gemt.') : daText('Back to the default.', 'Tilbage til standard.'));
            })
            .catch(function () { done(false, daText('Network error.', 'Netværksfejl.')); });
    }
    function openHomeCard(key, mode) {
        var c = HOME_CARDS[key];
        if (!c) return Promise.resolve();
        return openLoadedCard(c.kind, c.load(), mode);
    }
    function railStaples() {
        if (!homeCards.length) return RAIL_STAPLES;
        return homeCards.map(function (k) {
            var c = HOME_CARDS[k];
            return { kind: c.kind, icon: c.icon, label: daText(c.en, c.da), open: function () { openHomeCard(k); } };
        });
    }
    function railStapleKinds() { return railStaples().map(function (s) { return s.kind; }); }

    function railInfo(card) {
        return { icon: cardIconFor(card), label: (CARD_TITLES[card.kind] || [])[1] || card.title || card.kind };
    }

    // A card that has to be fetched first opens its panel at once with a spinner, so a slow one (calendar, books …) never looks dead.
    function showPanelLoading(kind) {
        if (!cardPanel) return;
        var t = CARD_TITLES[kind] || [];
        cardPanelBody.innerHTML = '';
        var box = document.createElement('div');
        box.className = 'card-loading';
        box.innerHTML = '<span class="card-loading-spin" aria-hidden="true"></span>';
        var tx = document.createElement('span');
        tx.textContent = daText('Loading…', 'Henter…');
        box.appendChild(tx);
        cardPanelBody.appendChild(box);
        panelKind = kind;
        panelCard = null;
        setIconText(cardPanelTitle, t[0] || 'folder', t[1] || '');
        cardPanelSub.textContent = '';
        cardPanel.hidden = false;
        setPanelState('open');
        renderRail();
    }
    function showPanelLoadFailed() {
        if (!cardPanel || !cardPanelBody.querySelector('.card-loading')) return;
        cardPanelBody.innerHTML = '';
        var d = document.createElement('div');
        d.className = 'card-loading failed';
        d.textContent = daText('Could not load that card.', 'Kunne ikke hente kortet.');
        cardPanelBody.appendChild(d);
    }
    // Fetch a card (a promise of the card), showing the loading state meanwhile.
    var openSeq = 0;
    function openLoadedCard(kind, promise, mode) {
        var mine = ++openSeq;                           // opening another card meanwhile: the slower answer is dropped
        if (mode !== 'min') showPanelLoading(kind);     // a phone's start card stays minimised, nothing to show yet
        return promise.then(function (card) {
            if (mine !== openSeq) return;
            if (card && card.kind) presentCard(card, mode); else showPanelLoadFailed();
        }).catch(function () { if (mine === openSeq) showPanelLoadFailed(); });
    }
    function openFetchedCard(kind, url) {
        openLoadedCard(kind, fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { return j && j.card; }));
    }

    function openBooksFresh() { openFetchedCard('bookkeeping', '/api/books.php?granularity=quarter&offset=0'); }
    function openMomsFresh() { openFetchedCard('moms', '/api/moms.php?offset=0'); }
    function openCashFresh() { openFetchedCard('cash', '/api/cash.php'); }
    function openPlFresh() { openFetchedCard('pl', '/api/pl.php?granularity=year&offset=0'); }
    function openMileageFresh() { openFetchedCard('mileage', '/api/mileage.php?offset=0'); }

    // The Location card flips between a Day and a Places view (kinds location_day / places): in the rail it is ONE entry.
    function railKind(kind) { return kind === 'places' ? 'location_day' : kind; }

    function recordRailCard(card) {
        if (!card || !card.kind) return;
        var kind = railKind(card.kind);
        if (railStapleKinds().indexOf(kind) !== -1) return;   // staples are pinned, not recents
        railRecents = railRecents.filter(function (r) { return r.kind !== kind; });  // dedupe by kind
        var info = railInfo({ kind: kind, title: card.title });
        railRecents.unshift({ kind: kind, icon: info.icon, label: info.label, card: card });
        if (railRecents.length > 6) railRecents = railRecents.slice(0, 6);
    }

    function renderRail() {
        var rail = document.getElementById('cardRail');
        if (!rail) return;
        rail.innerHTML = '';
        function railBtn(iconName, title, active, onClick) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'rail-btn' + (active ? ' is-active' : '');
            b.innerHTML = icon(iconName);
            b.title = title;
            b.setAttribute('aria-label', title);
            b.addEventListener('click', onClick);
            return b;
        }
        railStaples().forEach(function (s) {
            rail.appendChild(railBtn(s.icon, s.label, railKind(panelKind) === s.kind, s.open));
        });
        if (railRecents.length) {
            var sep = document.createElement('div'); sep.className = 'rail-sep'; rail.appendChild(sep);
            railRecents.forEach(function (r) {
                rail.appendChild(railBtn(r.icon, r.label, railKind(panelKind) === r.kind, function () {
                    presentCard(r.card);   // desktop-only rail — presentCard() itself now freshens
                }));
            });
        }
    }

    renderRail();   // seed the rail with staples on load

    // The saved start cards (setting home_cards, same on every device).
    homeCardsReady = fetch('/api/settings.php', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            var raw = j && j.values && j.values.home_cards ? String(j.values.home_cards) : '';
            homeCards = cleanHomeCards(raw.split(','));
            if (homeCards.length) renderRail();
            refreshStartTiles();
            return homeCards;
        })
        .catch(function () { return []; });

    // Display polish: capitalise the first letter of a list item (æøå-aware),
    // without mutating the stored text (matching/dedup rely on the raw value).
    function capFirst(s) {
        s = (s == null ? '' : String(s));
        return s ? s.charAt(0).toLocaleUpperCase('da-DK') + s.slice(1) : s;
    }

    // Render an interactive checklist card. Supports workout plans (days of
    // exercises → /api/workout-plan.php) and shopping lists (items → /api/shopping-list.php).
    function renderCard(card) {
        if (!card || !card.kind) return;

        // Calendar agenda is display-only (read from Google), so it has its own renderer.
        if (card.kind === 'agenda') { renderAgenda(card); return; }
        if (card.kind === 'calendar_month') { renderCalendarMonth(card); return; }
        if (card.kind === 'weather') { renderWeather(card); return; }
        if (card.kind === 'work_hours') { renderWorkHours(card); return; }
        if (card.kind === 'receipt') { renderReceipt(card); return; }
        if (card.kind === 'expenses') { renderExpenses(card); return; }
        if (card.kind === 'income') { renderIncome(card); return; }
        if (card.kind === 'income_summary') { renderIncomeSummary(card); return; }
        if (card.kind === 'owner_draws') { renderOwnerDraws(card); return; }
        if (card.kind === 'bookkeeping') { renderBooks(card); return; }
        if (card.kind === 'moms') { renderMoms(card); return; }
        if (card.kind === 'cash') { renderCash(card); return; }
        if (card.kind === 'pl') { renderPl(card); return; }
        if (card.kind === 'mileage') { renderMileage(card); return; }
        if (card.kind === 'location_day' || card.kind === 'places') { renderLocation(card); return; }
        if (card.kind === 'work_log') { renderWorkLog(card); return; }
        if (card.kind === 'notice') { renderNotice(card); return; }
        if (card.kind === 'email_list') { renderEmailList(card); return; }
        if (card.kind === 'email') { renderEmail(card); return; }
        if (card.kind === 'email_draft') { renderEmailDraft(card); return; }
        if (card.kind === 'cycle') { renderCycle(card); return; }
        if (card.kind === 'progression') { renderProgression(card); return; }
        if (card.kind === 'work_chart') { renderWorkChart(card); return; }
        if (card.kind === 'work_clock') { renderWorkClock(card); return; }
        if (card.kind === 'chart') { renderChart(card); return; }
        if (card.kind === 'feedback') { renderFeedback(card); return; }
        if (card.kind === 'dev_ideas') { renderDevIdeas(card); return; }
        if (card.kind === 'scheduled_tasks') { renderScheduledTasks(card); return; }
        if (card.kind === 'personality') { renderPersonality(card); return; }
        if (card.kind === 'appearance') { renderAppearance(card); return; }
        if (card.kind === 'home_cards') { renderHomeCards(card); return; }
        if (card.kind === 'home') { renderHome(card); return; }
        if (card.kind === 'training_program') { renderTrainingProgram(card); return; }
        if (card.kind === 'shopping_list') { renderShopping(card); return; }
        if (card.kind === 'export_preview') { renderExportPreview(card); return; }

        let sections, endpoint, doneKey;
        if (card.kind === 'workout_plan') {
            endpoint = '/api/workout-plan.php';
            doneKey = 'done';
            sections = (card.days || []).map(function (d) {
                return {
                    head: d.weekday + ' · ' + d.date + (d.plan_title ? ' — ' + d.plan_title : ''),
                    items: d.items || [],
                };
            });
        } else {
            return;
        }

        clearEmptyHint();
        const wrap = document.createElement('div');
        wrap.className = 'plan-card';

        if (card.title) {
            const h = document.createElement('div');
            h.className = 'plan-card-title';
            h.textContent = card.title + (typeof card.remaining === 'number' ? ' · ' + card.remaining + ' left' : '');
            wrap.appendChild(h);
        }
        // Someone else's plan (shared with you): say whose, and keep it look-only below.
        if (card.person && card.person.name) {
            const who = document.createElement('div');
            who.className = 'prog-shared';
            who.textContent = daText('shared by ', 'delt af ') + card.person.name;
            wrap.appendChild(who);
        }

        sections.forEach(function (sec) {
            const secEl = document.createElement('div');
            secEl.className = 'plan-day';
            if (sec.head) {
                const head = document.createElement('div');
                head.className = 'plan-day-head';
                head.textContent = sec.head;
                secEl.appendChild(head);
            }
            if (!sec.items.length) {
                const empty = document.createElement('div');
                empty.className = 'plan-empty';
                empty.textContent = 'Nothing here yet.';
                secEl.appendChild(empty);
            } else {
                const ul = document.createElement('ul');
                ul.className = 'plan-items';
                sec.items.forEach(function (it) {
                    const li = document.createElement('li');
                    if (it.done) li.classList.add('done');
                    const span = document.createElement('span');
                    span.textContent = capFirst(it.label);
                    if (card.readonly) {
                        // A connected person's plan: look, don't tick — it is theirs to change.
                        li.classList.add('ro');
                        const mark = document.createElement('span');
                        mark.className = 'plan-ro-mark';
                        mark.textContent = it.done ? '✓' : '○';
                        mark.setAttribute('aria-label', it.done ? daText('done', 'gjort') : daText('not done yet', 'ikke gjort endnu'));
                        li.appendChild(mark);
                        li.appendChild(span);
                    } else {
                        const label = document.createElement('label');
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = !!it.done;
                        cb.addEventListener('change', function () { toggleCardItem(cb, it.id, endpoint, doneKey); });
                        label.appendChild(cb);
                        label.appendChild(span);
                        li.appendChild(label);
                    }
                    ul.appendChild(li);
                });
                secEl.appendChild(ul);
            }
            wrap.appendChild(secEl);
        });

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Bilingual helper for small card-UI strings (picks from the device language).
    function daText(en, da) {
        return (navigator.language || '').toLowerCase().indexOf('da') === 0 ? da : en;
    }

    // Shopping list: only OPEN items show by default; recently-ticked items (kept ~24h
    // server-side, then purged) hide behind a reveal toggle; and you can add items right
    // on the card without chatting. The card rebuilds in place after each change — ticking
    // an item moves it into the hidden section, adding appends it.
    function renderShopping(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card shopping-card';
        buildShopping(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildShopping(wrap, card) {
        wrap.innerHTML = '';
        var items = card.items || [];
        var open = items.filter(function (it) { return !it.done; });
        var checked = items.filter(function (it) { return it.done; });

        var head = document.createElement('div');
        head.className = 'shop-head';
        var h = document.createElement('div');
        h.className = 'plan-card-title';
        h.textContent = (card.title || 'Shopping list') + (open.length ? ' · ' + open.length + ' left' : '');
        head.appendChild(h);
        // Grouped by category ↔ one flat list, saved per list (older cards without the field get no switch).
        if (card.list_id && (card.grouping === 'auto' || card.grouping === 'none')) {
            var grouped = card.grouping === 'auto';
            var gt = document.createElement('button');
            gt.type = 'button';
            gt.className = 'shop-group-toggle' + (grouped ? ' on' : '');
            gt.setAttribute('role', 'switch');
            gt.setAttribute('aria-checked', grouped ? 'true' : 'false');
            gt.title = daText('Group items by category', 'Grupper varer efter kategori');
            gt.innerHTML = '<span class="sgt-track"><span class="sgt-knob"></span></span>';
            gt.appendChild(document.createTextNode(daText('Grouped', 'Grupperet')));
            gt.addEventListener('click', function () {
                shopPost({ action: 'grouping', list_id: card.list_id, grouping: grouped ? 'none' : 'auto' }, wrap, false);
            });
            head.appendChild(gt);
        }
        wrap.appendChild(head);

        if (!open.length) {
            var empty = document.createElement('div');
            empty.className = 'plan-empty';
            empty.textContent = daText('Nothing on the list.', 'Intet på listen.');
            wrap.appendChild(empty);
        } else {
            // Grouped by supermarket aisle (server-side categories, store-walk order). A list
            // that lands in a single group — or an old card without groups — stays flat.
            var groups = (card.groups || []).filter(function (g) {
                return open.some(function (it) { return it.category === g.key; });
            });
            if (groups.length > 1) {
                // Each aisle is one section, so a wide desktop panel can flow them into
                // columns without splitting a group (on a phone they simply stack).
                var secs = document.createElement('div');
                secs.className = 'shop-secs';
                groups.forEach(function (g) {
                    var sec = document.createElement('div');
                    sec.className = 'shop-sec';
                    var gh = document.createElement('div');
                    gh.className = 'shop-group';
                    setIconText(gh, g.icon, daText(g.en, g.da));
                    sec.appendChild(gh);
                    var gul = document.createElement('ul');
                    gul.className = 'plan-items';
                    open.filter(function (it) { return it.category === g.key; })
                        .forEach(function (it) { gul.appendChild(shoppingLi(it, wrap, card)); });
                    sec.appendChild(gul);
                    secs.appendChild(sec);
                });
                wrap.appendChild(secs);
            } else {
                var ul = document.createElement('ul');
                ul.className = 'plan-items';
                open.forEach(function (it) { ul.appendChild(shoppingLi(it, wrap, card)); });
                wrap.appendChild(ul);
            }
        }

        // Add-item row — type + Enter/＋, no chat round-trip.
        var form = document.createElement('form');
        form.className = 'shop-add';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'shop-add-input';
        inp.placeholder = daText('Add an item…', 'Tilføj en vare…');
        inp.autocomplete = 'off';
        var addBtn = document.createElement('button');
        addBtn.type = 'submit';
        addBtn.className = 'shop-add-btn';
        addBtn.setAttribute('aria-label', daText('Add', 'Tilføj'));
        addBtn.textContent = '＋';
        form.appendChild(inp);
        form.appendChild(addBtn);
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var val = inp.value.trim();
            if (!val) return;
            inp.value = '';
            shopPost({ action: 'add', list_id: card.list_id, item: val }, wrap, true);
        });
        wrap.appendChild(form);

        // Recently-ticked items, hidden behind a reveal toggle (recoverable ~24h).
        if (checked.length) {
            var det = document.createElement('details');
            det.className = 'shop-checked';
            var sum = document.createElement('summary');
            sum.textContent = daText('Show ' + checked.length + ' recently ticked',
                'Vis ' + checked.length + ' krydset af for nylig');
            det.appendChild(sum);
            var cul = document.createElement('ul');
            cul.className = 'plan-items';
            checked.forEach(function (it) { cul.appendChild(shoppingLi(it, wrap, card)); });
            det.appendChild(cul);
            wrap.appendChild(det);
        }
    }

    function shoppingLi(it, wrap, card) {
        var li = document.createElement('li');
        if (it.done) li.classList.add('done');
        var label = document.createElement('label');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!it.done;
        cb.addEventListener('change', function () { shopPost({ item_id: it.id, checked: cb.checked }, wrap, false); });
        var span = document.createElement('span');
        span.textContent = capFirst(it.label);
        label.appendChild(cb);
        label.appendChild(span);
        li.appendChild(label);
        return li;
    }

    function shopPost(body, wrap, refocus) {
        wrap.classList.add('loading');
        return fetch('/api/shopping-list.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
            wrap.classList.remove('loading');
            if (res && res.card) {
                buildShopping(wrap, res.card);
                // Keep the panel's (and rail's) copy current, e.g. after flipping the grouping switch.
                if (panelCard && panelCard.kind === 'shopping_list' && panelCard.list_id === res.card.list_id) {
                    panelCard = res.card;
                    railRecents.forEach(function (r) { if (r.kind === 'shopping_list') r.card = res.card; });
                }
                if (panelKind === 'shopping_list' && cardPanelSub) {
                    var openN = (res.card.items || []).filter(function (i) { return !i.done; }).length;
                    cardPanelSub.textContent = openN + (openN === 1 ? ' item' : ' items');
                }
                if (refocus) {
                    var ni = wrap.querySelector('.shop-add-input');
                    if (ni) ni.focus();
                }
            }
        }).catch(function () { wrap.classList.remove('loading'); });
    }

    // Well-spread hues so distinct calendars are easy to tell apart.
    const CAL_PALETTE = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#fb923c', '#a3e635'];

    // Assign colours by first-appearance order within a card, so the calendars
    // actually shown get maximally-different colours (no hash collisions).
    function makeCalColorMap(days) {
        const map = {};
        let next = 0;
        (days || []).forEach(function (d) {
            (d.events || []).forEach(function (ev) {
                const name = ev.calendar;
                if (name && !(name in map)) {
                    map[name] = CAL_PALETTE[next % CAL_PALETTE.length];
                    next++;
                }
            });
        });
        return map;
    }

    // Month grid: Monday-first weeks; on a wide (desktop) card the cells list the first titles,
    // on a phone they show coloured dots. Tapping a day lists its events under the grid.
    // ‹ › page months via /api/calendar-month.php and rebuild the card in place.
    function renderCalendarMonth(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card cal-month-card';
        buildCalendarMonth(wrap, card, null);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildCalendarMonth(wrap, card, selected) {
        wrap.innerHTML = '';
        var days = card.days || {};
        var month = card.month || '';
        var allDays = Object.keys(days).map(function (k) { return { events: days[k] }; });
        var colors = makeCalColorMap(allDays);
        var da = (navigator.language || '').toLowerCase().indexOf('da') === 0;

        var head = document.createElement('div');
        head.className = 'cm-head';
        var prev = document.createElement('button');
        prev.type = 'button'; prev.className = 'cm-nav'; prev.textContent = '‹';
        prev.setAttribute('aria-label', daText('Previous month', 'Forrige måned'));
        var next = document.createElement('button');
        next.type = 'button'; next.className = 'cm-nav'; next.textContent = '›';
        next.setAttribute('aria-label', daText('Next month', 'Næste måned'));
        var title = document.createElement('div');
        title.className = 'plan-card-title cm-title';
        var first = new Date(month + '-01T12:00:00');
        title.textContent = isNaN(first) ? (card.title || '') : first.toLocaleDateString(da ? 'da-DK' : 'en-GB', { month: 'long', year: 'numeric' });
        head.appendChild(prev); head.appendChild(title); head.appendChild(next);
        wrap.appendChild(head);

        function go(m) {
            wrap.classList.add('loading');
            fetch('/api/calendar-month.php?month=' + encodeURIComponent(m), { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    wrap.classList.remove('loading');
                    if (j && j.card) {
                        buildCalendarMonth(wrap, j.card, null);
                        if (panelCard && panelCard.kind === 'calendar_month') {
                            panelCard = j.card;
                            if (cardPanelSub) cardPanelSub.textContent = cardSubFor(j.card);
                        }
                    } else {
                        toast((j && j.error) || daText('Could not load that month.', 'Kunne ikke hente måneden.'));
                    }
                })
                .catch(function () { wrap.classList.remove('loading'); toast(daText('Network error.', 'Netværksfejl.')); });
        }
        prev.addEventListener('click', function () { if (card.prev) go(card.prev); });
        next.addEventListener('click', function () { if (card.next) go(card.next); });

        var grid = document.createElement('div');
        grid.className = 'cm-grid';
        var wd = da ? ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        wd.forEach(function (w) {
            var h = document.createElement('div');
            h.className = 'cm-wd';
            h.textContent = w;
            grid.appendChild(h);
        });

        var detail = document.createElement('div');
        detail.className = 'cm-detail';

        function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
        function showDay(date, cell) {
            grid.querySelectorAll('.cm-day.sel').forEach(function (c) { c.classList.remove('sel'); });
            if (cell) cell.classList.add('sel');
            detail.innerHTML = '';
            var d = new Date(date + 'T12:00:00');
            var h = document.createElement('div');
            h.className = 'plan-day-head';
            h.textContent = d.toLocaleDateString(da ? 'da-DK' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
            detail.appendChild(h);
            var list = days[date] || [];
            if (!list.length) {
                var e = document.createElement('div');
                e.className = 'plan-empty';
                e.textContent = daText('Nothing scheduled.', 'Intet i kalenderen.');
                detail.appendChild(e);
                return;
            }
            var ul = document.createElement('ul');
            ul.className = 'agenda-items';
            list.forEach(function (ev) {
                var li = document.createElement('li');
                if (ev.all_day) li.classList.add('all-day');
                var t = document.createElement('span');
                t.className = 'agenda-time';
                t.textContent = ev.all_day ? daText('All day', 'Hele dagen') : (ev.time === 'cont.' ? daText('cont.', 'fortsat') : ev.time);
                var body = document.createElement('span');
                body.className = 'agenda-body';
                var ttl = document.createElement('span');
                ttl.className = 'agenda-title';
                if (ev.calendar) {
                    var dot = document.createElement('span');
                    dot.className = 'cal-dot';
                    dot.style.background = colors[ev.calendar];
                    ttl.appendChild(dot);
                }
                ttl.appendChild(document.createTextNode(ev.summary));
                body.appendChild(ttl);
                var meta = [ev.calendar, ev.location].filter(Boolean).join(' · ');
                if (meta) {
                    var m = document.createElement('span');
                    m.className = 'agenda-meta';
                    m.textContent = meta;
                    body.appendChild(m);
                }
                li.appendChild(t); li.appendChild(body);
                ul.appendChild(li);
            });
            detail.appendChild(ul);
        }

        var from = new Date((card.grid_from || month + '-01') + 'T12:00:00');
        var to = new Date((card.grid_to || month + '-28') + 'T12:00:00');
        var todayCell = null;
        for (var d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
            var key = iso(d);
            var evs = days[key] || [];
            var cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cm-day' + (key.slice(0, 7) !== month ? ' out' : '') + (key === card.today ? ' today' : '')
                + (evs.length ? ' has' : '');
            var num = document.createElement('span');
            num.className = 'cm-num';
            num.textContent = d.getDate();
            cell.appendChild(num);
            if (evs.length) {
                var titles = document.createElement('span');
                titles.className = 'cm-titles';
                evs.slice(0, 3).forEach(function (ev) {
                    var t = document.createElement('span');
                    t.className = 'cm-ev' + (ev.all_day ? ' all-day' : '');
                    t.style.borderLeftColor = colors[ev.calendar] || 'var(--accent)';
                    t.textContent = (ev.all_day || ev.time === 'cont.' ? '' : ev.time.slice(0, 5) + ' ') + ev.summary;
                    titles.appendChild(t);
                });
                if (evs.length > 3) {
                    var more = document.createElement('span');
                    more.className = 'cm-more';
                    more.textContent = '+' + (evs.length - 3);
                    titles.appendChild(more);
                }
                cell.appendChild(titles);
                var dots = document.createElement('span');
                dots.className = 'cm-dots';
                evs.slice(0, 4).forEach(function (ev) {
                    var dt = document.createElement('span');
                    dt.className = 'cm-dot';
                    dt.style.background = colors[ev.calendar] || 'var(--accent)';
                    dots.appendChild(dt);
                });
                cell.appendChild(dots);
            }
            cell.setAttribute('aria-label', key + (evs.length ? ', ' + evs.length + ' ' + daText('events', 'begivenheder') : ''));
            (function (k, c) { c.addEventListener('click', function () { showDay(k, c); }); })(key, cell);
            if (key === card.today) todayCell = cell;
            grid.appendChild(cell);
        }
        wrap.appendChild(grid);
        wrap.appendChild(detail);

        // Open on today when it's in this month, else the 1st.
        if (todayCell && card.today && card.today.slice(0, 7) === month) showDay(card.today, todayCell);
        else showDay(selected || month + '-01', grid.querySelector('.cm-day:not(.out)'));
    }

    // Read-only calendar agenda: days, each with a list of events (time + title).
    function renderAgenda(card) {
        clearEmptyHint();
        const wrap = document.createElement('div');
        wrap.className = 'plan-card agenda-card';

        if (card.title) {
            const h = document.createElement('div');
            h.className = 'plan-card-title';
            h.textContent = card.title;
            wrap.appendChild(h);
        }

        const days = card.days || [];
        if (!days.length) {
            const empty = document.createElement('div');
            empty.className = 'plan-empty';
            empty.textContent = 'Nothing scheduled.';
            wrap.appendChild(empty);
            messages.appendChild(wrap);
            messages.scrollTop = messages.scrollHeight;
            return;
        }

        const calColors = makeCalColorMap(days);

        days.forEach(function (d) {
            const dayEl = document.createElement('div');
            dayEl.className = 'plan-day';

            const head = document.createElement('div');
            head.className = 'plan-day-head';
            head.textContent = d.weekday + ' · ' + d.label;
            dayEl.appendChild(head);

            const ul = document.createElement('ul');
            ul.className = 'agenda-items';
            (d.events || []).forEach(function (ev) {
                const li = document.createElement('li');
                if (ev.all_day) li.classList.add('all-day');

                const time = document.createElement('span');
                time.className = 'agenda-time';
                time.textContent = ev.time;

                const body = document.createElement('span');
                body.className = 'agenda-body';

                const title = document.createElement('span');
                title.className = 'agenda-title';
                if (ev.calendar) {
                    // A colour dot keyed to the calendar name — same calendar, same colour.
                    const dot = document.createElement('span');
                    dot.className = 'cal-dot';
                    dot.style.background = calColors[ev.calendar];
                    title.appendChild(dot);
                }
                title.appendChild(document.createTextNode(ev.summary));
                body.appendChild(title);

                // Meta line: which calendar it's from, then location if any.
                const metaBits = [];
                if (ev.calendar) metaBits.push(ev.calendar);
                if (ev.location) metaBits.push(ev.location);
                if (metaBits.length) {
                    const meta = document.createElement('span');
                    meta.className = 'agenda-meta';
                    meta.textContent = metaBits.join(' · ');
                    body.appendChild(meta);
                }

                li.appendChild(time);
                li.appendChild(body);

                // Tap an event to drop a reference to it into the composer, so a
                // follow-up like "move to 4pm" / "delete it" is unambiguous.
                li.tabIndex = 0;
                li.title = 'Tap to ask about this event';
                const pick = function () { prefillEvent(d, ev); };
                li.addEventListener('click', pick);
                li.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
                });

                ul.appendChild(li);
            });
            dayEl.appendChild(ul);
            wrap.appendChild(dayEl);
        });

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Put a plain-language reference to an event into the composer, ready for the
    // user to finish (e.g. "… delete it" / "… move to 16:00"). Enough detail
    // (title + day + start time) for the assistant to find the right event.
    function prefillEvent(day, ev) {
        const start = ev.all_day ? (day.weekday + ' ' + day.label + ' (all day)')
                                 : (day.weekday + ' ' + day.label + ' at ' + String(ev.time).split('–')[0]);
        input.value = 'My "' + ev.summary + '" event on ' + start + ' — ';
        autogrow();
        input.focus();
        // Land the caret at the end so they type straight after the dash.
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) { /* ignore */ }
    }

    // Loose weather-intent check (EN + DA) so we can show a themed waiting animation.
    function looksLikeWeather(text) {
        // Leading \b on each stem so weather words don't match INSIDE unrelated words —
        // e.g. Danish "regn" (rain) must not fire on "afregning" (billing), nor "rain"
        // on "training", nor "storm" on "brainstorm".
        return /(?:\bweather|\bforecast|\btemperature|\brain|\bsnow|\bsunny|\bsun\b|\bwindy|\bcloud|\bstorm|\bdegrees|\bumbrella|\bvejr|\bregn|\bsne|\bsolen|\bsolskin|\btemperatur|\bvind|\bblæs|\bskyet|\bgrader|\bparaply|\bbyge)/i.test(String(text || ''));
    }

    // List rows: date and name as separate parts — read as "date  name" on a phone, and
    // line up as table columns on the desktop card canvas.
    function rowDateName(el, date, name) {
        el.textContent = '';
        var d = document.createElement('span');
        d.className = 'row-date';
        d.textContent = date || '';
        var n = document.createElement('span');
        n.className = 'row-name';
        n.textContent = name || '';
        el.appendChild(d);
        el.appendChild(n);
    }

    function fmtMoney(n, currency) {
        n = Number(n) || 0;
        return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (currency || 'DKK');
    }

    // A clearly-visible delete button (SVG trash in currentColor, red on hover) —
    // beats the low-contrast 🗑 emoji on the dark theme.
    function deleteButton(label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-del';
        b.title = 'Delete';
        b.setAttribute('aria-label', label || 'Delete');
        b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'
            + '<path d="M10 11v6M14 11v6"/></svg>';
        return b;
    }

    // A small download/export icon button (down-arrow into a tray).
    function exportButton(label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-export';
        b.title = 'Export';
        b.setAttribute('aria-label', label || 'Export');
        b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 21h16"/></svg>';
        return b;
    }

    // Triggers a same-origin file download (session cookie is sent) without leaving the page.
    function downloadUrl(url) {
        var a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // Small standalone notice card (e.g. "Expense deleted") so a delete turn shows
    // a clear outcome instead of re-rendering the item as if it still exists.
    // Personality slider card: a 3-stop range (Off / Subtle / Full) that saves the
    // `personality` setting on release and live-previews a sample reply per level.
    function renderPersonality(card) {
        clearEmptyHint();
        var levels = PERSONALITY_LEVELS;
        var idx = levels.map(function (l) { return l.value; }).indexOf(String(card.level || '2'));
        if (idx < 0) idx = 1;

        var wrap = document.createElement('div');
        wrap.className = 'plan-card personality-card';

        var intro = document.createElement('div');
        intro.className = 'persona-intro';
        intro.textContent = daText(
            'How much character should I bring? Slide to taste.',
            'Hvor meget personlighed skal jeg have? Skru efter behov.'
        );
        wrap.appendChild(intro);

        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0'; slider.max = String(levels.length - 1); slider.step = '1';
        slider.value = String(idx);
        slider.className = 'persona-slider';
        wrap.appendChild(slider);

        var ticks = document.createElement('div');
        ticks.className = 'persona-ticks';
        levels.forEach(function (l, i) {
            var t = document.createElement('button');
            t.type = 'button';
            t.className = 'persona-tick';
            t.textContent = daText(l.en.label, l.da.label);
            t.addEventListener('click', function () { slider.value = String(i); apply(i, true); });
            ticks.appendChild(t);
        });
        wrap.appendChild(ticks);

        var blurb = document.createElement('div');
        blurb.className = 'persona-blurb';
        wrap.appendChild(blurb);

        var ex = document.createElement('div');
        ex.className = 'persona-example';
        wrap.appendChild(ex);

        var saving = false;
        function paint(i) {
            var l = levels[i];
            blurb.textContent = daText(l.en.blurb, l.da.blurb);
            ex.textContent = '“' + daText(l.en.ex, l.da.ex) + '”';
            Array.prototype.forEach.call(ticks.children, function (c, j) {
                c.classList.toggle('is-on', j === i);
            });
        }
        function apply(i, save) {
            paint(i);
            card.level = levels[i].value;   // keep the snapshot in sync (panel restore, sub label)
            if (!save || saving) return;
            saving = true;
            fetch('/api/settings.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ key: 'personality', value: levels[i].value })
            }).catch(function () { /* non-fatal — the model reads the setting fresh each turn */ })
              .finally(function () { saving = false; });
        }

        slider.addEventListener('input', function () { paint(parseInt(slider.value, 10) || 0); });
        slider.addEventListener('change', function () { apply(parseInt(slider.value, 10) || 0, true); });

        paint(idx);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Home card: one box per room; inside it one labelled section per SOURCE (Climate = thermostats, Lights = Hue …), each a grid of
    // equal-size tiles. A new kind of device later is one more section. The lights and the (slower) valves load separately, so the
    // rooms appear first and the thermostats fill in. Controls update at once and are sent to /api/home.php; a failed one toasts the
    // reason and re-reads the bridge. A light tile switches on tap; its ⋯ opens the panel (brightness, colour wheel, whites).
    // The Home card's loading animation: a bulb that flickers on and a thermometer whose mercury rises, with changing little messages.
    // kind: 'lights' | 'thermo'. The messages stop by themselves once the loader leaves the page.
    var HOME_CACHE_KEY = 'kachow_home_cache_v1';
    function homeCacheRead() {
        try { var j = JSON.parse(localStorage.getItem(HOME_CACHE_KEY) || 'null'); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
    }
    function homeCacheWrite(part, value) {
        try { var c = homeCacheRead() || {}; c[part] = value; localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(c)); } catch (e) { /* storage blocked: no cache */ }
    }
    var HOME_LOADER_TEXT = {
        lights: [['Waking up the lamps…', 'Vækker lamperne…'], ['Asking the lights nicely…', 'Spørger lysene pænt…'], ['Counting bulbs…', 'Tæller pærer…'], ['Finding the switch in the dark…', 'Leder efter kontakten i mørket…']],
        thermo: [['Warming up the radiators…', 'Varmer radiatorerne op…'], ['The valves are sleepy — one moment…', 'Ventilerne sover — et øjeblik…'], ['Checking the temperature…', 'Tjekker temperaturen…'], ['Asking the thermostats…', 'Spørger termostaterne…']]
    };
    var HOME_BULB_SVG = '<svg class="hl-svg hl-bulb" viewBox="0 0 64 64" aria-hidden="true"><circle class="hl-glow" cx="32" cy="26" r="24"/>'
        + '<g class="hl-rays"><path d="M32 1v4M10 10l3 3M54 10l-3 3M3 28h4M57 28h4"/></g>'
        + '<path class="hl-glass" d="M32 6c-9.4 0-17 7.4-17 16.6 0 6 3 10.2 6.4 13.4 1.8 1.7 2.6 3.2 2.6 5.5V46h16v-2.5c0-2.3.8-3.8 2.6-5.5C46 32.8 49 28.6 49 22.6 49 13.4 41.4 6 32 6z"/>'
        + '<path class="hl-fil" d="M26 25l3 8 3-8 3 8 3-8"/><path class="hl-base" d="M25 49h14M27 54h10M29 59h6"/></svg>';
    var HOME_THERMO_SVG = '<svg class="hl-svg hl-thermo" viewBox="0 0 64 64" aria-hidden="true">'
        + '<g class="hl-heat"><path d="M46 14c-2 2 2 4 0 6M52 10c-2 2 2 4 0 6M52 24c-2 2 2 4 0 6"/></g>'
        + '<rect class="hl-tube" x="25" y="5" width="14" height="40" rx="7"/><circle class="hl-tbulb" cx="32" cy="49" r="11"/>'
        + '<rect class="hl-merc" x="29.5" y="9" width="5" height="40" rx="2.5"/><path class="hl-ticks" d="M42 14h4M42 22h4M42 30h4"/></svg>';
    function homeLoader(kind) {
        var box = document.createElement('div');
        box.className = 'home-loader home-loader-' + kind;
        box.innerHTML = kind === 'lights' ? HOME_BULB_SVG : HOME_THERMO_SVG;
        var tx = document.createElement('span');
        tx.className = 'home-loader-text';
        var list = HOME_LOADER_TEXT[kind], n = Math.floor(Math.random() * list.length);
        function show() { tx.textContent = daText(list[n][0], list[n][1]); }
        show();
        box.appendChild(tx);
        var iv = setInterval(function () {
            if (!box.isConnected) { clearInterval(iv); return; }
            n = (n + 1) % list.length;
            tx.classList.add('is-swap');
            setTimeout(function () { show(); tx.classList.remove('is-swap'); }, 220);
        }, 2600);

        return box;
    }

    var HOME_QUICK_COLORS = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#00c7be', '#0a84ff', '#7d5cff', '#ff5aa5'];

    function hexToHsv(hex) {
        var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
        if (d > 0) {
            if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
            h *= 60; if (h < 0) h += 360;
        }
        return { h: h, s: mx === 0 ? 0 : d / mx, v: mx };
    }
    function hsvToHex(h, s, v) {
        var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
        function t(n) { return ('0' + Math.round((n + m) * 255).toString(16)).slice(-2); }
        return '#' + t(r) + t(g) + t(b);
    }

    function renderHome(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card home-card';
        var head = document.createElement('div');
        head.className = 'home-head';
        var title = document.createElement('div');
        title.className = 'home-title';
        title.textContent = daText('Home', 'Hjem');
        var refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'sched-btn';
        refresh.textContent = daText('Refresh', 'Opdatér');
        var sync = document.createElement('span');
        sync.className = 'home-sync';
        head.appendChild(title);
        head.appendChild(sync);
        head.appendChild(refresh);
        wrap.appendChild(head);
        var body = document.createElement('div');
        body.className = 'home-body';
        wrap.appendChild(body);

        var st = { lights: null, lightsErr: null, thermos: null, thermoErr: null, panel: null, panelShown: null, known: null,
            fresh: { lights: false, thermos: false }, dragging: 0, pending: false };
        // Last-known state is kept in this browser and shown at once, then replaced in place by the fresh answer — the card opens complete
        // and nothing jumps when the (slower) thermostats arrive.
        var cached = homeCacheRead();
        if (cached && cached.lights && cached.lights.rooms) { st.lights = { rooms: cached.lights.rooms, other: cached.lights.other || [] }; st.known = cached.lights.known || null; }
        if (cached && cached.thermos) st.thermos = cached.thermos;
        var timers = {}, last = {};

        function post(payload) {
            return fetch('/api/home.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload)
            }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j && j.ok, j: j || {} }; }); });
        }
        // send one control; on failure say why and re-read what the bridge really has
        function send(payload, after) {
            post(payload).then(function (r) {
                if (r.ok) { if (after) after(r.j); return; }
                toast(r.j.error || daText('Could not do that.', 'Kunne ikke det.'));
                loadLights();
            }).catch(function () { toast(daText('Network error.', 'Netværksfejl.')); loadLights(); });
        }
        function later(key, fn, ms) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms || 400); }
        // at most one send per `ms` while a slider / wheel is dragged, and always the final value
        function throttled(key, fn, ms) {
            var now = Date.now();
            clearTimeout(timers[key]);
            if (!last[key] || now - last[key] >= ms) { last[key] = now; fn(); return; }
            timers[key] = setTimeout(function () { last[key] = Date.now(); fn(); }, ms - (now - last[key]));
        }
        function el(tag, cls, text) {
            var e = document.createElement(tag);
            if (cls) e.className = cls;
            if (text != null) e.textContent = text;
            return e;
        }
        function ic(name) { var s = el('span', 'home-ic'); s.innerHTML = icon(name, ''); return s; }
        function sw(on, onChange, label) {
            var l = el('label', 'sched-switch');
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!on;
            cb.setAttribute('role', 'switch');
            cb.setAttribute('aria-label', label);
            l.appendChild(cb);
            l.appendChild(el('span', 'sched-track'));
            cb.addEventListener('change', function () { onChange(cb.checked); });

            return l;
        }
        function range(min, max, value, cls, onInput, onChange) {
            var r = document.createElement('input');
            r.type = 'range';
            r.min = String(min); r.max = String(max);
            r.value = String(value);
            r.className = 'home-range ' + (cls || '');
            function fill() { r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%'); }   // the filled part of the track
            fill();
            r.addEventListener('input', function () { fill(); if (onInput) onInput(parseInt(r.value, 10)); });
            r.addEventListener('change', function () { onChange(parseInt(r.value, 10)); });

            return r;
        }

        // ---- a light's tile and its panel ----
        function paintLight(l) {
            var t = l._tile;
            if (!t) return;
            t.classList.toggle('is-on', !!l.on);
            if (l.on && l.hex) { t.style.setProperty('--glow', l.hex); } else t.style.removeProperty('--glow');
            var sub = t.querySelector('.home-tile-sub');
            if (sub) sub.textContent = l.on ? (l.brightness != null ? l.brightness + '%' : daText('On', 'Tændt')) : daText('Off', 'Slukket');
            var bar = t.querySelector('.home-bar');
            if (bar) bar.style.width = (l.on && l.brightness != null ? l.brightness : 0) + '%';
        }

        function wheelPanel(l) {
            var box = el('div', 'home-wheel-box');
            var S = 168;
            var wheelWrap = el('div', 'home-wheel');
            var cv = document.createElement('canvas');
            cv.width = S; cv.height = S;
            var ctx = cv.getContext('2d');
            var img = ctx.createImageData(S, S), R = S / 2;
            for (var y = 0; y < S; y++) {
                for (var x = 0; x < S; x++) {
                    var dx = x + 0.5 - R, dy = y + 0.5 - R, rr = Math.sqrt(dx * dx + dy * dy), i = (y * S + x) * 4;
                    if (rr > R) { img.data[i + 3] = 0; continue; }
                    var hex = hsvToHex((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, rr / R), 1);
                    img.data[i] = parseInt(hex.slice(1, 3), 16); img.data[i + 1] = parseInt(hex.slice(3, 5), 16); img.data[i + 2] = parseInt(hex.slice(5, 7), 16); img.data[i + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
            var dot = el('span', 'home-wheel-dot');
            wheelWrap.appendChild(cv);
            wheelWrap.appendChild(dot);
            function place(h, sat) {
                var a = h * Math.PI / 180;
                dot.style.left = (R + Math.cos(a) * sat * R) + 'px';
                dot.style.top = (R + Math.sin(a) * sat * R) + 'px';
                dot.style.setProperty('--dot', hsvToHex(h, sat, 1));   // the dot is filled with the colour it picks
            }
            var cur = l.hex && /^#[0-9a-f]{6}$/i.test(l.hex) ? hexToHsv(l.hex) : { h: 0, s: 0 };
            place(cur.h, cur.s);
            function pick(e, final) {
                var rect = cv.getBoundingClientRect();
                var dx = (e.clientX - rect.left) * (S / rect.width) - R, dy = (e.clientY - rect.top) * (S / rect.height) - R;
                var rr = Math.min(R, Math.sqrt(dx * dx + dy * dy));
                var h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, sat = rr / R;
                place(h, sat);
                var hex = hsvToHex(h, sat, 1);
                l.hex = hex; l.on = true; paintLight(l);
                throttled('c' + l.id, function () { send({ action: 'light', id: l.id, color: hex }); }, 350);
                if (final) later('cf' + l.id, function () { send({ action: 'light', id: l.id, color: hex }); }, 0);
            }
            var drag = false;
            cv.addEventListener('pointerdown', function (e) { drag = true; cv.setPointerCapture(e.pointerId); pick(e, false); });
            cv.addEventListener('pointermove', function (e) { if (drag) pick(e, false); });
            cv.addEventListener('pointerup', function (e) { if (drag) { drag = false; pick(e, true); } });
            box.appendChild(wheelWrap);

            var side = el('div', 'home-wheel-side');
            var quick = el('div', 'home-quick');
            HOME_QUICK_COLORS.forEach(function (c) {
                var q = el('button', 'home-quick-dot');
                q.type = 'button';
                q.style.background = c;
                q.setAttribute('aria-label', c);
                q.addEventListener('click', function () {
                    var hv = hexToHsv(c); place(hv.h, hv.s);
                    l.hex = c; l.on = true; paintLight(l);
                    send({ action: 'light', id: l.id, color: c });
                });
                quick.appendChild(q);
            });
            side.appendChild(quick);
            box.appendChild(side);

            return { box: box, side: side };
        }

        function lightPanel(l) {
            var p = el('div', 'home-panel');
            var top = el('div', 'home-panel-top');
            top.appendChild(el('b', null, l.name));
            var close = el('button', 'home-x', '×');
            close.type = 'button';
            close.setAttribute('aria-label', daText('Close', 'Luk'));
            close.addEventListener('click', function () { closePanel(); });
            top.appendChild(close);
            p.appendChild(top);
            var bits = el('div', 'home-panel-bits');
            if (l.dim) {
                var bl = el('label', 'home-panel-row');
                bl.appendChild(el('span', null, daText('Brightness', 'Lysstyrke')));
                bl.appendChild(range(1, 100, l.brightness == null ? 100 : Math.max(1, l.brightness), 'home-bri',
                    function (v) { l.brightness = v; l.on = true; paintLight(l); throttled('b' + l.id, function () { send({ action: 'light', id: l.id, brightness: v, on: true }); }, 350); },
                    function (v) { l.brightness = v; l.on = true; paintLight(l); send({ action: 'light', id: l.id, brightness: v, on: true }); }));
                bits.appendChild(bl);
            }
            if (l.ct) {
                var wl = el('label', 'home-panel-row');
                wl.appendChild(el('span', null, daText('White', 'Hvid')));
                wl.appendChild(range(153, 500, 366, 'home-white-strip',
                    function (v) { throttled('w' + l.id, function () { send({ action: 'light', id: l.id, mirek: v }); }, 350); },
                    function (v) { l.on = true; paintLight(l); send({ action: 'light', id: l.id, mirek: v }, loadLights); }));
                bits.appendChild(wl);
            }
            if (l.color) {
                var w = wheelPanel(l);
                p.appendChild(w.box);
                w.side.appendChild(bits);
            } else p.appendChild(bits);
            return p;
        }

        function lightTile(l) {
            var t = el('div', 'home-tile home-tile-light');
            l._tile = t;
            var topRow = el('div', 'home-tile-top');
            topRow.appendChild(ic('lightbulb'));
            if (l.dim || l.color || l.ct) {
                var more = el('button', 'home-more');
                more.type = 'button';
                more.innerHTML = icon('sliders-horizontal', '');
                more.setAttribute('aria-label', daText('Brightness and colour', 'Lysstyrke og farve'));
                more.addEventListener('click', function (e) { e.stopPropagation(); if (st.panel === l.id) closePanel(); else { st.panel = l.id; draw(); } });
                topRow.appendChild(more);
            }
            t.appendChild(topRow);
            t.appendChild(el('div', 'home-tile-name', l.name));
            t.appendChild(el('div', 'home-tile-sub'));
            t.appendChild(el('div', 'home-bar'));
            t.setAttribute('role', 'button');
            t.tabIndex = 0;
            function toggle() { l.on = !l.on; paintLight(l); send({ action: 'light', id: l.id, on: l.on }); }
            t.addEventListener('click', toggle);
            t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
            if (st.panel === l.id) t.classList.add('is-selected');
            paintLight(l);

            return t;
        }

        // ---- a thermostat's tile ----
        function thermoTile(t) {
            var box = el('div', 'home-tile home-tile-heat');
            box.appendChild(el('div', 'home-tile-top')).appendChild(ic('thermometer'));
            box.appendChild(el('div', 'home-tile-name', t.name));
            if (t.placeholder) {                       // the valve has not answered yet: same-size tile, so nothing moves when it does
                box.classList.add('is-placeholder');
                box.appendChild(el('div', 'home-big home-skel', '··'));
                box.appendChild(el('div', 'home-skel-bar'));

                return box;
            }
            if (t.error) {
                box.appendChild(el('div', 'home-tile-sub', daText('No answer', 'Intet svar')));

                return box;
            }
            box.appendChild(el('div', 'home-big', (t.current_c != null ? Number(t.current_c).toFixed(1) : '–') + '°'));
            var ctl = el('div', 'home-thermo-ctl');
            var minus = el('button', 'home-step', '−');
            var plus = el('button', 'home-step', '+');
            minus.type = plus.type = 'button';
            var target = el('span', 'home-thermo-target');
            var status = el('div', 'home-tile-sub');
            t._statusEl = status;                 // the CURRENT element: a redraw while a send is pending must not strand the answer
            function showTarget() { target.textContent = daText('set ', 'sat ') + (t.target_c != null ? Number(t.target_c).toFixed(1) : '–') + '°'; }
            function step(d) {
                var v = (t.target_c != null ? Number(t.target_c) : (t.current_c != null ? t.current_c : 20)) + d;
                t.target_c = Math.max(4, Math.min(30, Math.round(v * 2) / 2));
                showTarget();
                t.status = daText('sending…', 'sender…');
                t._statusEl.textContent = t.status;
                later('t' + t.id, function () {
                    send({ action: 'thermostat', id: String(t.id), target: t.target_c }, function (j) {
                        // kept on the thermostat itself: a redraw (a light changed) must not wipe it
                        t.status = j.set === 'sent' ? daText('sent — valve confirms soon', 'sendt — ventilen bekræfter snart') : daText('set', 'sat');
                        t._statusEl.textContent = t.status;
                    });
                }, 900);
            }
            minus.addEventListener('click', function () { step(-0.5); });
            plus.addEventListener('click', function () { step(0.5); });
            ctl.appendChild(minus); ctl.appendChild(target); ctl.appendChild(plus);
            box.appendChild(ctl);
            var meta = [];
            if (t.valve_open_pct != null) meta.push(t.valve_open_pct + daText('% open', '% åben'));
            if (t.last_heard_minutes_ago != null) meta.push(t.last_heard_minutes_ago + ' min');
            if (t.battery_pct != null && t.battery_pct < 25) meta.push(daText('battery ', 'batteri ') + t.battery_pct + '%');
            status.textContent = t.status || meta.join(' · ');
            box.appendChild(status);
            showTarget();

            return box;
        }

        // ---- boxes and sections ----
        // A section = one source of devices in a room: a label with its icon, then equal-size tiles. The light panel opens right under the
        // tile it belongs to, as a full-width row of the same grid.
        function section(kind, label, iconName, tiles) {
            var sec = el('div', 'home-section home-section-' + kind);
            var h = el('div', 'home-section-head');
            h.appendChild(ic(iconName));
            h.appendChild(el('span', null, label));
            sec.appendChild(h);
            var grid = el('div', 'home-tiles');
            grid.style.setProperty('--n', String(Math.min(2, tiles.length)));   // a source with a few tiles takes just their width
            tiles.forEach(function (x) { grid.appendChild(x); });
            sec.appendChild(grid);

            return sec;
        }
        function lightSection(lights) {
            return section('lights', daText('Lights', 'Lys'), 'lightbulb', lights.map(lightTile));
        }
        // The light panel opens BELOW the whole room's tiles, so nothing moves when it opens or closes; it slides open and shut.
        function panelFor(lights) {
            var l = lights.filter(function (x) { return x.id === st.panel; })[0];
            if (!l) return null;
            var wrapEl = el('div', 'home-panel-wrap');
            var clip = el('div', 'home-panel-clip');
            clip.appendChild(lightPanel(l));
            wrapEl.appendChild(clip);
            if (st.panelShown === l.id) wrapEl.classList.add('is-open');      // a redraw while it is open: stay open, no replay
            else {
                requestAnimationFrame(function () { requestAnimationFrame(function () { wrapEl.classList.add('is-open'); }); });
                setTimeout(function () { if (wrapEl.isConnected && wrapEl.scrollIntoView) wrapEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 260);
            }
            st.panelShown = l.id;

            return wrapEl;
        }
        function closePanel() {
            var w = body.querySelector('.home-panel-wrap');
            st.panel = null;
            st.panelShown = null;
            if (!w) { draw(); return; }
            w.classList.remove('is-open');
            setTimeout(draw, 230);
        }

        // A room box's natural width (tiles are 160 px wide, 8 px apart, sections 20 px apart, 16 px padding + border each side): rooms pack into
        // rows by this width, so two small rooms share a row, and a roomy one still gets Climate and Lights side by side.
        function roomWidth(nClimate, nLights) {
            function cols(k) { return k > 0 ? k * 160 + (k - 1) * 8 : 0; }
            var c = cols(Math.min(2, nClimate)), l = cols(Math.min(6, nLights));

            return Math.max(232, 32 + c + (c && l ? 20 : 0) + l);
        }
        function draw() {
            body.innerHTML = '';
            var used = {};
            var thermos = st.thermos || (st.known || []).map(function (k) { return { name: k.name, id: k.id, room: k.room, placeholder: true }; });
            body.classList.toggle('is-stale-lights', !!st.lights && !st.fresh.lights);
            body.classList.toggle('is-stale-thermos', !!st.thermos && !st.fresh.thermos);
            sync.textContent = (st.fresh.lights && st.fresh.thermos) ? '' : daText('updating…', 'opdaterer…');
            function thermosFor(roomName) {
                return thermos.filter(function (t) { return String(t.room || '').toLowerCase() === String(roomName).toLowerCase(); });
            }
            if (st.lightsErr) body.appendChild(el('div', 'home-note', daText('Lights: ', 'Lys: ') + st.lightsErr));
            if (!st.lights && !st.lightsErr) body.appendChild(homeLoader('lights'));
            if (st.lights) {
                st.lights.rooms.forEach(function (room) {
                    var box = el('div', 'home-room' + (room.on ? ' is-on' : ''));
                    var h = el('div', 'home-room-head');
                    h.appendChild(el('span', 'home-room-name', room.name));
                    var onCount = room.lights.filter(function (l) { return l.on; }).length;
                    if (room.lights.length) h.appendChild(el('span', 'home-room-count', onCount + '/' + room.lights.length + daText(' on', ' tændt')));
                    if (room.group_id) h.appendChild(sw(room.on, function (on) { room.on = on; send({ action: 'group', id: room.group_id, on: on }, loadLights); }, room.name));
                    box.appendChild(h);
                    if (room.group_id && room.brightness != null) {
                        box.appendChild(range(1, 100, Math.max(1, room.brightness), 'home-room-range',
                            null, function (v) { room.on = true; send({ action: 'group', id: room.group_id, brightness: v, on: true }, loadLights); }));
                    }
                    var ts = thermosFor(room.name);
                    ts.forEach(function (t) { used[t.id] = true; });
                    var secs = el('div', 'home-sections');   // the sources of a room share a row when there is space
                    if (ts.length) secs.appendChild(section('climate', daText('Climate', 'Klima'), 'thermometer', ts.map(thermoTile)));
                    if (room.lights.length) secs.appendChild(lightSection(room.lights));
                    box.appendChild(secs);
                    box.style.flexBasis = roomWidth(ts.length, room.lights.length) + 'px';
                    var pnl = panelFor(room.lights);
                    if (pnl) box.appendChild(pnl);
                    body.appendChild(box);
                });
            }
            if (st.thermoErr) body.appendChild(el('div', 'home-note', daText('Thermostats: ', 'Termostater: ') + st.thermoErr));
            if (!st.thermos && !st.thermoErr && !(st.known && st.known.length)) body.appendChild(homeLoader('thermo'));
            var rest = thermos.filter(function (t) { return !used[t.id]; });
            var other = st.lights ? st.lights.other : [];
            if (rest.length || other.length) {
                var ob = el('div', 'home-room');
                ob.appendChild(el('div', 'home-room-head')).appendChild(el('span', 'home-room-name', daText('Other', 'Andet')));
                var osecs = el('div', 'home-sections');
                if (rest.length) osecs.appendChild(section('climate', daText('Climate', 'Klima'), 'thermometer', rest.map(thermoTile)));
                if (other.length) osecs.appendChild(lightSection(other));
                ob.appendChild(osecs);
                ob.style.flexBasis = roomWidth(rest.length, other.length) + 'px';
                var opnl = panelFor(other);
                if (opnl) ob.appendChild(opnl);
                body.appendChild(ob);
            }
        }

        function getPart(part) {
            return fetch('/api/home.php?part=' + part, { credentials: 'same-origin' })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j && j.ok, j: j || {} }; }); });
        }
        // a redraw while a slider or the wheel is being dragged would cut the gesture off: it waits for the pointer to be released
        function redraw() { if (st.dragging) st.pending = true; else draw(); }
        body.addEventListener('pointerdown', function () { st.dragging = 1; }, true);
        function released() {
            if (!wrap.isConnected) { document.removeEventListener('pointerup', released); document.removeEventListener('pointercancel', released); return; }
            if (st.dragging) { st.dragging = 0; if (st.pending) { st.pending = false; draw(); } }
        }
        document.addEventListener('pointerup', released);
        document.addEventListener('pointercancel', released);

        function loadLights() {
            getPart('lights').then(function (r) {
                if (r.ok) {
                    homeCacheWrite('lights', { rooms: r.j.rooms || [], other: r.j.other || [], known: r.j.thermostats_known || null });
                    st.lights = { rooms: r.j.rooms || [], other: r.j.other || [] };
                    st.known = r.j.thermostats_known || null;
                    st.lightsErr = null;
                    st.fresh.lights = true;
                } else st.lightsErr = r.j.error || daText('could not load', 'kunne ikke hentes');
                redraw();
            }).catch(function () { st.lightsErr = daText('network error', 'netværksfejl'); redraw(); });
        }
        function loadThermos() {
            getPart('thermostats').then(function (r) {
                if (r.ok) {
                    homeCacheWrite('thermos', r.j.thermostats || []);
                    st.thermos = r.j.thermostats || [];
                    st.thermoErr = null;
                    st.fresh.thermos = true;
                } else st.thermoErr = r.j.error || daText('could not load', 'kunne ikke hentes');
                redraw();
            }).catch(function () { st.thermoErr = daText('network error', 'netværksfejl'); redraw(); });
        }
        refresh.addEventListener('click', function () { st.fresh.lights = false; st.fresh.thermos = false; draw(); loadLights(); loadThermos(); });

        draw();
        loadLights();
        loadThermos();
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Training programme card: a programme's weeks as chips, the chosen week's days with their exercises — for checking what the assistant saved
    // from a note. Read-only; changes go through the chat.
    // A preview of an export (timesheet / table): the printable page in a frame, with buttons to open it (print / save as PDF) and to download the CSV.
    function renderExportPreview(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card ep-card';
        var head = document.createElement('div');
        head.className = 'ep-head';
        var name = document.createElement('div');
        name.className = 'ep-name';
        name.textContent = card.title || daText('Export', 'Eksport');
        head.appendChild(name);
        var actions = document.createElement('div');
        actions.className = 'ep-actions';
        var pdf = document.createElement('button');
        pdf.type = 'button';
        pdf.className = 'ep-btn is-main';
        setIconText(pdf, 'file-down', 'PDF');
        pdf.addEventListener('click', function () { downloadUrl(card.pdf_url); });
        actions.appendChild(pdf);
        var open = document.createElement('a');
        open.className = 'ep-btn';
        open.href = card.print_url || '#';
        open.target = '_blank';
        open.rel = 'noopener';
        setIconText(open, 'file-text', daText('Open', 'Åbn'));
        actions.appendChild(open);
        var csv = document.createElement('button');
        csv.type = 'button';
        csv.className = 'ep-btn';
        csv.textContent = 'CSV';
        csv.addEventListener('click', function () { downloadUrl(card.csv_url); });
        actions.appendChild(csv);
        head.appendChild(actions);
        wrap.appendChild(head);
        if (card.summary) {
            var sum = document.createElement('div');
            sum.className = 'ep-sum';
            sum.textContent = card.summary;
            wrap.appendChild(sum);
        }
        var frame = document.createElement('iframe');
        frame.className = 'ep-frame';
        frame.title = card.title || 'Export';
        frame.loading = 'lazy';
        frame.src = (card.print_url || '') + '&embed=1';
        wrap.appendChild(frame);
        messages.appendChild(wrap);
    }

    function renderTrainingProgram(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card tp-card';
        var p = card.program || {};
        var head = document.createElement('div');
        head.className = 'tp-head';
        var name = document.createElement('div');
        name.className = 'tp-name';
        name.textContent = p.name || card.title || daText('Programme', 'Program');
        head.appendChild(name);
        var pill = document.createElement('span');
        pill.className = 'sched-pill' + (p.status === 'active' ? '' : ' draft');
        pill.textContent = p.status === 'active' ? daText('Active', 'Aktiv') : daText('Archived', 'Arkiveret');
        head.appendChild(pill);
        wrap.appendChild(head);
        var meta = document.createElement('div');
        meta.className = 'tp-meta';
        meta.textContent = p.week_mode === 'relative'
            ? daText('Week 1, 2, 3 … from ', 'Uge 1, 2, 3 … fra ') + (p.start_date || '?') + (p.repeat_weeks ? daText(', repeats every ', ', gentages hver ') + p.repeat_weeks + daText(' weeks', '. uge') : '')
            : daText('Calendar weeks', 'Kalenderuger');
        wrap.appendChild(meta);

        var weeks = card.weeks || [];
        if (!weeks.length) {
            var empty = document.createElement('div');
            empty.className = 'prog-empty';
            empty.textContent = daText('No days in this programme yet.', 'Ingen dage i dette program endnu.');
            wrap.appendChild(empty);
            messages.appendChild(wrap);
            return;
        }
        var today = card.today || {};
        var sel = 0;
        weeks.forEach(function (w, i) { if (w.week === today.week) sel = i; });
        var chips = document.createElement('div');
        chips.className = 'tp-weeks';
        var body = document.createElement('div');
        body.className = 'tp-body';
        function weekLabel(w) { return (p.week_mode === 'relative' ? daText('Week ', 'Uge ') : daText('Wk ', 'Uge ')) + w.week; }
        function draw() {
            chips.innerHTML = '';
            weeks.forEach(function (w, i) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'tp-week' + (i === sel ? ' is-on' : '') + (w.week === today.week ? ' is-now' : '');
                b.textContent = weekLabel(w);
                b.addEventListener('click', function () { sel = i; draw(); });
                chips.appendChild(b);
            });
            body.innerHTML = '';
            var w = weeks[sel];
            w.days.forEach(function (d) {
                var row = document.createElement('div');
                row.className = 'tp-day' + (w.week === today.week && d.weekday === today.weekday ? ' is-today' : '');
                var h = document.createElement('div');
                h.className = 'tp-day-head';
                var dn = document.createElement('b');
                dn.textContent = daText(d.name, ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'][d.weekday - 1] || d.name);
                h.appendChild(dn);
                if (d.title) { var tt = document.createElement('span'); tt.textContent = ' · ' + d.title; h.appendChild(tt); }
                row.appendChild(h);
                var ul = document.createElement('ul');
                (d.items || []).forEach(function (it) { var li = document.createElement('li'); li.textContent = it; ul.appendChild(li); });
                row.appendChild(ul);
                if (d.note) { var nt = document.createElement('div'); nt.className = 'tp-note'; nt.textContent = d.note; row.appendChild(nt); }
                body.appendChild(row);
            });
        }
        wrap.appendChild(chips);
        wrap.appendChild(body);
        draw();
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Start-cards card (chat): pick which cards open at start and stay one tap away, and in what order.
    function renderHomeCards(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card homecards-card';
        var intro = document.createElement('div');
        intro.className = 'persona-intro';
        intro.textContent = daText('Pick the cards you want. The first opens when the app starts; the rest stay one tap away.',
            'Vælg de kort du vil have. Det første åbner når appen starter; resten er et tryk væk.');
        wrap.appendChild(intro);
        var list = document.createElement('ul');
        list.className = 'hc-list';
        list.id = 'hcc' + Date.now();
        wrap.appendChild(list);
        var state = { chosen: cleanHomeCards(card.chosen || []) };
        function draw() { fillHomeCardsList(list, state, draw); card.chosen = state.chosen.slice(); }
        draw();
        var actions = document.createElement('div');
        actions.className = 'sched-actions';
        function btn(label, cls, value) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'sched-btn' + (cls ? ' ' + cls : '');
            b.textContent = label;
            b.addEventListener('click', function () {
                b.disabled = true;
                saveHomeCards(value(), function (ok, msg) {
                    toast(msg);
                    b.disabled = false;
                    if (ok && value() === '') { state.chosen = []; draw(); }
                });
            });
            actions.appendChild(b);
        }
        btn(daText('Save', 'Gem'), 'primary', function () { return state.chosen.join(','); });
        btn(daText('Back to default', 'Tilbage til standard'), '', function () { return ''; });
        wrap.appendChild(actions);
        wrap.appendChild(shortcutBox());
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // "Home-screen shortcut": pick a card, get a link that opens the app straight on it. On iPhone: open the link in Safari →
    // Share → Add to Home Screen (it gets its own icon); on Android the same, or long-press the app icon for the built-in ones.
    function shortcutBox() {
        var box = document.createElement('details');
        box.className = 'hc-shortcut';
        var sum = document.createElement('summary');
        sum.textContent = daText('Home-screen shortcut', 'Genvej på hjemmeskærmen');
        box.appendChild(sum);
        var row = document.createElement('div');
        row.className = 'hc-sc-row';
        var sel = document.createElement('select');
        sel.className = 'hc-sc-select';
        HOME_CARD_ORDER.forEach(function (k) {
            var o = document.createElement('option');
            o.value = k;
            o.textContent = daText(HOME_CARDS[k].en, HOME_CARDS[k].da);
            sel.appendChild(o);
        });
        var link = document.createElement('input');
        link.type = 'text';
        link.readOnly = true;
        link.className = 'hc-sc-link';
        function url() { return location.origin + '/?open=' + encodeURIComponent(sel.value); }
        function sync() { link.value = url(); }
        sel.addEventListener('change', sync);
        sync();
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'sched-btn';
        copy.textContent = daText('Copy link', 'Kopiér link');
        copy.addEventListener('click', function () {
            function done() { toast(daText('Link copied', 'Link kopieret')); }
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url()).then(done, function () { link.select(); });
            else { link.select(); try { document.execCommand('copy'); done(); } catch (e) { /* the text is selected */ } }
        });
        var open = document.createElement('a');
        open.className = 'sched-btn';
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = daText('Open', 'Åbn');
        function syncOpen() { open.href = url(); }
        sel.addEventListener('change', syncOpen);
        syncOpen();
        row.appendChild(sel);
        row.appendChild(link);
        row.appendChild(copy);
        row.appendChild(open);
        box.appendChild(row);
        var how = document.createElement('div');
        how.className = 'persona-intro';
        how.textContent = daText('iPhone: open the link in Safari → Share → Add to Home Screen. Android: the browser menu → Add to Home screen (or long-press the Kachow icon for the built-in shortcuts).',
            'iPhone: åbn linket i Safari → Del → Føj til hjemmeskærm. Android: browsermenuen → Føj til startskærm (eller hold fingeren på Kachow-ikonet for de indbyggede genveje).');
        box.appendChild(how);
        return box;
    }

    // Appearance picker card: "Match my device" (light by day, dark at night) or one fixed look. Each swatch
    // mimics its theme (bg + a panel chip with accent dot + text bar, and its corner rounding), so you can see
    // the look before committing. With the switch on there are two pickers — the look for light mode and the
    // look for dark mode; off, one picker with all six.
    function renderAppearance(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card appearance-card';

        var intro = document.createElement('div');
        intro.className = 'persona-intro';
        intro.textContent = daText('Pick a look — tap to apply it instantly.',
            'Vælg et udseende — tryk for at anvende det med det samme.');
        wrap.appendChild(intro);

        var box = document.createElement('div');
        box.className = 'theme-box';
        wrap.appendChild(box);

        var pair = { dark: card.theme_dark || themePair().dark, light: card.theme_light || themePair().light };
        var auto = (card.theme || themeChoice()) === 'auto';

        function syncSub() {
            card.theme = auto ? 'auto' : currentTheme();
            card.theme_dark = pair.dark;
            card.theme_light = pair.light;
            if (cardPanelSub && panelKind === 'appearance') cardPanelSub.textContent = cardSubFor(card);
        }

        function swatch(t, on, onPick) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'theme-opt' + (on ? ' is-on' : '');
            b.style.background = t.bg;
            b.style.borderRadius = Math.max(8, Math.min(t.radius, 16)) + 'px';
            var panel = document.createElement('span');
            panel.className = 'theme-pv-panel';
            panel.style.background = t.panel;
            panel.style.borderRadius = Math.round(t.radius / 2) + 'px';
            var dot = document.createElement('span');
            dot.className = 'theme-pv-dot';
            dot.style.background = t.accent;
            var bar = document.createElement('span');
            bar.className = 'theme-pv-bar';
            bar.style.background = t.text;
            panel.appendChild(dot);
            panel.appendChild(bar);
            b.appendChild(panel);
            var name = document.createElement('span');
            name.className = 'theme-name';
            name.style.color = t.text;
            name.textContent = t.label;
            b.appendChild(name);
            b.addEventListener('click', onPick);
            return b;
        }

        function group(headText, themes, selectedId, onPick) {
            var head = document.createElement('div');
            head.className = 'theme-group-head';
            head.textContent = headText;
            box.appendChild(head);
            var grid = document.createElement('div');
            grid.className = 'theme-grid';
            themes.forEach(function (t) { grid.appendChild(swatch(t, t.id === selectedId, function () { onPick(t); })); });
            box.appendChild(grid);
        }

        function build() {
            box.innerHTML = '';

            // The switch row.
            var row = document.createElement('label');
            row.className = 'theme-auto';
            var text = document.createElement('span');
            text.className = 'theme-auto-text';
            var h = document.createElement('b');
            h.textContent = daText('Match my device', 'Følg min enhed');
            var sub = document.createElement('span');
            sub.textContent = daText('Light by day, dark at night — follows your phone\'s appearance setting (on an iPhone: Settings › Display & Brightness › Automatic).',
                'Lys om dagen, mørk om natten — følger din telefons udseende-indstilling (på iPhone: Indstillinger › Skærm og lysstyrke › Automatisk).');
            text.appendChild(h);
            text.appendChild(sub);
            var sw = document.createElement('span');
            sw.className = 'switch';
            var input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = auto;
            var slider = document.createElement('span');
            slider.className = 'slider';
            sw.appendChild(input);
            sw.appendChild(slider);
            row.appendChild(text);
            row.appendChild(sw);
            input.addEventListener('change', function () {
                auto = input.checked;
                if (auto) {
                    // The look in use becomes the look for its own kind of mode; save the pair, then follow the device.
                    var cur = themeById(currentTheme());
                    if (cur) { if (cur.dark) pair.dark = cur.id; else pair.light = cur.id; }
                    setThemePair('dark', pair.dark, true);
                    setThemePair('light', pair.light, true);
                    applyTheme('auto', true);
                } else {
                    applyTheme(currentTheme(), true);   // freeze whatever the device mode gave us right now
                }
                syncSub();
                build();
            });
            box.appendChild(row);

            if (auto) {
                group(daText('Light look', 'Lyst udseende'), THEMES.filter(function (t) { return !t.dark; }), pair.light, function (t) {
                    pair.light = t.id; setThemePair('light', t.id, true); syncSub(); build();
                });
                group(daText('Dark look', 'Mørkt udseende'), THEMES.filter(function (t) { return t.dark; }), pair.dark, function (t) {
                    pair.dark = t.id; setThemePair('dark', t.id, true); syncSub(); build();
                });
                var now = document.createElement('div');
                now.className = 'theme-now';
                var inUse = themeById(currentTheme());
                now.textContent = daText('Right now: ', 'Lige nu: ') + (systemDark() ? daText('dark', 'mørk') : daText('light', 'lys'))
                    + (inUse ? ' · ' + inUse.label : '');
                box.appendChild(now);
            } else {
                group(daText('Look', 'Udseende'), THEMES, currentTheme(), function (t) {
                    applyTheme(t.id, true); syncSub(); build();
                });
            }
        }
        build();

        // Card text size — per device (a phone wants it smaller than a desktop), so it's
        // kept in localStorage, not the server. Default: Compact on phones, Normal on desktop.
        var sizeHead = document.createElement('div');
        sizeHead.className = 'persona-intro appearance-sub';
        sizeHead.textContent = daText('Card size on this device', 'Kortstørrelse på denne enhed');
        wrap.appendChild(sizeHead);
        var seg = document.createElement('div');
        seg.className = 'prog-seg';
        var curSize = currentCardSize();
        CARD_SIZES.forEach(function (z) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'prog-seg-btn' + (z.id === curSize ? ' on' : '');
            b.textContent = daText(z.en, z.da);
            b.addEventListener('click', function () {
                applyCardSize(z.id);
                Array.prototype.forEach.call(seg.children, function (c) { c.classList.remove('on'); });
                b.classList.add('on');
            });
            seg.appendChild(b);
        });
        wrap.appendChild(seg);

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    var CARD_SIZES = [
        { id: 'normal',  en: 'Normal',  da: 'Normal' },
        { id: 'compact', en: 'Compact', da: 'Kompakt' },
        { id: 'small',   en: 'Small',   da: 'Lille' }
    ];
    var CARD_SIZE_KEY = 'kachow-card-size';

    function currentCardSize() {
        var z = document.documentElement.getAttribute('data-card-size');
        if (z) return z;
        return (window.matchMedia && window.matchMedia('(min-width: 1024px)').matches) ? 'normal' : 'compact';
    }

    function applyCardSize(id) {
        document.documentElement.setAttribute('data-card-size', id);
        try { localStorage.setItem(CARD_SIZE_KEY, id); } catch (e) { /* private mode */ }
    }

    function renderNotice(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card notice-card' + (card.tone ? ' notice-' + card.tone : '');
        var title = document.createElement('div');
        title.className = 'notice-title';
        title.textContent = card.title || '';
        wrap.appendChild(title);
        if (card.detail) {
            var d = document.createElement('div');
            d.className = 'notice-detail';
            d.textContent = card.detail;
            wrap.appendChild(d);
        }
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // ---- Email cards -------------------------------------------------------

    // Pull a friendly display name out of a "Name <addr@host>" header value.
    function senderName(from) {
        var s = String(from || '').trim();
        var m = s.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
        if (m) return m[1].trim();
        var addr = s.match(/<([^>]+)>/);
        return (addr ? addr[1] : s).trim();
    }

    // ISO date -> short local label ("14 Jul, 09:32"); falls back to raw.
    function emailDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
            + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // A list of recent/searched emails; each row is clickable to prefill the composer.
    // Remember the last inbox list so an opened email can offer "← Inbox" (the panel
    // shows one card at a time now, so the list is otherwise replaced with no way back).
    var lastEmailListCard = null;

    function renderEmailList(card) {
        clearEmptyHint();
        lastEmailListCard = card;
        var wrap = document.createElement('div');
        wrap.className = 'plan-card email-card';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || 'Email';
        wrap.appendChild(head);

        // Mailbox picker: "All" + one chip per connected mailbox; a tap reloads this list in place (api/email-list.php).
        var accounts = card.accounts || [];
        var chips = null;
        var list = document.createElement('div');
        list.className = 'email-list';
        function drawChips() {
            chips.innerHTML = '';
            [{ id: null, label: daText('All', 'Alle'), email: '' }].concat(accounts).forEach(function (a) {
                var on = (card.account_id == null ? null : Number(card.account_id)) === a.id;
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'di-chip' + (on ? ' on' : '');
                b.textContent = a.label;
                if (a.email) b.title = a.email;
                b.addEventListener('click', function () { if (!on) switchMailbox(a.id, b); });
                chips.appendChild(b);
            });
        }
        function switchMailbox(id, btn) {
            var url = '/api/email-list.php?account=' + (id == null ? '' : encodeURIComponent(id)) + (card.query ? '&q=' + encodeURIComponent(card.query) : '');
            list.classList.add('is-loading');
            if (btn) btn.disabled = true;
            fetch(url, { credentials: 'same-origin' })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (r) {
                    list.classList.remove('is-loading');
                    if (r.ok && r.d && r.d.card) {
                        card.account_id = r.d.card.account_id;
                        card.items = r.d.card.items;
                        card.title = r.d.card.title;
                        head.textContent = card.title || 'Email';
                        drawChips();
                        fillList();
                        if (r.d.failed && r.d.failed.length) toast(daText('Could not reach: ', 'Kunne ikke nå: ') + r.d.failed.map(function (f) { return f.account; }).join(', '));
                    } else {
                        if (btn) btn.disabled = false;
                        toast((r.d && r.d.error) || daText('Could not load that mailbox.', 'Kunne ikke hente den postkasse.'));
                    }
                })
                .catch(function () { list.classList.remove('is-loading'); if (btn) btn.disabled = false; toast(daText('Network error.', 'Netværksfejl.')); });
        }
        if (accounts.length > 1) {
            chips = document.createElement('div');
            chips.className = 'di-chips email-boxes';
            drawChips();
            wrap.appendChild(chips);
        }
        wrap.appendChild(list);

        function acctLabel(m) {
            for (var i = 0; i < accounts.length; i++) if (accounts[i].id === m.account_id) return accounts[i].label;
            return '';
        }
        function fillList() {
            list.innerHTML = '';
            var items = card.items || [];
            if (!items.length) {
                var empty = document.createElement('div');
                empty.className = 'email-empty';
                empty.textContent = daText('Nothing to show.', 'Intet at vise.');
                list.appendChild(empty);
            }
            items.forEach(function (m) {
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'email-row' + (m.unread ? ' unread' : '');

                var top = document.createElement('div');
                top.className = 'email-row-top';
                var who = document.createElement('span');
                who.className = 'email-from';
                who.textContent = senderName(m.from) || '(unknown)';
                var when = document.createElement('span');
                when.className = 'email-date';
                when.textContent = emailDate(m.date);
                top.appendChild(who);
                top.appendChild(when);

                var subj = document.createElement('div');
                subj.className = 'email-subject';
                subj.textContent = m.subject || '(no subject)';

                var snip = document.createElement('div');
                snip.className = 'email-snippet';
                snip.textContent = m.snippet || '';

                row.appendChild(top);
                row.appendChild(subj);
                row.appendChild(snip);
                // In an "All" list each mail says which mailbox it is in.
                if (card.account_id == null && accounts.length > 1 && acctLabel(m)) {
                    var tag = document.createElement('span');
                    tag.className = 'email-acct';
                    tag.textContent = acctLabel(m);
                    top.insertBefore(tag, when);
                }
                row.addEventListener('click', function () { openEmail(m.account_id != null ? m.account_id : card.account_id, m); });   // a merged list: each mail knows its own mailbox
                list.appendChild(row);
            });
        }
        fillList();

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Clicking a listed email opens it in full, inline — a direct read (no assistant
    // round-trip, so it's instant and free).
    function openEmail(accountId, m) {
        clearEmptyHint();
        var wasUnread = !!m.unread;
        // Optimistically mark read: mutate the item in the stored inbox card (same
        // object), so returning via "← Inbox" shows it as read with no re-fetch.
        m.unread = false;
        var loading = addMessage('Opening…', 'assistant');
        loading.classList.add('typing');
        fetch('/api/email-read.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ account_id: accountId != null ? accountId : undefined, id: m.id, unread: wasUnread }),
        })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
            .then(function (r) {
                loading.remove();
                if (r.ok && r.d && r.d.card) {
                    presentCard(r.d.card);
                } else {
                    if (r.d && r.d.debug) console.error('[Kachow] email-read.php:', r.d.debug);
                    addMessage((r.d && r.d.error) || 'Could not open that email.', 'error');
                }
            })
            .catch(function () { loading.remove(); addMessage('Network error opening the email.', 'error'); });
    }

    // Drop a reply instruction into the composer; the assistant drafts it (it can
    // re-fetch the thread by sender/subject via its tools).
    function prefillReply(card) {
        input.value = 'Draft a reply to ' + (senderName(card.from) || 'them')
            + ' about "' + (card.subject || '(no subject)') + '": ';
        autogrow();
        input.focus();
        var len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) { /* ignore */ }
    }

    // A single opened email with its body.
    // Render an email's original HTML safely: a sandboxed iframe with a strict CSP so
    // nothing executes and no remote script/frame loads. Images + inline styles are
    // allowed so the mail looks right; JS is neutralised twice over (sandbox without
    // allow-scripts, and CSP script-src 'none'). allow-same-origin is granted only so we
    // can measure the content height — with scripts disabled it still can't escape.
    function buildHtmlEmailBody(html) {
        var frame = document.createElement('iframe');
        frame.className = 'email-html';
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('title', 'Email content');
        var csp = '<meta http-equiv="Content-Security-Policy" content="'
            + "default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:; media-src https: data:"
            + '">';
        var head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            + '<style>html,body{margin:0;padding:8px;background:#fff;color:#111;'
            + 'font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;overflow-wrap:break-word;}'
            + 'img{max-width:100%;height:auto;}a{color:#0b57d0;}</style>';
        frame.srcdoc = '<!doctype html><html><head>' + csp + head + '</head><body>' + html + '</body></html>';
        frame.addEventListener('load', function () {
            try {
                var doc = frame.contentDocument;
                if (doc && doc.body) {
                    frame.style.height = Math.min(doc.body.scrollHeight + 16, 640) + 'px';
                }
            } catch (e) { /* opaque origin — keep default height */ }
        });
        return frame;
    }

    function renderEmail(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card email-open';

        // Back to the inbox overview (the panel replaced it when this email opened).
        if (lastEmailListCard) {
            var back = document.createElement('button');
            back.type = 'button';
            back.className = 'email-back-btn';
            back.textContent = '← Inbox';
            back.addEventListener('click', function () { presentCard(lastEmailListCard); });
            wrap.appendChild(back);
        }

        var subj = document.createElement('div');
        subj.className = 'plan-card-title';
        subj.textContent = card.subject || '(no subject)';
        wrap.appendChild(subj);

        var meta = document.createElement('div');
        meta.className = 'email-meta';
        meta.textContent = senderName(card.from) + '  ·  ' + emailDate(card.date);
        wrap.appendChild(meta);

        if (card.body_html) {
            wrap.appendChild(buildHtmlEmailBody(card.body_html));
        } else {
            var body = document.createElement('pre');
            body.className = 'email-body';
            body.textContent = card.body || '(no text content)';
            wrap.appendChild(body);
        }

        var actions = document.createElement('div');
        actions.className = 'email-actions';
        var reply = document.createElement('button');
        reply.type = 'button';
        reply.className = 'email-reply-btn';
        setIconText(reply, 'undo-2', 'Reply');
        reply.addEventListener('click', function () { prefillReply(card); });
        actions.appendChild(reply);
        wrap.appendChild(actions);

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // A draft (editable) or a sent confirmation (read-only).
    function renderEmailDraft(card) {
        clearEmptyHint();
        var editable = card.send_enabled && !card.sent;
        var wrap = document.createElement('div');
        wrap.className = 'plan-card email-draft' + (card.sent ? ' sent' : '');

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || (card.sent ? 'Email sent' : 'Draft');
        wrap.appendChild(head);

        // From is fixed (the sending account); shown read-only.
        if (card.from) {
            var fromRow = document.createElement('div');
            fromRow.className = 'email-meta';
            fromRow.textContent = 'From: ' + card.from;
            wrap.appendChild(fromRow);
        }

        var inputs = {};
        // Editable field (single-line input or textarea); read-only <div> once sent.
        function field(label, key, value, multiline) {
            value = value || '';
            if (!editable) {
                if (!value) return;
                var r = document.createElement('div');
                r.className = 'email-meta' + (multiline ? ' email-body' : '');
                r.textContent = multiline ? value : (label + ': ' + value);
                wrap.appendChild(r);
                return;
            }
            var lab = document.createElement('label');
            lab.className = 'email-field';
            var span = document.createElement('span');
            span.className = 'email-field-label';
            span.textContent = label;
            lab.appendChild(span);
            var inp = multiline ? document.createElement('textarea') : document.createElement('input');
            if (!multiline) inp.type = 'text';
            inp.className = 'email-field-input' + (multiline ? ' email-field-body' : '');
            inp.value = value;
            if (multiline) inp.rows = 6;
            lab.appendChild(inp);
            wrap.appendChild(lab);
            inputs[key] = inp;
        }

        field('To', 'to', card.to, false);
        field('Cc', 'cc', card.cc, false);
        field('Subject', 'subject', card.subject, false);
        field('Message', 'body', card.body, true);

        // Attached files (e.g. a timesheet PDF): shown as a chip that opens the file.
        var attach = (card.attachments && card.attachments[0]) || null;
        if (attach) {
            var chip = document.createElement('a');
            chip.className = 'email-attach';
            chip.href = attach.url || '#';
            chip.target = '_blank';
            chip.rel = 'noopener';
            setIconText(chip, 'file-down', attach.name || 'Attachment');
            wrap.appendChild(chip);
        }

        var note = null;
        if (card.note) {
            note = document.createElement('div');
            note.className = 'email-note';
            note.textContent = card.note;
            wrap.appendChild(note);
        }

        // Human-in-the-loop Send: only when sending is enabled and not already sent.
        if (editable) {
            var actions = document.createElement('div');
            actions.className = 'email-actions';
            var sendBtnEl = document.createElement('button');
            sendBtnEl.type = 'button';
            sendBtnEl.className = 'email-send-btn';
            sendBtnEl.textContent = 'Send';
            var status = document.createElement('span');
            status.className = 'email-send-status';

            sendBtnEl.addEventListener('click', function () {
                var to = inputs.to ? inputs.to.value.trim() : card.to;
                var bodyVal = inputs.body ? inputs.body.value : card.body;
                if (!to || !bodyVal.trim()) {
                    status.textContent = 'Add a recipient and a message first.';
                    return;
                }
                sendBtnEl.disabled = true;
                sendBtnEl.textContent = 'Sending…';
                status.textContent = '';
                fetch('/api/email-send.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        account_id: card.account_id != null ? card.account_id : undefined,
                        draft_id: card.draft_id || undefined,
                        to: to,
                        cc: inputs.cc ? inputs.cc.value.trim() : card.cc,
                        subject: inputs.subject ? inputs.subject.value : card.subject,
                        body: bodyVal,
                        thread_id: card.thread_id || undefined,
                        attach_url: attach ? attach.url : undefined,
                    }),
                })
                    .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
                    .then(function (r) {
                        if (r.ok && r.d && r.d.sent) {
                            // Collapse to a read-only "sent" view.
                            Object.keys(inputs).forEach(function (k) { inputs[k].disabled = true; });
                            actions.remove();
                            wrap.classList.add('sent');
                            head.textContent = 'Email sent';
                            if (note) note.textContent = 'Sent ✓';
                        } else {
                            if (r.d && r.d.debug) console.error('[Kachow] email-send.php:', r.d.debug);
                            sendBtnEl.disabled = false;
                            sendBtnEl.textContent = 'Send';
                            status.textContent = (r.d && r.d.error) || 'Could not send.';
                        }
                    })
                    .catch(function () {
                        sendBtnEl.disabled = false;
                        sendBtnEl.textContent = 'Send';
                        status.textContent = 'Network error.';
                    });
            });

            actions.appendChild(sendBtnEl);
            actions.appendChild(status);
            wrap.appendChild(actions);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Read-only work-log summary: hours per job + what was done, day by day.
    function renderWorkLog(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card worklog-card';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || 'Work log';
        wrap.appendChild(head);

        var byJob = card.by_job || [];
        if (byJob.length) {
            var chips = document.createElement('div');
            chips.className = 'worklog-jobs';
            byJob.forEach(function (j) {
                var chip = document.createElement('span');
                chip.className = 'worklog-job';
                chip.textContent = j.job + ' (' + j.entries + ')';
                chips.appendChild(chip);
            });
            wrap.appendChild(chips);
        }

        var items = card.items || [];
        if (!items.length) {
            var empty = document.createElement('div');
            empty.className = 'email-empty';
            empty.textContent = 'Nothing logged for this period yet.';
            wrap.appendChild(empty);
        }
        items.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'worklog-entry';
            var meta = document.createElement('div');
            meta.className = 'worklog-entry-meta';
            var when = new Date(it.date);
            var dateLabel = isNaN(when.getTime()) ? it.date
                : when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
            meta.textContent = dateLabel + ' · ' + it.job;
            var desc = document.createElement('div');
            desc.className = 'worklog-entry-desc';
            desc.textContent = it.description || '';
            row.appendChild(meta);
            row.appendChild(desc);
            wrap.appendChild(row);
        });

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Read-only expenses summary: total, VAT, per-category breakdown, receipt list.
    function renderExpenses(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card expenses-card';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || 'Expenses';
        wrap.appendChild(head);

        // Per-currency totals (never blended). Keep DOM refs so a row delete updates them.
        var currencies = card.currencies || [];
        var curState = {};
        var totals = document.createElement('div');
        totals.className = 'exp-totals';
        function subText(count, vat, cur) {
            return count + (count === 1 ? ' expense' : ' expenses') + ' · incl. VAT ' + fmtMoney(vat, cur);
        }
        if (!currencies.length) {
            var zrow = document.createElement('div');
            zrow.className = 'exp-cur';
            var zt = document.createElement('div'); zt.className = 'exp-total'; zt.textContent = fmtMoney(0, 'DKK');
            zrow.appendChild(zt);
            totals.appendChild(zrow);
        }
        currencies.forEach(function (c) {
            var row = document.createElement('div');
            row.className = 'exp-cur';
            var t = document.createElement('div'); t.className = 'exp-total'; t.textContent = fmtMoney(c.total, c.currency);
            var s = document.createElement('div'); s.className = 'exp-sub'; s.textContent = subText(c.count, c.vat, c.currency);
            row.appendChild(t); row.appendChild(s);
            totals.appendChild(row);
            curState[c.currency] = { total: Number(c.total) || 0, vat: Number(c.vat) || 0, count: c.count || 0, totalEl: t, subEl: s, rowEl: row };
        });
        wrap.appendChild(totals);

        // Category chips, keyed by category+currency so a delete can update them.
        var catChips = {};
        if ((card.by_category || []).length) {
            var bd = document.createElement('div');
            bd.className = 'exp-breakdown';
            card.by_category.forEach(function (c) {
                var chip = document.createElement('span');
                chip.className = 'exp-cat';
                chip.textContent = c.category + ' · ' + fmtMoney(c.total, c.currency);
                bd.appendChild(chip);
                catChips[c.category + '|' + c.currency] = { el: chip, total: Number(c.total) || 0, category: c.category, currency: c.currency };
            });
            wrap.appendChild(bd);
        }

        var items = card.items || [];
        if (items.length) {
            var list = document.createElement('ul');
            list.className = 'exp-list';
            items.forEach(function (it) {
                var li = document.createElement('li');
                var left = document.createElement('div');
                left.className = 'exp-when';
                var main = document.createElement('div');
                main.className = 'exp-main';
                rowDateName(main, it.date, it.vendor || '');
                left.appendChild(main);
                if (it.note) {
                    var noteEl = document.createElement('div');
                    noteEl.className = 'exp-note';
                    noteEl.textContent = it.note;
                    left.appendChild(noteEl);
                }
                var right = document.createElement('span');
                right.className = 'exp-amt';
                right.textContent = fmtMoney(it.total, it.currency);

                var del = deleteButton('Delete expense');
                del.addEventListener('click', function () {
                    if (!window.confirm('Delete this expense?')) return;
                    del.disabled = true;
                    receiptAction({ action: 'discard', id: it.id }).then(function (res) {
                        if (res && res.deleted) {
                            var st = curState[it.currency];
                            if (st) {
                                st.total -= Number(it.total) || 0;
                                st.vat -= Number(it.vat) || 0;
                                st.count -= 1;
                                if (st.count <= 0) { st.rowEl.remove(); delete curState[it.currency]; }
                                else {
                                    st.totalEl.textContent = fmtMoney(st.total, it.currency);
                                    st.subEl.textContent = subText(st.count, st.vat, it.currency);
                                }
                            }
                            var ck = catChips[it.category + '|' + it.currency];
                            if (ck) {
                                ck.total -= Number(it.total) || 0;
                                if (ck.total <= 0.005) { ck.el.remove(); delete catChips[it.category + '|' + it.currency]; }
                                else { ck.el.textContent = ck.category + ' · ' + fmtMoney(ck.total, ck.currency); }
                            }
                            li.remove();
                        } else { del.disabled = false; }
                    }).catch(function () { del.disabled = false; });
                });

                li.appendChild(left);
                li.appendChild(right);
                li.appendChild(del);
                list.appendChild(li);
            });
            wrap.appendChild(list);
        } else {
            var empty = document.createElement('div');
            empty.className = 'plan-empty';
            empty.textContent = 'No expenses in this period.';
            wrap.appendChild(empty);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Full-screen image preview. Click anywhere or press Esc to close.
    function openLightbox(url) {
        var box = document.createElement('div');
        box.className = 'lightbox';
        var img = document.createElement('img');
        img.src = url;
        img.alt = 'receipt';
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'lightbox-close';
        close.setAttribute('aria-label', 'Close');
        close.innerHTML = icon('x');
        box.appendChild(img);
        box.appendChild(close);

        function dismiss() {
            box.remove();
            document.removeEventListener('keydown', onKey);
        }
        function onKey(e) { if (e.key === 'Escape') dismiss(); }
        box.addEventListener('click', dismiss);
        document.addEventListener('keydown', onKey);
        document.body.appendChild(box);
    }

    // ---------- Cycle (period) card ----------
    // Inner-seasons framing: the ring, centre and legend all key off these so colours
    // are consistent by construction. `clinical` is the medical phase name shown as a
    // subtitle. `cls` matches the CSS arc/swatch colour.
    var CYCLE_SEASONS = {
        winter: { icon: 'snowflake', label: 'Winter', cls: 'cyc-winter', clinical: 'menstrual' },
        spring: { icon: 'sprout',    label: 'Spring', cls: 'cyc-spring', clinical: 'follicular' },
        summer: { icon: 'sun',       label: 'Summer', cls: 'cyc-summer', clinical: 'ovulation' },
        autumn: { icon: 'leaf',      label: 'Autumn', cls: 'cyc-autumn', clinical: 'luteal' }
    };
    var CYCLE_SEASON_ORDER = ['winter', 'spring', 'summer', 'autumn'];
    var CYCLE_MOODS = ['😢', '😕', '😐', '🙂', '😄'];

    function cycShortDate(iso) {
        if (!iso) return '';
        var p = String(iso).split('-');
        if (p.length !== 3) return iso;
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return days[d.getDay()] + ' ' + d.getDate() + ' ' + mon[d.getMonth()];
    }

    // Build the animated SVG "cycle ring": four phase arcs + a marker on today.
    function cycleRingSvg(card) {
        var L = card.cycle_length || 28;
        var pLen = card.period_length || 5;
        var ovDay = Math.max(2, L - 14);
        var fStart = Math.max(pLen + 1, ovDay - 5);
        var fEnd = Math.min(L, ovDay + 1);
        var cx = 90, r = 70, C = 2 * Math.PI * r;

        function arc(a, b, cls) {
            if (b < a) return '';
            var startFrac = (a - 1) / L;
            var seg = ((b - a + 1) / L) * C;
            var rot = startFrac * 360 - 90;
            return '<circle class="cyc-arc ' + cls + '" cx="' + cx + '" cy="' + cx + '" r="' + r
                + '" fill="none" stroke-width="14" stroke-linecap="butt"'
                + ' stroke-dasharray="' + seg.toFixed(2) + ' ' + (C - seg).toFixed(2) + '"'
                + ' transform="rotate(' + rot.toFixed(2) + ' ' + cx + ' ' + cx + ')"/>';
        }

        var arcs;
        if ((card.seasons || []).length) {
            // Server-computed season ranges (Momkind boundaries) — one source of truth.
            arcs = card.seasons.map(function (x) {
                return arc(x.from_day, Math.min(x.to_day, L), 'cyc-' + x.season);
            }).join('');
        } else {
            arcs = arc(1, pLen, 'cyc-winter')
                + arc(pLen + 1, fStart - 1, 'cyc-spring')
                + arc(fStart, fEnd, 'cyc-summer')
                + arc(fEnd + 1, L, 'cyc-autumn');
        }

        var day = Math.min(Math.max(card.cycle_day || 1, 1), L);
        var markAngle = ((day - 0.5) / L) * 360;
        var marker = '<g transform="rotate(' + markAngle.toFixed(2) + ' ' + cx + ' ' + cx + ')">'
            + '<circle class="cyc-marker" cx="' + cx + '" cy="' + (cx - r) + '" r="9"/></g>';

        var sMeta = CYCLE_SEASONS[card.season] || null;
        var center = '<svg class="cyc-emoji ' + (sMeta ? sMeta.cls : '') + '" x="75" y="56" width="30" height="30" viewBox="0 0 24 24"'
            + ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + (ICONS[sMeta ? sMeta.icon : 'flower-2'] || '') + '</svg>'
            + '<text class="cyc-dayn" x="90" y="108" text-anchor="middle">Day ' + day + '</text>';

        return '<svg class="cyc-ring" viewBox="0 0 180 180" width="180" height="180" aria-hidden="true">'
            + '<circle class="cyc-track" cx="90" cy="90" r="70" fill="none" stroke-width="14"/>'
            + arcs + marker + center + '</svg>';
    }

    function renderCycle(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card cycle-card';
        buildCycle(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildCycle(wrap, card) {
        wrap.innerHTML = '';
        var readOnly = !!card.read_only;

        var title = document.createElement('div');
        title.className = 'plan-card-title';
        title.textContent = card.owner && card.owner.name
            ? card.owner.name + '’s cycle'
            : 'Cycle';
        wrap.appendChild(title);

        if (!card.has_data) {
            var empty = document.createElement('div');
            empty.className = 'cycle-empty';
            empty.textContent = readOnly
                ? 'No periods logged yet.'
                : 'No periods logged yet. Log when your period starts and I’ll predict the next one.';
            wrap.appendChild(empty);
            if (!readOnly) wrap.appendChild(cycleLogControls(wrap, card));
            return;
        }

        var showFertile = !!card.show_fertile;
        var isSummer = card.season === 'summer';

        // Ring + season label (season primary, clinical phase as subtitle).
        var ring = document.createElement('div');
        ring.className = 'cycle-ring-wrap';
        ring.innerHTML = cycleRingSvg(card);
        var phaseLbl = document.createElement('div');
        phaseLbl.className = 'cycle-phase';
        var seasonName = document.createElement('span');
        seasonName.className = 'cycle-season';
        setIconText(seasonName, (CYCLE_SEASONS[card.season] || {}).icon, card.season_label || '');
        phaseLbl.appendChild(seasonName);
        // Clinical subtitle — hidden for the summer/fertile phase when fertility is off.
        if (!(isSummer && !showFertile)) {
            var sub = document.createElement('span');
            sub.className = 'cycle-phase-sub';
            sub.textContent = card.phase_label + (card.predicted ? '' : ' · estimate');
            phaseLbl.appendChild(sub);
        }
        ring.appendChild(phaseLbl);
        wrap.appendChild(ring);

        // What this season tends to feel like + how long it lasts this cycle.
        if (card.season_note) {
            var note = document.createElement('div');
            note.className = 'cycle-season-note';
            var cur = (card.seasons || []).filter(function (x) { return x.season === card.season; })[0];
            note.textContent = card.season_note
                + (cur ? ' (' + cycShortDate(cur.from) + ' – ' + cycShortDate(cur.to) + ', ' + cur.days + ' day' + (cur.days === 1 ? '' : 's') + ')' : '');
            wrap.appendChild(note);
        }

        // Legend (fixes colour↔phase clarity): a swatch per season.
        var legend = document.createElement('div');
        legend.className = 'cycle-legend';
        CYCLE_SEASON_ORDER.forEach(function (s) {
            var meta = CYCLE_SEASONS[s];
            var item = document.createElement('span');
            item.className = 'cycle-legend-item' + (card.season === s ? ' on' : '');
            var sw = document.createElement('span');
            sw.className = 'cycle-swatch ' + meta.cls;
            var txt = document.createElement('span');
            // Hide the "ovulation/fertile" clinical word on summer when fertility is off.
            var clin = (s === 'summer' && !showFertile) ? '' : ' · ' + meta.clinical;
            setIconText(txt, meta.icon, meta.label + clin);
            item.appendChild(sw);
            item.appendChild(txt);
            legend.appendChild(item);
        });
        wrap.appendChild(legend);

        // Countdown.
        var count = document.createElement('div');
        count.className = 'cycle-count';
        var du = card.days_until;
        if (du === 0) count.innerHTML = '<b>Period expected today</b>';
        else if (du > 0) count.innerHTML = 'Next period in <b>' + du + '</b> day' + (du === 1 ? '' : 's') + ' · ' + cycShortDate(card.next_period);
        else count.innerHTML = '<b>' + Math.abs(du) + '</b> day' + (du === -1 ? '' : 's') + ' late · expected ' + cycShortDate(card.next_period);
        wrap.appendChild(count);

        // Fertile window — shown only when enabled (clearly an estimate, not contraception).
        if (showFertile) {
            var fert = document.createElement('div');
            fert.className = 'cycle-fertile' + (card.in_fertile ? ' active' : '');
            fert.innerHTML = icon('sun', 'ic-lead') + 'Fertile window (est.): ' + cycShortDate(card.fertile_from) + ' – ' + cycShortDate(card.fertile_to)
                + '<span class="cycle-caveat">estimate for planning, not contraception</span>';
            wrap.appendChild(fert);
        }
        // Toggle to show/hide the fertile window (own view only).
        if (!readOnly) {
            var toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'cycle-fertile-toggle';
            toggle.textContent = showFertile ? 'Hide fertile window' : 'Show fertile window';
            toggle.addEventListener('click', function () { cyclePost({ action: 'toggle_fertile' }, wrap); });
            wrap.appendChild(toggle);
        }

        // Mood / energy.
        wrap.appendChild(cycleMoodEnergy(wrap, card, readOnly));

        // Recent periods.
        if (card.recent && card.recent.length) {
            var rec = document.createElement('div');
            rec.className = 'cycle-recent';
            var rh = document.createElement('div');
            rh.className = 'cycle-recent-head';
            rh.textContent = 'Recent';
            rec.appendChild(rh);
            card.recent.forEach(function (p) {
                var row = document.createElement('div');
                row.className = 'cycle-recent-row';
                var lbl = document.createElement('span');
                var len = p.length ? ' · ' + p.length + 'd' : '';
                lbl.textContent = cycShortDate(p.start) + len;
                row.appendChild(lbl);
                if (!readOnly) {
                    var del = deleteButton('Remove period');
                    del.addEventListener('click', function () {
                        if (!window.confirm('Remove this logged period?')) return;
                        cyclePost({ action: 'remove', id: p.id }, wrap);
                    });
                    row.appendChild(del);
                }
                rec.appendChild(row);
            });
            wrap.appendChild(rec);
        }

        if (!readOnly) wrap.appendChild(cycleLogControls(wrap, card));

        if (card.season_source && card.season_source.url) {
            var src = document.createElement('a');
            src.className = 'cycle-source';
            src.href = card.season_source.url;
            src.target = '_blank';
            src.rel = 'noopener noreferrer';
            src.textContent = 'Seasons based on: ' + (card.season_source.title || 'source');
            wrap.appendChild(src);
        }

        // Two blocks (same order as before, so a phone looks identical): the ring + season
        // info, and the day-to-day part (mood/energy, history, logging). A wide desktop
        // panel shows them side by side.
        var colA = document.createElement('div'); colA.className = 'cycle-col cycle-col-a';
        var colB = document.createElement('div'); colB.className = 'cycle-col cycle-col-b';
        Array.prototype.slice.call(wrap.children).forEach(function (el) {
            if (el.classList.contains('plan-card-title')) return;
            var dayToDay = el.classList.contains('cycle-mood') || el.classList.contains('cycle-recent')
                || el.classList.contains('cycle-log') || el.classList.contains('cycle-source');
            (dayToDay ? colB : colA).appendChild(el);
        });
        wrap.appendChild(colA);
        wrap.appendChild(colB);
    }

    function cycTodayIso() {
        var d = new Date();
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    // Log controls: a start-date picker (defaults to today, can backdate) and the log
    // button. The button label reflects the chosen date.
    function cycleLogControls(wrap, card) {
        var box = document.createElement('div');
        box.className = 'cycle-log';
        var today = cycTodayIso();

        // Current period still going / ended (report #24): the Winter phase follows the
        // logged end of THIS period, so these move the ring instead of a fixed day count.
        if (card.has_data && card.cycle_day && card.cycle_day <= 14) {
            var cur = document.createElement('div');
            cur.className = 'cycle-current';
            var still = document.createElement('button');
            still.type = 'button';
            still.className = 'cycle-fertile-toggle';
            setIconText(still, card.period_ongoing ? 'check' : 'droplet', 'Still going today');
            still.disabled = !!card.period_ongoing;
            still.addEventListener('click', function () { still.disabled = true; cyclePost({ action: 'ongoing' }, wrap); });
            cur.appendChild(still);
            if (card.season === 'winter') {
                var ended = document.createElement('button');
                ended.type = 'button';
                ended.className = 'cycle-fertile-toggle';
                ended.textContent = 'Ended today';
                ended.addEventListener('click', function () { ended.disabled = true; cyclePost({ action: 'ended' }, wrap); });
                cur.appendChild(ended);
            }
            box.appendChild(cur);
        }

        var dateRow = document.createElement('label');
        dateRow.className = 'cycle-date-row';
        var dateLbl = document.createElement('span');
        dateLbl.textContent = 'Started';
        var dateIn = document.createElement('input');
        dateIn.type = 'date';
        dateIn.className = 'cycle-date-input';
        dateIn.value = today;
        dateIn.max = today; // no logging a period in the future
        dateRow.appendChild(dateLbl);
        dateRow.appendChild(dateIn);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cycle-log-btn';
        function syncBtn() {
            btn.textContent = (dateIn.value === today || !dateIn.value)
                ? '＋ Period started today'
                : '＋ Log period · ' + cycShortDate(dateIn.value);
        }
        syncBtn();
        dateIn.addEventListener('change', syncBtn);
        btn.addEventListener('click', function () {
            btn.disabled = true;
            cyclePost({ action: 'log', start_date: dateIn.value || today }, wrap);
        });

        box.appendChild(dateRow);
        box.appendChild(btn);
        return box;
    }

    function moodColor(level) {
        return ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399'][Math.max(1, Math.min(5, level)) - 1];
    }

    // A 1–5 picker row for mood (emoji faces) or energy (rising bars).
    function moodEnergyPicker(wrap, card, key, label, emojis) {
        var row = document.createElement('div');
        row.className = 'cycle-me-row';
        var lbl = document.createElement('span');
        lbl.className = 'cycle-me-label';
        lbl.textContent = label;
        row.appendChild(lbl);
        var opts = document.createElement('div');
        opts.className = 'cycle-me-opts';
        var current = key === 'mood' ? card.mood_today : card.energy_today;
        for (var i = 1; i <= 5; i++) {
            (function (level) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'cycle-me-opt' + (current === level ? ' on' : '') + (emojis ? ' is-mood' : ' is-energy');
                b.title = label + ' ' + level;
                if (emojis) {
                    b.textContent = emojis[level - 1];
                } else {
                    var fill = document.createElement('span');
                    fill.className = 'cycle-energy-fill';
                    fill.style.height = (level * 16 + 12) + '%';
                    b.appendChild(fill);
                }
                b.addEventListener('click', function () {
                    var body = { action: 'log_day' };
                    body[key] = level;
                    cyclePost(body, wrap);
                });
                opts.appendChild(b);
            })(i);
        }
        row.appendChild(opts);
        return row;
    }

    // Mood & energy section: today's pickers (own view) + a 14-day trend strip
    // (dot = mood colour, bar = energy height).
    function cycleMoodEnergy(wrap, card, readOnly) {
        var box = document.createElement('div');
        box.className = 'cycle-mood';
        var head = document.createElement('div');
        head.className = 'cycle-mood-head';
        head.textContent = readOnly ? 'Mood & energy' : 'How do you feel today?';
        box.appendChild(head);

        if (!readOnly) {
            box.appendChild(moodEnergyPicker(wrap, card, 'mood', 'Mood', CYCLE_MOODS));
            box.appendChild(moodEnergyPicker(wrap, card, 'energy', 'Energy', null));
        }

        if (card.trend && card.trend.length) {
            var trend = document.createElement('div');
            trend.className = 'cycle-trend';
            card.trend.forEach(function (d) {
                var col = document.createElement('div');
                col.className = 'cycle-trend-col';
                col.title = d.date + (d.mood ? ' · mood ' + d.mood : '') + (d.energy ? ' · energy ' + d.energy : '');
                var dot = document.createElement('span');
                dot.className = 'cycle-trend-mood' + (d.mood ? '' : ' empty');
                if (d.mood) dot.style.background = moodColor(d.mood);
                var barWrap = document.createElement('span');
                barWrap.className = 'cycle-trend-barwrap';
                var bar = document.createElement('span');
                bar.className = 'cycle-trend-bar' + (d.energy ? '' : ' empty');
                if (d.energy) bar.style.height = (d.energy * 20) + '%';
                barWrap.appendChild(bar);
                col.appendChild(dot);
                col.appendChild(barWrap);
                trend.appendChild(col);
            });
            box.appendChild(trend);
            var tl = document.createElement('div');
            tl.className = 'cycle-trend-legend';
            tl.textContent = 'Last 14 days · dot = mood, bar = energy';
            box.appendChild(tl);
        }
        return box;
    }

    function cyclePost(body, wrap) {
        return fetch('/api/cycle.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
            if (res && res.card) buildCycle(wrap, res.card);
        }).catch(function () { /* non-fatal */ });
    }

    // ---- Workout progression card ------------------------------------------------
    var PROG_METRIC_SHORT = { est_1rm: 'Est. 1RM', top_weight: 'Top set', volume: 'Volume' };

    // Escapes text before it goes into an SVG string (exercise names are user data).
    function progEsc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function progFmt(v) {
        if (v == null) return '–';
        var s = (Math.round(v * 10) / 10).toFixed(1);
        return s.replace(/\.0$/, '');
    }

    function progShortDate(iso) {
        var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return String(iso);
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1];
    }

    // Chart drawing size. Phones (and the transcript) keep the classic 320×H viewBox that
    // scales to fit; on a wide desktop panel the chart is drawn at the panel's REAL width,
    // so labels stay a normal size instead of being blown up 3× (they're styled in px).
    function chartDims(baseW, baseH) {
        var body = cardPanelBody;
        if (!body || !body.clientWidth) return [baseW, baseH];
        var scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-scale')) || 1;
        var w = (body.clientWidth - 24) / scale;
        if (w < 560) return [baseW, baseH];
        return [Math.round(Math.min(w, 1100)), Math.round(Math.min(baseH * 1.8, 300))];
    }

    // Hand-rolled inline SVG line chart (no chart lib — matches the app's aesthetic).
    function progChartSvg(card) {
        var pts = card.points || [];
        var dims = chartDims(320, 150);
        var W = dims[0], H = dims[1], padL = 8, padR = 10, padT = 12, padB = 22;
        var innerW = W - padL - padR, innerH = H - padT - padB;
        var vals = pts.map(function (p) { return p.value; });
        var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        var range = max - min;
        var lo = range === 0 ? min - 1 : min - range * 0.12;
        var hi = range === 0 ? max + 1 : max + range * 0.12;
        var span = hi - lo || 1;
        var n = pts.length;

        function px(i) { return n === 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW; }
        function py(v) { return padT + (1 - (v - lo) / span) * innerH; }

        var coords = pts.map(function (p, i) { return { x: px(i), y: py(p.value), p: p }; });

        // Baseline gridlines at the true min & max, with value labels.
        var yMax = py(max), yMin = py(min);
        var grid = '<line class="prog-grid" x1="' + padL + '" y1="' + yMax.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yMax.toFixed(1) + '"/>'
            + '<line class="prog-grid" x1="' + padL + '" y1="' + yMin.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yMin.toFixed(1) + '"/>'
            + '<text class="prog-ylab" x="' + padL + '" y="' + (yMax - 3).toFixed(1) + '">' + progFmt(max) + '</text>';
        if (min !== max) {
            grid += '<text class="prog-ylab" x="' + padL + '" y="' + (yMin + 10).toFixed(1) + '">' + progFmt(min) + '</text>';
        }

        var line = '', area = '', dots = '';
        if (n > 1) {
            var d = coords.map(function (c, i) { return (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1); }).join(' ');
            var aPath = 'M' + coords[0].x.toFixed(1) + ' ' + (padT + innerH).toFixed(1) + ' '
                + coords.map(function (c) { return 'L' + c.x.toFixed(1) + ' ' + c.y.toFixed(1); }).join(' ')
                + ' L' + coords[n - 1].x.toFixed(1) + ' ' + (padT + innerH).toFixed(1) + ' Z';
            area = '<path class="prog-area" d="' + aPath + '"/>';
            line = '<path class="prog-line" d="' + d + '"/>';
        }
        var showReal = card.metric === 'est_1rm';
        var hits = '';
        coords.forEach(function (c, i) {
            var last = i === n - 1;
            var real = showReal && c.p.real;
            var title = progShortDate(c.p.date) + ' · ' + progFmt(c.p.value) + ' ' + (card.unit || '')
                + (c.p.detail ? ' (' + c.p.detail + ')' : '')
                + (showReal ? (real ? ' — tested max' : ' — estimated') : '');
            var cls = 'prog-dot' + (real ? ' real' : '') + (last ? ' last' : '');
            if (real) {
                // Diamond marker for a tested (1-rep) max.
                var s = last ? 5.5 : 4.5, x = c.x, y = c.y;
                var d = 'M' + x.toFixed(1) + ' ' + (y - s).toFixed(1)
                    + ' L' + (x + s).toFixed(1) + ' ' + y.toFixed(1)
                    + ' L' + x.toFixed(1) + ' ' + (y + s).toFixed(1)
                    + ' L' + (x - s).toFixed(1) + ' ' + y.toFixed(1) + ' Z';
                dots += '<path class="' + cls + '" data-idx="' + i + '" d="' + d + '"><title>' + progEsc(title) + '</title></path>';
            } else {
                dots += '<circle class="' + cls + '" data-idx="' + i + '" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1)
                    + '" r="' + (last ? 4.5 : 3) + '"><title>' + progEsc(title) + '</title></circle>';
            }
            // Big transparent tap target on top (finger-friendly on mobile).
            hits += '<circle class="prog-hit" data-idx="' + i + '" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) + '" r="13"/>';
        });

        // Value label on the latest point.
        var lastC = coords[n - 1];
        var lblX = Math.min(lastC.x, W - padR - 2);
        var above = lastC.y > padT + 14;
        var lastLbl = '<text class="prog-last" x="' + lblX.toFixed(1) + '" y="' + (above ? lastC.y - 8 : lastC.y + 14).toFixed(1)
            + '" text-anchor="end">' + progFmt(lastC.p.value) + '</text>';

        // X-axis: first & last date.
        var xlab = '<text class="prog-xlab" x="' + padL + '" y="' + (H - 6) + '" text-anchor="start">' + progShortDate(pts[0].date) + '</text>';
        if (n > 1) {
            xlab += '<text class="prog-xlab" x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end">' + progShortDate(pts[n - 1].date) + '</text>';
        }

        return '<svg class="prog-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img">'
            + grid + area + line + dots + lastLbl + xlab + hits + '</svg>';
    }

    function renderProgression(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card prog-card';
        buildProgression(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildProgression(wrap, card) {
        wrap.innerHTML = '';

        var title = document.createElement('div');
        title.className = 'plan-card-title';
        title.textContent = (card.exercise || 'Workout') + ' · progression';
        wrap.appendChild(title);

        // Attribution when charting a connected person's data.
        if (card.person && card.person.name) {
            var who = document.createElement('div');
            who.className = 'prog-shared';
            who.textContent = 'shared by ' + card.person.name;
            wrap.appendChild(who);
        }

        // Exercise picker (only when there's more than one to choose from).
        if ((card.exercises || []).length > 1) {
            var sel = document.createElement('select');
            sel.className = 'prog-exercise';
            card.exercises.forEach(function (ex) {
                var o = document.createElement('option');
                o.value = ex; o.textContent = ex;
                if (ex === card.exercise) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', function () {
                progPost({ exercise: sel.value, metric: card.metric, weeks: card.weeks, person: card.person_ref }, wrap);
            });
            wrap.appendChild(sel);
        }

        if (!card.has_data) {
            var empty = document.createElement('div');
            empty.className = 'prog-empty';
            empty.textContent = card.exercise
                ? 'No sets for ' + card.exercise + ' in the last ' + card.weeks + ' weeks.'
                : 'Log some workouts and I’ll chart your progress here.';
            wrap.appendChild(empty);
            wrap.appendChild(progControls(card, wrap));
            return;
        }

        // Summary line — lead with the PEAK (best). No latest-vs-first delta/percentage:
        // sub-max sessions make that misleading (a lighter day isn't "getting weaker").
        var s = card.summary;
        var summary = document.createElement('div');
        summary.className = 'prog-summary';
        summary.innerHTML = '<span class="prog-metric">' + (PROG_METRIC_SHORT[card.metric] || card.metric) + '</span>'
            + '<span class="prog-best-val">best ' + progFmt(s.best) + ' ' + progEsc(card.unit) + '</span>'
            + '<span class="prog-sessions">' + s.sessions + ' session' + (s.sessions === 1 ? '' : 's') + '</span>';
        wrap.appendChild(summary);

        var chart = document.createElement('div');
        chart.className = 'prog-chart';
        chart.innerHTML = progChartSvg(card);
        wrap.appendChild(chart);

        // Tap-to-inspect readout (mobile has no hover, so <title> alone isn't enough).
        var readout = document.createElement('div');
        readout.className = 'prog-readout';
        wrap.appendChild(readout);
        wireProgTaps(chart, readout, card);

        // Legend distinguishing tested (1-rep) maxes from Epley estimates.
        if (card.metric === 'est_1rm') {
            var leg = document.createElement('div');
            leg.className = 'prog-legend';
            leg.innerHTML = '<span class="prog-leg real">◆</span> tested max'
                + '<span class="prog-leg est">●</span> estimated';
            wrap.appendChild(leg);
        }

        if (s.sessions === 1) {
            var one = document.createElement('div');
            one.className = 'prog-hint';
            one.textContent = 'Only one session in range — log more to see a trend.';
            wrap.appendChild(one);
        }
        var latest = document.createElement('div');
        latest.className = 'prog-hint';
        latest.textContent = 'Latest: ' + progFmt(s.last) + ' ' + card.unit;
        wrap.appendChild(latest);

        wrap.appendChild(progControls(card, wrap));
    }

    // Metric + time-range segmented toggles.
    function progControls(card, wrap) {
        var box = document.createElement('div');
        box.className = 'prog-controls';

        var metrics = document.createElement('div');
        metrics.className = 'prog-seg';
        (card.metrics || []).forEach(function (m) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'prog-seg-btn' + (m.key === card.metric ? ' on' : '');
            b.textContent = PROG_METRIC_SHORT[m.key] || m.label;
            b.addEventListener('click', function () {
                if (m.key === card.metric) return;
                progPost({ exercise: card.exercise, metric: m.key, weeks: card.weeks, person: card.person_ref }, wrap);
            });
            metrics.appendChild(b);
        });
        box.appendChild(metrics);

        var ranges = document.createElement('div');
        ranges.className = 'prog-seg';
        (card.ranges || []).forEach(function (w) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'prog-seg-btn' + (w === card.weeks ? ' on' : '');
            b.textContent = w >= 52 ? '1y' : (w + 'w');
            b.addEventListener('click', function () {
                if (w === card.weeks) return;
                progPost({ exercise: card.exercise, metric: card.metric, weeks: w, person: card.person_ref }, wrap);
            });
            ranges.appendChild(b);
        });
        box.appendChild(ranges);

        return box;
    }

    function progPost(body, wrap) {
        wrap.classList.add('loading');
        return fetch('/api/workout-progress.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
            wrap.classList.remove('loading');
            if (res && res.card) buildProgression(wrap, res.card);
        }).catch(function () { wrap.classList.remove('loading'); });
    }

    function progLongDate(iso) {
        var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return String(iso);
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1];
    }

    // Makes chart points tappable: a tap fills the readout with the point's real values
    // and highlights it. Defaults to the latest point so the readout is never empty.
    function wireProgTaps(chart, readout, card) {
        var svg = chart.querySelector('.prog-svg');
        if (!svg) return;
        var points = card.points || [];
        var showReal = card.metric === 'est_1rm';

        function select(idx) {
            var p = points[idx];
            if (!p) return;
            var prev = svg.querySelector('.prog-dot.sel');
            if (prev) prev.classList.remove('sel');
            var marker = svg.querySelector('.prog-dot[data-idx="' + idx + '"]');
            if (marker) marker.classList.add('sel');

            var tag = showReal
                ? '<span class="prog-ro-tag ' + (p.real ? 'real' : 'est') + '">'
                    + (p.real ? 'tested max' : 'estimated') + '</span>'
                : '';
            readout.innerHTML = '<span class="prog-ro-date">' + progEsc(progLongDate(p.date)) + '</span>'
                + '<span class="prog-ro-val">' + progFmt(p.value) + ' ' + progEsc(card.unit || '') + '</span>'
                + (p.detail ? '<span class="prog-ro-detail">' + progEsc(p.detail) + '</span>' : '')
                + tag;
        }

        Array.prototype.forEach.call(svg.querySelectorAll('.prog-hit'), function (h) {
            h.addEventListener('click', function () {
                select(parseInt(h.getAttribute('data-idx'), 10));
            });
        });
        select(points.length - 1);
    }

    // ---- Work-hours bar chart card -----------------------------------------------
    // Human label for a bucket, e.g. "Mon 6 Jul", "Week of 6 Jul", "Jul 2026".
    function wchWhen(card, b) {
        if (card.mode === 'custom') {
            if (card.bucket_word === 'day') return b.sub;
            if (card.bucket_word === 'month') return b.label + ' ' + b.sub;
            return 'Week of ' + b.sub;
        }
        if (card.mode === 'week') return b.label + ' ' + b.sub;
        if (card.mode === 'year') return b.label + ' ' + b.sub;
        return 'Week of ' + b.sub;
    }

    // Shared categorical palette for multi-series charts (work stacks, generic charts).
    // CSS vars so themes can override; the first series follows the theme accent.
    function seriesColor(i) {
        return 'var(--series-' + ((i % 6) + 1) + ')';
    }

    function wchFmtMin(m) {
        var h = Math.floor(m / 60), r = m % 60;
        return h === 0 ? r + 'm' : (r === 0 ? h + 'h' : h + 'h ' + r + 'm');
    }

    function wchBarsSvg(card) {
        var bars = card.bars || [];
        var dims = chartDims(320, 150);
        var W = dims[0], H = dims[1], padL = 8, padR = 8, padT = 12, padB = 22;
        var innerW = W - padL - padR, innerH = H - padT - padB;
        var n = bars.length || 1;
        var maxMin = Math.max.apply(null, bars.map(function (b) { return b.minutes; }).concat([1]));
        var y0 = padT + innerH;
        var step = innerW / n;
        var barW = Math.min(step * 0.64, 34 * Math.min(2, W / 320));   // wider bars on a wide panel
        function bx(i) { return padL + step * i + (step - barW) / 2; }

        var grid = '<line class="wch-grid" x1="' + padL + '" y1="' + padT + '" x2="' + (W - padR) + '" y2="' + padT + '"/>'
            + '<text class="wch-ylab" x="' + padL + '" y="' + (padT - 3) + '">' + progFmt(maxMin / 60) + 'h</text>'
            + '<line class="wch-grid base" x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '"/>';

        var rects = '', hits = '', labels = '';
        var many = n > 8;
        bars.forEach(function (b, i) {
            var h = maxMin > 0 ? (b.minutes / maxMin) * innerH : 0;
            var x = bx(i);
            if (b.minutes > 0 && card.stacked && b.split) {
                // Stacked per workplace (order = card.places), bottom-up.
                var yTop = y0;
                b.split.forEach(function (m, si) {
                    if (!m) return;
                    var sh = maxMin > 0 ? (m / maxMin) * innerH : 0;
                    yTop -= sh;
                    var pl = (card.places[si] && card.places[si].place) || '—';
                    rects += '<rect class="wch-bar wch-seg" data-idx="' + i + '" style="fill:' + seriesColor(si) + '" x="' + x.toFixed(1)
                        + '" y="' + yTop.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(sh, 1).toFixed(1) + '">'
                        + '<title>' + progEsc(wchWhen(card, b) + ' · ' + pl + ' ' + wchFmtMin(m)) + '</title></rect>';
                });
            } else if (b.minutes > 0) {
                var bh = Math.max(h, 2);
                var cls = 'wch-bar' + (b.ongoing ? ' ongoing' : '');
                rects += '<rect class="' + cls + '" data-idx="' + i + '" x="' + x.toFixed(1) + '" y="' + (y0 - bh).toFixed(1)
                    + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2.5">'
                    + '<title>' + progEsc(wchWhen(card, b) + ' · ' + b.total + (b.ongoing ? ' · on the clock' : '')) + '</title></rect>';
            }
            hits += '<rect class="wch-hit" data-idx="' + i + '" x="' + (padL + step * i).toFixed(1) + '" y="' + padT
                + '" width="' + step.toFixed(1) + '" height="' + innerH.toFixed(1) + '"/>';
            if (!many || i % 2 === 0 || i === n - 1) {
                labels += '<text class="wch-xlab" x="' + (x + barW / 2).toFixed(1) + '" y="' + (H - 8)
                    + '" text-anchor="middle">' + progEsc(b.label) + '</text>';
            }
        });

        return '<svg class="wch-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + grid + rects + labels + hits + '</svg>';
    }

    // ---- Generic chart card (kind 'chart', from the show_chart tool) --------------
    // Bar (grouped or stacked) or line, 1–6 series, values the model took from tool
    // results. Tap a column for its values. Plain inline SVG like the work chart.
    function chartFmt(v, unit) {
        var n = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('da-DK')
            : (Math.round(v * 100) / 100).toLocaleString('da-DK');
        return unit ? n + ' ' + unit : n;
    }

    function chartSvg(card) {
        var labels = card.labels || [], series = card.series || [];
        var n = labels.length || 1, S = series.length || 1;
        var dims = chartDims(320, 170);
        var W = dims[0], H = dims[1], padL = 8, padR = 8, padT = 14, padB = 22;
        var innerW = W - padL - padR, innerH = H - padT - padB;
        var stacked = !!card.stacked, isLine = card.type === 'line';

        // Value range (include 0; supports negatives, e.g. a loss month).
        var maxV = 0, minV = 0;
        for (var i = 0; i < n; i++) {
            var pos = 0, neg = 0;
            series.forEach(function (sr) {
                var v = +sr.values[i] || 0;
                if (stacked) { if (v >= 0) pos += v; else neg += v; }
                else { maxV = Math.max(maxV, v); minV = Math.min(minV, v); }
            });
            if (stacked) { maxV = Math.max(maxV, pos); minV = Math.min(minV, neg); }
        }
        if (isLine) {
            // A trend reads better on its own scale (110 vs 100 kg shouldn't look flat).
            var all = [];
            series.forEach(function (sr) { sr.values.forEach(function (v) { all.push(+v || 0); }); });
            var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
            var pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
            minV = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
            maxV = hi + pad;
        }
        if (maxV === minV) maxV = minV + 1;
        function y(v) { return padT + (maxV - v) / (maxV - minV) * innerH; }
        var y0 = Math.min(Math.max(y(0), padT), padT + innerH), step = innerW / n;

        var out = '<line class="wch-grid" x1="' + padL + '" y1="' + padT + '" x2="' + (W - padR) + '" y2="' + padT + '"/>'
            + '<text class="wch-ylab" x="' + padL + '" y="' + (padT - 3) + '">' + progEsc(chartFmt(maxV, card.unit)) + '</text>'
            + '<line class="wch-grid base" x1="' + padL + '" y1="' + y0.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y0.toFixed(1) + '"/>';
        // Bottom-of-scale label, right-aligned just above the plot floor (clear of x labels);
        // appended after the marks (below) so it stays on top, with a halo.
        var minLab = minV !== 0
            ? '<text class="wch-ylab halo" x="' + (W - padR) + '" y="' + (padT + innerH - 3) + '" text-anchor="end">'
                + progEsc(chartFmt(minV, card.unit)) + '</text>'
            : '';

        if (isLine) {
            series.forEach(function (sr, si) {
                var pts = sr.values.map(function (v, i) {
                    return (padL + step * i + step / 2).toFixed(1) + ',' + y(+v || 0).toFixed(1);
                });
                out += '<polyline fill="none" stroke-width="2" stroke-linejoin="round" style="stroke:' + seriesColor(si) + '" points="' + pts.join(' ') + '"/>';
                if (n <= 24) {
                    sr.values.forEach(function (v, i) {
                        out += '<circle r="2.6" style="fill:' + seriesColor(si) + '" cx="' + (padL + step * i + step / 2).toFixed(1) + '" cy="' + y(+v || 0).toFixed(1) + '"/>';
                    });
                }
            });
        } else {
            var groupW = Math.min(step * 0.72, (stacked ? 34 : 14 * S + 6) * Math.min(2, W / 320));
            var barW = stacked ? groupW : groupW / S;
            labels.forEach(function (_, i) {
                var gx = padL + step * i + (step - groupW) / 2, up = y0, down = y0;
                series.forEach(function (sr, si) {
                    var v = +sr.values[i] || 0;
                    if (!v) return;
                    var h = Math.abs(y(v) - y0), x, top;
                    if (stacked) {
                        x = gx;
                        if (v >= 0) { up -= h; top = up; } else { top = down; down += h; }
                    } else {
                        x = gx + barW * si;
                        top = v >= 0 ? y0 - h : y0;
                    }
                    out += '<rect class="chart-bar" data-idx="' + i + '" style="fill:' + seriesColor(si) + '" x="' + x.toFixed(1)
                        + '" y="' + top.toFixed(1) + '" width="' + Math.max(barW - (stacked ? 0 : 1), 1).toFixed(1)
                        + '" height="' + Math.max(h, 1).toFixed(1) + '" rx="' + (stacked ? 0 : 2) + '"/>';
                });
            });
        }

        out += minLab;
        var many = n > 8, every = Math.ceil(n / 8);
        labels.forEach(function (l, i) {
            if (!many || i % every === 0 || i === n - 1) {
                out += '<text class="wch-xlab" x="' + (padL + step * i + step / 2).toFixed(1) + '" y="' + (H - 8)
                    + '" text-anchor="middle">' + progEsc(l) + '</text>';
            }
            out += '<rect class="wch-hit" data-idx="' + i + '" x="' + (padL + step * i).toFixed(1) + '" y="' + padT
                + '" width="' + step.toFixed(1) + '" height="' + innerH.toFixed(1) + '"/>';
        });

        return '<svg class="wch-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + progEsc(card.title || 'Chart') + '">' + out + '</svg>';
    }

    function buildChart(wrap, card) {
        wrap.innerHTML = '';
        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || 'Chart';
        wrap.appendChild(head);

        var chart = document.createElement('div');
        chart.className = 'wch-chart';
        chart.innerHTML = chartSvg(card);
        wrap.appendChild(chart);

        var readout = document.createElement('div');
        readout.className = 'prog-readout';
        wrap.appendChild(readout);

        var series = card.series || [];
        function select(i) {
            var svg = chart.querySelector('svg');
            Array.prototype.forEach.call(svg.querySelectorAll('.chart-bar.sel'), function (el) { el.classList.remove('sel'); });
            Array.prototype.forEach.call(svg.querySelectorAll('.chart-bar[data-idx="' + i + '"]'), function (el) { el.classList.add('sel'); });
            var parts = series.map(function (sr) {
                return (series.length > 1 ? progEsc(sr.name) + ' ' : '') + progEsc(chartFmt(+sr.values[i] || 0, card.unit));
            });
            readout.innerHTML = '<span class="prog-ro-date">' + progEsc((card.labels || [])[i] || '') + '</span>'
                + '<span class="prog-ro-val">' + parts.join(' · ') + '</span>';
        }
        Array.prototype.forEach.call(chart.querySelectorAll('.wch-hit'), function (h) {
            h.addEventListener('click', function () { select(parseInt(h.getAttribute('data-idx'), 10)); });
        });
        select((card.labels || []).length - 1);

        if (series.length > 1) {
            var legend = document.createElement('div');
            legend.className = 'work-breakdown';
            series.forEach(function (sr, si) {
                var chip = document.createElement('span');
                chip.className = 'work-place-total';
                var sw = document.createElement('span');
                sw.className = 'chart-swatch';
                sw.style.background = seriesColor(si);
                chip.appendChild(sw);
                chip.appendChild(document.createTextNode(sr.name));
                legend.appendChild(chip);
            });
            wrap.appendChild(legend);
        }

        if (card.source) {
            var src = document.createElement('div');
            src.className = 'chart-source';
            src.textContent = 'Data: ' + card.source;
            wrap.appendChild(src);
        }
    }

    function renderChart(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card wch-card';
        buildChart(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Phase-4 shadow work clock: location-derived hours vs recorded punches, per day.
    function renderWorkClock(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card wc-card';

        var head = document.createElement('div'); head.className = 'books-head';
        var title = document.createElement('div'); title.className = 'books-title';
        title.textContent = daText('Work clock · shadow', 'Arbejdsur · skygge');
        head.appendChild(title);
        var range = document.createElement('span'); range.className = 'books-navlabel'; range.textContent = card.range || '';
        head.appendChild(range);
        wrap.appendChild(head);

        // Summary: auto total vs punch total + agreement.
        var sum = document.createElement('div'); sum.className = 'wc-summary';
        function chip(labelText, value, cls) {
            var c = document.createElement('div'); c.className = 'wc-chip ' + (cls || '');
            var l = document.createElement('div'); l.className = 'wc-chip-l'; l.textContent = labelText;
            var v = document.createElement('div'); v.className = 'wc-chip-v'; v.textContent = value;
            c.appendChild(l); c.appendChild(v); return c;
        }
        sum.appendChild(chip(daText('Auto (location)', 'Auto (lokation)'), card.location_total || '0m', 'wc-auto'));
        sum.appendChild(chip(daText('Punches', 'Stempling'), card.punch_total || '0m', 'wc-punch'));
        sum.appendChild(chip(daText('Days matching', 'Dage der matcher'),
            (card.agree_days || 0) + '/' + (card.compared_days || 0)));
        wrap.appendChild(sum);

        // Per-day rows.
        var days = card.days || [];
        if (!days.length) {
            var empty = document.createElement('div'); empty.className = 'wc-note';
            empty.textContent = daText('No work-place stays or punches in this range.',
                                       'Ingen ophold på arbejdssteder eller stemplinger i perioden.');
            wrap.appendChild(empty);
        }
        days.forEach(function (d) {
            var row = document.createElement('div');
            row.className = 'wc-day' + (d.match === true ? ' is-match' : (d.match === false ? ' is-diff' : ''))
                + (d.incomplete ? ' is-incomplete' : '');

            var date = document.createElement('div'); date.className = 'wc-date'; date.textContent = d.label || d.date;
            // A day the tracker missed part of: the auto figure is low because of missing data,
            // not because the rules are wrong.
            if (d.incomplete) {
                var warn = document.createElement('span'); warn.className = 'wc-gap';
                warn.textContent = daText('gap', 'hul');
                warn.title = daText('No positions for part of this day', 'Ingen positioner i en del af dagen');
                date.appendChild(document.createTextNode(' '));
                date.appendChild(warn);
            }
            row.appendChild(date);

            var cols = document.createElement('div'); cols.className = 'wc-cols';
            function col(cls, total, sessions) {
                var c = document.createElement('div'); c.className = 'wc-col ' + cls;
                var t = document.createElement('div'); t.className = 'wc-col-total'; t.textContent = total || '0m';
                c.appendChild(t);
                var times = (sessions || []).map(function (s) {
                    return (s.in || '') + '–' + (s.ongoing ? '…' : (s.out || ''));
                });
                if (times.length) {
                    var sub = document.createElement('div'); sub.className = 'wc-col-sub'; sub.textContent = times.join(', ');
                    c.appendChild(sub);
                }
                return c;
            }
            cols.appendChild(col('wc-auto', d.location_total, d.location_sessions));
            cols.appendChild(col('wc-punch', d.punch_total, d.punch_sessions));
            row.appendChild(cols);

            var delta = document.createElement('div'); delta.className = 'wc-delta';
            delta.textContent = d.match === true ? '✓' : (d.delta_label || '');
            row.appendChild(delta);

            wrap.appendChild(row);
        });

        if (card.incomplete_days) {
            var inc = document.createElement('div'); inc.className = 'wc-note is-warn';
            inc.textContent = daText(
                card.incomplete_days + ' of these days are marked "gap": the phone stopped reporting for an hour or '
                    + 'more, so the auto figure saw only part of the day. Judge the rules on the other days.',
                card.incomplete_days + ' af dagene er markeret "hul": telefonen holdt op med at sende i en time '
                    + 'eller mere, så auto-tallet har kun set en del af dagen. Vurdér reglerne på de øvrige dage.');
            wrap.appendChild(inc);
        }

        if (card.note) {
            var note = document.createElement('div'); note.className = 'wc-note';
            note.textContent = daText(
                'Shadow only — not counted in your hours yet. Auto reads work-type places; punches are your current clock.',
                'Kun skygge — tælles ikke med i dine timer endnu. Auto læser arbejdssteder; stempling er dit nuværende ur.');
            wrap.appendChild(note);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function renderWorkChart(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card wch-card';
        buildWorkChart(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildWorkChart(wrap, card) {
        wrap.innerHTML = '';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = 'Work hours · ' + (card.title || '');
        wrap.appendChild(head);

        if (!card.has_data) {
            var empty = document.createElement('div');
            empty.className = 'prog-empty';
            empty.textContent = 'No hours logged in this period.';
            wrap.appendChild(empty);
            wrap.appendChild(wchControls(card, wrap));
            return;
        }

        var summary = document.createElement('div');
        summary.className = 'wch-summary';
        summary.innerHTML = '<span class="wch-total">' + progEsc(card.total) + '</span>'
            + '<span class="wch-avg">avg ' + progEsc(card.avg) + ' / ' + progEsc(card.bucket_word) + '</span>'
            + '<span class="wch-range">' + progEsc(card.range || '') + '</span>';
        wrap.appendChild(summary);

        var chart = document.createElement('div');
        chart.className = 'wch-chart';
        chart.innerHTML = wchBarsSvg(card);
        wrap.appendChild(chart);

        var readout = document.createElement('div');
        readout.className = 'prog-readout';
        wrap.appendChild(readout);
        wireWchTaps(chart, readout, card);

        // Per-workplace breakdown chips (only when >1 labelled place) — doubles as the
        // legend for the stacked bars.
        if ((card.places || []).length) {
            var bd = document.createElement('div');
            bd.className = 'work-breakdown';
            card.places.forEach(function (p, pi) {
                var chip = document.createElement('span');
                chip.className = 'work-place-total';
                if (card.stacked) {
                    var sw = document.createElement('span');
                    sw.className = 'chart-swatch';
                    sw.style.background = seriesColor(pi);
                    chip.appendChild(sw);
                }
                chip.appendChild(document.createTextNode((p.place || '—') + ' ' + p.total));
                bd.appendChild(chip);
            });
            wrap.appendChild(bd);
        }

        wrap.appendChild(wchControls(card, wrap));
    }

    function wchControls(card, wrap) {
        var box = document.createElement('div');
        box.className = 'prog-controls';
        var seg = document.createElement('div');
        seg.className = 'prog-seg';
        (card.modes || []).forEach(function (m) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'prog-seg-btn' + (m.key === card.mode ? ' on' : '');
            b.textContent = m.label;
            b.addEventListener('click', function () {
                if (m.key === card.mode) return;
                // Keep a workplace filter when switching presets (a custom range resets).
                var place = card.filter && card.filter.place;
                wchPost(place ? { period: m.key, place: place } : { period: m.key }, wrap);
            });
            seg.appendChild(b);
        });
        box.appendChild(seg);
        return box;
    }

    function wchPost(body, wrap) {
        wrap.classList.add('loading');
        return fetch('/api/work-summary.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
            wrap.classList.remove('loading');
            if (res && res.card) {
                buildWorkChart(wrap, res.card);
                // Keep the live refresh on the view the user just switched to.
                if (panelKind === 'work_chart' && cardPanelBody.contains(wrap)) panelCard = res.card;
            }
        }).catch(function () { wrap.classList.remove('loading'); });
    }

    function wireWchTaps(chart, readout, card) {
        var svg = chart.querySelector('.wch-svg');
        if (!svg) return;
        var bars = card.bars || [];

        function select(idx) {
            var b = bars[idx];
            if (!b) return;
            Array.prototype.forEach.call(svg.querySelectorAll('.wch-bar.sel'), function (el) { el.classList.remove('sel'); });
            Array.prototype.forEach.call(svg.querySelectorAll('.wch-bar[data-idx="' + idx + '"]'), function (el) { el.classList.add('sel'); });

            var tag = b.ongoing ? '<span class="prog-ro-tag est">on the clock</span>' : '';
            readout.innerHTML = '<span class="prog-ro-date">' + progEsc(wchWhen(card, b)) + '</span>'
                + '<span class="prog-ro-val">' + progEsc(b.minutes > 0 ? b.total : '0m') + '</span>'
                + (b.minutes > 0 ? '' : '<span class="prog-ro-detail">no hours</span>')
                + (card.stacked && b.split && b.minutes > 0
                    ? '<span class="prog-ro-detail">' + b.split.map(function (m, si) {
                        return m ? progEsc(((card.places[si] && card.places[si].place) || '—') + ' ' + wchFmtMin(m)) : '';
                    }).filter(Boolean).join(' · ') + '</span>'
                    : '')
                + tag;
        }

        Array.prototype.forEach.call(svg.querySelectorAll('.wch-hit'), function (h) {
            h.addEventListener('click', function () {
                select(parseInt(h.getAttribute('data-idx'), 10));
            });
        });
        // Default to the most recent bar that has hours (else the last bar).
        var def = bars.length - 1;
        for (var i = bars.length - 1; i >= 0; i--) { if (bars[i].minutes > 0) { def = i; break; } }
        select(def);
    }

    // ---- Feedback report card (admin) -------------------------------------------
    function fbPretty(t) {
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return String(t); }
    }

    function fbDate(s) {
        if (!s) return '';
        var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        if (!m) return String(s);
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1] + ' · ' + m[4] + ':' + m[5];
    }

    function renderFeedback(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card feedback-card';
        var title = document.createElement('div');
        title.className = 'plan-card-title';
        var n = (card.reports || []).length;
        var status = card.status || 'open';
        title.textContent = 'Feedback · ' + status + ' (' + n + ')';
        wrap.appendChild(title);

        // Filter chips — unresolved reports first in every view; a chip re-reads the list with that filter.
        var counts = card.counts || {};
        var chips = document.createElement('div');
        chips.className = 'di-chips';
        function drawChips() {
            var c = card.counts || {};
            chips.innerHTML = '';
            [['open', 'Open', c.open], ['resolved', 'Resolved', c.resolved], ['all', 'All', c.all]].forEach(function (f) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'di-chip' + (status === f[0] ? ' on' : '');
                b.textContent = f[1] + (f[2] != null ? ' ' + f[2] : '');
                b.addEventListener('click', function () {
                    if (status === f[0]) return;
                    b.disabled = true;
                    fetch('/api/feedback.php?status=' + encodeURIComponent(f[0]) + (card.limit ? '&limit=' + encodeURIComponent(card.limit) : ''), { credentials: 'same-origin' })
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .then(function (j) {
                            if (j && j.card && panelCard === card) refreshPanelCard(j.card);
                            else if (!j) { b.disabled = false; toast('Could not load the reports.'); }
                        })
                        .catch(function () { b.disabled = false; toast('Could not load the reports.'); });
                });
                chips.appendChild(b);
            });
        }
        if (counts.all != null) { drawChips(); wrap.appendChild(chips); }

        if (!n) {
            var empty = document.createElement('div');
            empty.className = 'prog-empty';
            empty.textContent = status === 'open' ? 'No open reports. 🎉' : 'No reports.';
            wrap.appendChild(empty);
        } else {
            card.reports.forEach(function (r) {
                wrap.appendChild(fbReport(r, function () {
                    // A report was resolved from the card: keep the chip numbers right.
                    if (card.counts) { card.counts.open = Math.max(0, card.counts.open - 1); card.counts.resolved++; drawChips(); }
                }, n === 1));
            });
        }
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Compact by default: id · from · status · date, the note (two lines) and the buttons; a tap on the header unfolds the thread and diagnostics.
    function fbReport(r, onResolved, startOpen) {
        var box = document.createElement('div');
        box.className = 'fb-report is-compact' + (startOpen ? ' is-open' : '');

        var head = document.createElement('div');
        head.className = 'fb-head';
        head.innerHTML = '<span class="fb-chev" aria-hidden="true">›</span><span class="fb-id">#' + r.id + '</span>'
            + '<span class="fb-from">' + progEsc(r.from || '') + '</span>'
            + '<span class="fb-status ' + progEsc(r.status || '') + '">' + progEsc(r.status || '') + '</span>'
            + '<span class="fb-when">' + progEsc(fbDate(r.when)) + '</span>';
        box.appendChild(head);
        head.setAttribute('role', 'button');
        head.tabIndex = 0;
        function toggle() { box.classList.toggle('is-open'); head.setAttribute('aria-expanded', box.classList.contains('is-open') ? 'true' : 'false'); }
        head.setAttribute('aria-expanded', startOpen ? 'true' : 'false');
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });

        if (r.note) {
            var note = document.createElement('div');
            note.className = 'fb-note';
            note.textContent = '“' + r.note + '”';
            note.addEventListener('click', toggle);
            box.appendChild(note);
        }

        var more = document.createElement('div');   // everything long: the conversation and the diagnostics
        more.className = 'fb-more';
        var conv = r.conversation || [];
        if (conv.length) {
            var thread = document.createElement('div');
            thread.className = 'fb-thread';
            conv.forEach(function (m) {
                // Tool results are raw JSON — keep them for debugging but collapsed, so
                // the thread reads like a normal conversation.
                if (m.role === 'tool') {
                    var d = document.createElement('details');
                    d.className = 'fb-tool';
                    var s = document.createElement('summary');
                    setIconText(s, 'wrench', (m.tool || 'tool') + ' — result');
                    var pre = document.createElement('pre');
                    pre.className = 'fb-tool-json';
                    pre.textContent = fbPretty(m.text || '');
                    d.appendChild(s);
                    d.appendChild(pre);
                    thread.appendChild(d);
                    return;
                }
                var el = document.createElement('div');
                el.className = 'fb-msg ' + (m.role || '') + (m.reported ? ' reported' : '');
                var lbl = document.createElement('div');
                lbl.className = 'fb-msg-role';
                lbl.textContent = (m.role === 'user' ? 'User' : 'Assistant') + (m.reported ? ' · reported' : '');
                var txt = document.createElement('div');
                txt.className = 'fb-msg-text';
                txt.textContent = m.text || '';
                el.appendChild(lbl);
                el.appendChild(txt);
                thread.appendChild(el);
            });
            more.appendChild(thread);
        }

        var det = document.createElement('details');
        det.className = 'fb-diag';
        var sum = document.createElement('summary');
        setIconText(sum, 'settings', 'diagnostics');
        det.appendChild(sum);
        var db = document.createElement('div');
        db.className = 'fb-diag-body';
        var parts = [];
        parts.push('<div><b>routing:</b> ' + progEsc((r.routing || []).join(', ') || '—')
            + (r.model ? ' · <b>model:</b> ' + progEsc(r.model) : '') + '</div>');
        if (r.tool_calls && r.tool_calls.length) {
            parts.push('<ul class="diag-calls">' + r.tool_calls.map(function (c) {
                return '<li><code>' + progEsc(c.name) + '</code> '
                    + (c.ok === false ? '<span class="diag-err">✗ ' + progEsc(c.error || '') + '</span>' : '✓')
                    + (c.args ? ' <span class="diag-args">' + progEsc(c.args) + '</span>' : '') + '</li>';
            }).join('') + '</ul>');
        }
        if (r.thoughts && r.thoughts.length) {
            parts.push('<div class="diag-thoughts-h"><b>thoughts:</b></div>'
                + r.thoughts.map(function (t) { return '<div class="diag-thought">' + progEsc(t) + '</div>'; }).join(''));
        }
        db.innerHTML = parts.join('');
        det.appendChild(db);
        more.appendChild(det);
        box.appendChild(more);

        var actions = document.createElement('div');
        actions.className = 'fb-actions';

        // Download the full report as a Markdown bundle to hand to the developer/Claude.
        var dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'fb-download';
        dl.textContent = '⬇ Download for dev';
        dl.addEventListener('click', function () { downloadUrl('/api/report-export.php?id=' + r.id); });
        actions.appendChild(dl);

        if (r.status !== 'resolved') {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fb-resolve';
            btn.textContent = 'Mark resolved';
            btn.addEventListener('click', function () {
                btn.disabled = true;
                btn.textContent = '…';
                fetch('/api/feedback.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ action: 'resolve', id: r.id })
                }).then(function (x) { return x.json(); }).then(function (res) {
                    if (res && res.ok) {
                        r.status = 'resolved';   // the stored card too, so reopening it doesn't offer the button again
                        var pill = head.querySelector('.fb-status');
                        if (pill) { pill.className = 'fb-status resolved'; pill.textContent = 'resolved'; }
                        btn.remove();   // keep the download button available after resolving
                        if (onResolved) onResolved();
                    } else {
                        btn.disabled = false;
                        btn.textContent = 'Mark resolved';
                        toast((res && res.error) || 'Could not update.');
                    }
                }).catch(function () {
                    btn.disabled = false;
                    btn.textContent = 'Mark resolved';
                    toast('Network error.');
                });
            });
            actions.appendChild(btn);
        }
        box.appendChild(actions);

        return box;
    }

    // Dev-ideas backlog: filter chips by status, and (for the developer) a status picker per
    // idea that saves straight away. The card object is updated in place so the panel snapshot
    // and the header count stay right without a refetch.
    var DEV_STATUS_LABELS = {
        new:         ['New', 'Ny'],
        in_progress: ['In progress', 'I gang'],
        done:        ['Done', 'Færdig']
    };
    function devStatusLabel(s) {
        var l = DEV_STATUS_LABELS[s] || [s, s];
        return daText(l[0], l[1]);
    }

    function renderDevIdeas(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card dev-ideas-card';
        var filter = card.filter || 'open';
        var items = card.items || [];

        var chips = document.createElement('div');
        chips.className = 'di-chips';
        var list = document.createElement('div');
        list.className = 'di-list';
        // Export: the ticked ideas, or — with nothing ticked — everything the current filter shows.
        var picked = {};
        var exportBar = document.createElement('div');
        exportBar.className = 'di-exportbar';
        var exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'di-export';
        exportBar.appendChild(exportBtn);
        wrap.appendChild(chips);
        wrap.appendChild(exportBar);
        wrap.appendChild(list);

        function exportLabel(n, shown) {
            var sel = Object.keys(picked).length;
            setIconText(exportBtn, 'download', sel
                ? daText('Export selected (' + sel + ')', 'Eksporter valgte (' + sel + ')')
                : daText('Export all shown (' + shown + ')', 'Eksporter alle viste (' + shown + ')'));
            exportBtn.disabled = !shown && !sel;
        }
        exportBtn.addEventListener('click', function () {
            var ids = Object.keys(picked);
            if (!ids.length) ids = items.filter(visible).map(function (i) { return i.id; });
            if (ids.length) downloadUrl('/api/dev-ideas-export.php?ids=' + ids.join(','));
        });

        function counts() {
            var c = { new: 0, in_progress: 0, done: 0 };
            items.forEach(function (i) { if (c[i.status] != null) c[i.status]++; });
            card.counts = c;
            return c;
        }

        function drawChips() {
            var c = counts();
            chips.innerHTML = '';
            [
                ['open', daText('Open', 'Åbne'), c.new + c.in_progress],
                ['new', devStatusLabel('new'), c.new],
                ['in_progress', devStatusLabel('in_progress'), c.in_progress],
                ['done', devStatusLabel('done'), c.done],
                ['all', daText('All', 'Alle'), items.length]
            ].forEach(function (f) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'di-chip' + (filter === f[0] ? ' on' : '');
                b.textContent = f[1] + ' ' + f[2];
                b.addEventListener('click', function () { filter = f[0]; card.filter = filter; draw(); });
                chips.appendChild(b);
            });
        }

        function visible(i) {
            if (filter === 'all') return true;
            if (filter === 'open') return i.status !== 'done';
            return i.status === filter;
        }

        function drawList() {
            list.innerHTML = '';
            var shown = items.filter(visible);
            if (!shown.length) {
                var empty = document.createElement('div');
                empty.className = 'prog-empty';
                empty.textContent = daText('Nothing here.', 'Intet her.');
                list.appendChild(empty);
                return;
            }
            shown.forEach(function (i) {
                var row = document.createElement('div');
                row.className = 'di-row ' + i.status + (i.priority === 'high' ? ' high' : '');

                var pick = document.createElement('input');
                pick.type = 'checkbox';
                pick.className = 'di-pick';
                pick.checked = !!picked[i.id];
                pick.setAttribute('aria-label', daText('Select idea #', 'Vælg idé #') + i.id);
                pick.addEventListener('change', function () {
                    if (pick.checked) picked[i.id] = true; else delete picked[i.id];
                    exportLabel(0, items.filter(visible).length);
                });
                row.appendChild(pick);

                var main = document.createElement('div');
                main.className = 'di-main';
                var text = document.createElement('div');
                text.className = 'di-text';
                text.textContent = i.idea;
                var meta = document.createElement('div');
                meta.className = 'di-meta';
                meta.textContent = '#' + i.id + (i.noted ? ' · ' + i.noted : '') + (i.from ? ' · ' + i.from : '');
                if (i.priority === 'high') {
                    var pri = document.createElement('span');
                    pri.className = 'di-pri';
                    pri.textContent = daText('High priority', 'Høj prioritet');
                    meta.appendChild(pri);
                }
                main.appendChild(text);
                main.appendChild(meta);
                if (i.details) {
                    var det = document.createElement('details');
                    det.className = 'di-details';
                    var sm = document.createElement('summary');
                    sm.textContent = daText('Details', 'Detaljer');
                    var body = document.createElement('div');
                    body.className = 'di-details-body';
                    appendLinkified(body, i.details);
                    det.appendChild(sm);
                    det.appendChild(body);
                    main.appendChild(det);
                }
                row.appendChild(main);

                if (card.can_edit) {
                    var sel = document.createElement('select');
                    sel.className = 'di-status ' + i.status;
                    sel.setAttribute('aria-label', daText('Status of idea #', 'Status for idé #') + i.id);
                    Object.keys(DEV_STATUS_LABELS).forEach(function (s) {
                        var o = document.createElement('option');
                        o.value = s;
                        o.textContent = devStatusLabel(s);
                        if (s === i.status) o.selected = true;
                        sel.appendChild(o);
                    });
                    sel.addEventListener('change', function () {
                        var before = i.status, next = sel.value;
                        sel.disabled = true;
                        fetch('/api/dev-ideas.php', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'same-origin',
                            body: JSON.stringify({ id: i.id, status: next })
                        }).then(function (x) { return x.json(); }).then(function (res) {
                            if (res && res.ok) {
                                i.status = next;
                                draw();
                                if (panelCard === card && cardPanelSub) cardPanelSub.textContent = cardSubFor(card);
                            } else {
                                sel.value = before;
                                sel.disabled = false;
                                toast((res && res.error) || daText('Could not update.', 'Kunne ikke opdatere.'));
                            }
                        }).catch(function () {
                            sel.value = before;
                            sel.disabled = false;
                            toast(daText('Network error.', 'Netværksfejl.'));
                        });
                    });
                    row.appendChild(sel);
                } else {
                    var pill = document.createElement('span');
                    pill.className = 'di-pill ' + i.status;
                    pill.textContent = devStatusLabel(i.status);
                    row.appendChild(pill);
                }
                list.appendChild(row);
            });
        }

        function draw() { drawChips(); drawList(); exportLabel(0, items.filter(visible).length); }
        draw();

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Scheduled tasks card: every task with a switch (pause/resume), its schedule and next run, and what the
    // last run came to (notified / quiet / error, with the run's closing words). The developer also gets the
    // built-in system jobs below, with who starts them (cPanel or the per-minute dispatcher) and their last output.
    function renderScheduledTasks(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card sched-card';

        // A routine action (Run now, Save, Discard, mode, answer a question) from a button: the card comes back and is redrawn.
        function act(body, btn, doneMsg) {
            btn.disabled = true;
            fetch('/api/scheduled-tasks.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify(body)
            }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (res) {
                if (res && res.ok && res.card) {
                    if (doneMsg) toast(doneMsg);
                    if (panelCard === card) refreshPanelCard(res.card);
                } else {
                    btn.disabled = false;
                    toast((res && res.error) || daText('Could not do that.', 'Kunne ikke det.'));
                }
            }).catch(function () { btn.disabled = false; toast(daText('Network error.', 'Netværksfejl.')); });
        }
        function actBtn(label, cls, onClick) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'sched-btn' + (cls ? ' ' + cls : '');
            b.textContent = label;
            b.addEventListener('click', function () { onClick(b); });
            return b;
        }

        function post(body, sw) {
            sw.disabled = true;
            fetch('/api/scheduled-tasks.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify(body)
            }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (res) {
                if (res && res.ok && res.card) {
                    if (panelCard === card) refreshPanelCard(res.card);
                } else {
                    sw.checked = !sw.checked; sw.disabled = false;
                    toast((res && res.error) || daText('Could not update.', 'Kunne ikke opdatere.'));
                }
            }).catch(function () {
                sw.checked = !sw.checked; sw.disabled = false;
                toast(daText('Network error.', 'Netværksfejl.'));
            });
        }

        function lastRun(t, isSystem) {
            var box = document.createElement('div');
            box.className = 'sched-last';
            if (!t.last_run) {
                box.textContent = daText('Has not run yet.', 'Har ikke kørt endnu.');
                box.classList.add('none');
                return box;
            }
            var res = document.createElement('div');
            res.className = 'sched-last-head';
            var state, cls;
            if (t.last_status === 'error') { state = daText('Error', 'Fejl'); cls = 'err'; }
            else if (isSystem) { state = t.last_status === 'skipped' ? daText('Skipped', 'Sprunget over') : daText('Ran OK', 'Kørte fint'); cls = 'ok'; }
            else if (t.notified) { state = daText('Notified you', 'Gav dig besked') + (t.last_title ? ': ' + t.last_title : ''); cls = 'notified'; }
            else { state = daText('Quiet — nothing to report', 'Stille — intet at melde'); cls = 'ok'; }
            var dot = document.createElement('span');
            dot.className = 'sched-dot ' + cls;
            res.appendChild(dot);
            res.appendChild(document.createTextNode(' ' + daText('Last run ', 'Sidst kørt ') + t.last_run + ' · ' + state
                + (isSystem && t.last_ms != null ? ' · ' + (t.last_ms >= 1000 ? (t.last_ms / 1000).toFixed(1) + ' s' : t.last_ms + ' ms') : '')));
            box.appendChild(res);
            var said = isSystem ? t.last_output : t.last_summary;
            if (said) {
                var det = document.createElement('details');
                det.className = 'sched-said';
                var sm = document.createElement('summary');
                sm.textContent = isSystem ? daText('Output', 'Output') : daText('What it said', 'Hvad den skrev');
                var body = document.createElement('div');
                body.className = 'sched-said-body' + (isSystem ? ' mono' : '');
                appendLinkified(body, said);
                det.appendChild(sm);
                det.appendChild(body);
                box.appendChild(det);
            }
            return box;
        }

        function toggle(label, checked, onChange) {
            var l = document.createElement('label');
            l.className = 'sched-switch';
            l.title = checked ? daText('Active — tap to pause', 'Aktiv — tryk for at sætte på pause') : daText('Paused — tap to resume', 'På pause — tryk for at genoptage');
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = checked;
            cb.setAttribute('role', 'switch');
            cb.setAttribute('aria-label', label);
            var track = document.createElement('span');
            track.className = 'sched-track';
            l.appendChild(cb);
            l.appendChild(track);
            cb.addEventListener('change', function () { onChange(cb); });
            return { el: l, input: cb };
        }

        // The builder: one form for a new routine and for editing one (name, what it does, what starts it, conditions, ask first).
        // It sends the same fields the assistant's create_routine / update_routine take, so the same checks answer.
        function builderForm(t) {
            var editing = !!t;
            var trig = (t && t.trigger) || {};
            var cond = (t && t.conditions) || {};
            var places = card.places || [];
            var form = document.createElement('div');
            form.className = 'sched-form';
            function field(label, el) {
                var l = document.createElement('label');
                l.className = 'sched-field';
                var sp = document.createElement('span');
                sp.textContent = label;
                l.appendChild(sp);
                l.appendChild(el);
                form.appendChild(l);
                return l;
            }
            function input(type, value, ph) {
                var i = document.createElement('input');
                i.type = type;
                i.value = value == null ? '' : value;
                if (ph) i.placeholder = ph;
                return i;
            }
            function select(opts, value) {
                var sel = document.createElement('select');
                opts.forEach(function (o) {
                    var op = document.createElement('option');
                    op.value = o[0]; op.textContent = o[1];
                    if (o[0] === value) op.selected = true;
                    sel.appendChild(op);
                });
                return sel;
            }
            var name = input('text', t ? t.label : '', daText('e.g. Leaving', 'fx Forlader hjemmet'));
            field(daText('Name', 'Navn'), name);
            var instr = document.createElement('textarea');
            instr.rows = 3;
            instr.value = t ? t.instruction : '';
            instr.placeholder = daText('What to do, e.g. “Turn off all lights and set the heating to 17 °C.”', 'Hvad der skal ske, fx “Sluk alle lys og sæt varmen til 17 °C.”');
            field(daText('What it does', 'Hvad den gør'), instr);

            // What starts it. An existing routine keeps its kind (a phrase routine stays a phrase routine).
            var kinds = [['phrase', daText('I say a phrase', 'Jeg siger en sætning')], ['leave', daText('I leave a place', 'Jeg forlader et sted')],
                ['enter', daText('I arrive at a place', 'Jeg ankommer til et sted')], ['sensor', daText('A sensor reads …', 'En sensor måler …')]];
            var kind0 = !editing ? 'phrase' : t.trigger_type === 'place' ? (trig.event === 'enter' ? 'enter' : 'leave') : t.trigger_type;
            if (editing) kinds = kinds.filter(function (k) { return t.trigger_type === 'place' ? k[0] === 'leave' || k[0] === 'enter' : k[0] === t.trigger_type; });
            var kindSel = select(kinds, kind0);
            field(daText('Starts when', 'Starter når'), kindSel);

            var phr = input('text', (t && t.phrases || []).join(', '), daText('I\'m leaving, jeg smutter', 'jeg smutter, I\'m leaving'));
            var phrField = field(daText('Phrases (comma separated)', 'Sætninger (adskilt med komma)'), phr);

            var placeOpts = places.map(function (p) { return [p.name, p.name]; })
                .concat([['type:home', daText('any home place', 'ethvert hjem-sted')], ['type:work', daText('any work place', 'ethvert arbejdssted')]]);
            var placeVal = '';
            if (trig.place_ids && trig.place_ids.length) {
                var pm = places.filter(function (p) { return p.id === trig.place_ids[0]; })[0];
                placeVal = pm ? pm.name : '';
            } else if (trig.place_types && trig.place_types.length) placeVal = 'type:' + trig.place_types[0];
            var placeSel = select(placeOpts, placeVal);
            var placeField = field(daText('Place', 'Sted'), placeSel);

            var sName = input('text', trig.sensor ? String(trig.sensor).replace(/_/g, ' ') : '', daText('kitchen light', 'køkkenlys'));
            var sOp = select([['below', daText('goes below', 'går under')], ['above', daText('goes above', 'går over')], ['is', daText('becomes', 'bliver')]], trig.op || 'below');
            var sVal = input('text', trig.value == null ? '' : trig.value, daText('50 or open', '50 eller åben'));
            var sensorBox = document.createElement('div');
            sensorBox.className = 'sched-sensor';
            [sName, sOp, sVal].forEach(function (e) { sensorBox.appendChild(e); });
            var sensorField = field(daText('Sensor', 'Sensor'), sensorBox);

            function showKind() {
                var k = kindSel.value;
                placeField.hidden = k !== 'leave' && k !== 'enter';
                sensorField.hidden = k !== 'sensor';
            }
            kindSel.addEventListener('change', showKind);
            showKind();

            // Only when …
            var days = document.createElement('div');
            days.className = 'sched-days';
            var dayBtns = [];
            [[1, 'Mon', 'Man'], [2, 'Tue', 'Tir'], [3, 'Wed', 'Ons'], [4, 'Thu', 'Tor'], [5, 'Fri', 'Fre'], [6, 'Sat', 'Lør'], [7, 'Sun', 'Søn']].forEach(function (d) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'sched-day' + ((cond.weekdays || []).indexOf(d[0]) >= 0 ? ' on' : '');
                b.textContent = daText(d[1], d[2]);
                b.dataset.day = d[0];
                b.addEventListener('click', function () { b.classList.toggle('on'); });
                days.appendChild(b);
                dayBtns.push(b);
            });
            field(daText('Only on (none = every day)', 'Kun på (ingen = alle dage)'), days);
            var from = input('time', (cond.between || [])[0] || '');
            var to = input('time', (cond.between || [])[1] || '');
            var win = document.createElement('div');
            win.className = 'sched-window';
            win.appendChild(from); win.appendChild(document.createTextNode(' – ')); win.appendChild(to);
            field(daText('Only between', 'Kun mellem'), win);
            var cool = input('number', cond.cooldown_minutes || '', daText('minutes', 'minutter'));
            cool.min = '0'; cool.max = '1440';
            field(daText('Not again within (minutes)', 'Ikke igen inden for (minutter)'), cool);
            function check(label, on) {
                var l = document.createElement('label');
                l.className = 'sched-check';
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!on;
                l.appendChild(cb);
                l.appendChild(document.createTextNode(' ' + label));
                form.appendChild(l);
                return cb;
            }
            var until = input('date', cond.until && /^\d{4}-\d{2}-\d{2}$/.test(cond.until) ? cond.until : '');
            field(daText('Only until (date, optional)', 'Kun til og med (dato, valgfri)'), until);
            var once = check(daText('One-off: finish after the first run', 'Engangs: afslut efter første kørsel'), cond.once);
            var away = check(daText('Only when I am away from home', 'Kun når jeg er væk hjemmefra'), cond.away);
            var others = check(daText('Only if nobody else is home', 'Kun hvis ingen andre er hjemme'), cond.others_away);
            var ask = check(daText('Ask me first, then run', 'Spørg mig først, og kør så'), t && t.run_mode === 'ask');

            var actions = document.createElement('div');
            actions.className = 'sched-actions';
            actions.appendChild(actBtn(daText('Save', 'Gem'), 'primary', function (b) {
                var k = kindSel.value;
                var body = {
                    action: editing ? 'edit' : 'build', name: name.value.trim(), instruction: instr.value.trim(),
                    phrases: phr.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
                    mode: ask.checked ? 'ask' : 'auto'
                };
                if (editing) body.id = t.id;
                // keep what the form has no field for (place conditions, a start date, an until time of day) — editing must not drop it
                var c = {};
                ['in_places', 'out_places', 'from'].forEach(function (k) { if (cond[k] && cond[k].length) c[k] = cond[k]; });
                if (until.value) c.until = until.value; else if (cond.until && !/^\d{4}-\d{2}-\d{2}$/.test(cond.until)) c.until = cond.until;
                if (once.checked) c.once = true;
                var wd = dayBtns.filter(function (x) { return x.classList.contains('on'); }).map(function (x) { return parseInt(x.dataset.day, 10); });
                if (wd.length) c.weekdays = wd;
                if (from.value && to.value) c.between = [from.value, to.value];
                if (parseInt(cool.value, 10) > 0) c.cooldown_minutes = parseInt(cool.value, 10);
                if (away.checked) c.away = true;
                if (others.checked) c.others_away = true;
                body.conditions = c;
                if (k === 'leave' || k === 'enter') {
                    body.trigger_event = k;
                    if (placeSel.value.indexOf('type:') === 0) body.trigger_place_type = placeSel.value.slice(5); else body.trigger_place = placeSel.value;
                } else if (k === 'sensor') {
                    body.trigger_sensor = sName.value.trim();
                    body.trigger_sensor_op = sOp.value;
                    body.trigger_sensor_value = sVal.value.trim();
                }
                if (!body.name || !body.instruction) { toast(daText('Give it a name and say what it does.', 'Giv den et navn og skriv hvad den gør.')); return; }
                act(body, b, editing ? daText('Saved.', 'Gemt.') : daText('Routine saved — it is live.', 'Rutine gemt — den er aktiv.'));
            }));
            actions.appendChild(actBtn(daText('Cancel', 'Annullér'), '', function () { if (panelCard === card) refreshPanelCard(card); }));
            form.appendChild(actions);
            return form;
        }

        function row(t, isSystem) {
            var el = document.createElement('div');
            el.className = 'sched-row ' + t.status + (isSystem ? ' system' : '');
            var head = document.createElement('div');
            head.className = 'sched-head';
            var name = document.createElement('div');
            name.className = 'sched-name';
            name.textContent = t.label;
            head.appendChild(name);
            if (t.status === 'done') {
                var done = document.createElement('span');
                done.className = 'sched-pill';
                done.textContent = daText('Done', 'Færdig');
                head.appendChild(done);
            } else if (t.status === 'draft') {
                var dr = document.createElement('span');
                dr.className = 'sched-pill draft';
                dr.textContent = daText('Draft — not saved yet', 'Kladde — ikke gemt endnu');
                head.appendChild(dr);
            } else {
                var sw = toggle(t.label, t.status === 'active', function (cb) {
                    var body = { action: cb.checked ? 'resume' : 'pause' };
                    if (isSystem) body.system_task = t.key; else body.id = t.id;
                    post(body, cb);
                });
                head.appendChild(sw.el);
            }
            el.appendChild(head);

            var meta = document.createElement('div');
            meta.className = 'sched-meta';
            var bits = [t.schedule];
            if (t.status === 'active' && t.next_run) bits.push(daText('next ', 'næste ') + t.next_run);
            else if (t.status === 'paused') bits.push(daText('paused', 'på pause'));
            if (!isSystem && t.tell_always) bits.push(daText('tells you every time', 'melder hver gang'));
            if (!isSystem && t.routine && t.conditions_text) bits.push(t.conditions_text);
            if (!isSystem && t.status === 'active' && !t.once && (t.routine || t.run_mode === 'ask')) bits.push(t.run_mode === 'ask' ? daText('asks you first', 'spørger dig først') : daText('runs by itself', 'kører af sig selv'));
            if (!isSystem && t.steps) bits.push(daText('runs ' + t.steps + ' recorded step' + (t.steps === 1 ? '' : 's'), 'kører ' + t.steps + ' optaget' + (t.steps === 1 ? ' trin' : ' trin')));
            meta.textContent = bits.join(' · ');
            if (isSystem) {
                var trig = document.createElement('span');
                trig.className = 'sched-pill';
                trig.textContent = t.mode === 'dispatcher' ? daText('Dispatcher', 'Dispatcher') : 'cPanel';
                trig.title = t.mode === 'dispatcher' ? daText('Started by the per-minute scheduled-tasks cron', 'Startes af det minutlige cron-job')
                    : daText("Started by the server's own cron entry", 'Startes af serverens egen cron-linje');
                meta.appendChild(trig);
            }
            el.appendChild(meta);

            var info = isSystem ? t.description : t.instruction;
            if (info) {
                var d = document.createElement('div');
                d.className = 'sched-desc';
                d.textContent = info;
                el.appendChild(d);
            }
            el.appendChild(lastRun(t, isSystem));

            if (!isSystem && t.status === 'draft') {
                var da = document.createElement('div');
                da.className = 'sched-actions';
                da.appendChild(actBtn(daText('Save', 'Gem'), 'primary', function (b) { act({ id: t.id, action: 'save' }, b, daText('Saved — it is live.', 'Gemt — den er aktiv.')); }));
                da.appendChild(actBtn(daText('Edit', 'Rediger'), '', function () { el.replaceWith(builderForm(t)); }));
                da.appendChild(actBtn(daText('Discard', 'Kassér'), '', function (b) { act({ id: t.id, action: 'discard' }, b); }));
                el.appendChild(da);
            } else if (!isSystem && t.status === 'active') {
                var ra = document.createElement('div');
                ra.className = 'sched-actions';
                ra.appendChild(actBtn(daText('Run now', 'Kør nu'), '', function (b) { act({ id: t.id, action: 'run' }, b, daText('Started — you will get a notification when it is done.', 'Startet — du får en besked når den er færdig.')); }));
                if (!t.once) {
                    ra.appendChild(actBtn(t.run_mode === 'ask' ? daText('Run by itself', 'Kør af sig selv') : daText('Ask me first', 'Spørg mig først'), '',
                        function (b) { act({ id: t.id, action: 'mode', value: t.run_mode === 'ask' ? 'auto' : 'ask' }, b); }));
                }
                if (t.can_undo) {
                    ra.appendChild(actBtn(daText('Undo last run', 'Fortryd sidste kørsel'), '', function (b) { act({ id: t.id, action: 'undo' }, b, daText('Put back.', 'Sat tilbage.')); }));
                }
                if (t.steps) {
                    ra.appendChild(actBtn(daText('Re-learn steps', 'Lær trinnene igen'), '', function (b) { act({ id: t.id, action: 'forget' }, b, daText('Forgotten — the next run learns them again.', 'Glemt — næste kørsel lærer dem igen.')); }));
                }
                if (t.routine) {
                    ra.appendChild(actBtn(daText('Edit', 'Rediger'), '', function () { el.replaceWith(builderForm(t)); }));
                }
                el.appendChild(ra);
            }

            if (!isSystem && t.conversation_id) {
                var open = document.createElement('button');
                open.type = 'button';
                open.className = 'sched-open' + (t.unseen ? ' unseen' : '');
                setIconText(open, 'message-square', daText('Open the runs', 'Åbn kørslerne'));
                open.addEventListener('click', function () { loadConversation(t.conversation_id).catch(function () { toast(daText('That conversation is gone.', 'Samtalen findes ikke mere.')); }); });
                el.appendChild(open);
            }
            return el;
        }

        (card.requests || []).forEach(function (q) {
            var box = document.createElement('div');
            box.className = 'sched-ask';
            var tx = document.createElement('div');
            tx.className = 'sched-ask-text';
            tx.textContent = daText('Run “' + q.label + '”? ', 'Kør “' + q.label + '”? ') + q.trigger_text + ' · ' + q.at;
            box.appendChild(tx);
            var bt = document.createElement('div');
            bt.className = 'sched-actions';
            bt.appendChild(actBtn(daText('Run it', 'Kør den'), 'primary', function (b) { act({ action: 'answer', request_id: q.id, approve: true }, b, daText('Started.', 'Startet.')); }));
            bt.appendChild(actBtn(daText('Skip', 'Spring over'), '', function (b) { act({ action: 'answer', request_id: q.id, approve: false }, b); }));
            box.appendChild(bt);
            wrap.appendChild(box);
        });

        var newBar = document.createElement('div');
        newBar.className = 'sched-actions sched-new';
        newBar.appendChild(actBtn('+ ' + daText('New routine', 'Ny rutine'), 'primary', function () { newBar.replaceWith(builderForm(null)); }));
        wrap.appendChild(newBar);

        var items = card.items || [];
        if (!items.length) {
            var empty = document.createElement('div');
            empty.className = 'prog-empty';
            empty.textContent = daText(
                'No scheduled tasks yet. Ask me, e.g. "every weekday at 8, check my mail for invoices and tell me if there are any".',
                'Ingen planlagte opgaver endnu. Spørg mig fx: "hver hverdag kl. 8, tjek min mail for fakturaer og sig til hvis der er nogen".');
            wrap.appendChild(empty);
        }
        items.forEach(function (t) { wrap.appendChild(row(t, false)); });

        if (card.system && card.system.length) {
            var h = document.createElement('div');
            h.className = 'sched-section';
            h.textContent = daText('System jobs', 'Systemjobs');
            wrap.appendChild(h);
            card.system.forEach(function (t) { wrap.appendChild(row(t, true)); });
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Expense/receipt card: editable draft with a single Confirm, or a saved view.
    function renderReceipt(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card receipt-card';
        buildReceipt(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildReceipt(wrap, card, onChange) {
        wrap.innerHTML = '';
        var confirmed = card.status === 'confirmed';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = confirmed ? 'Expense saved ✓' : 'New expense — check & confirm';
        wrap.appendChild(head);

        if (card.image_url) {
            var img = document.createElement('img');
            img.className = 'receipt-thumb';
            img.src = card.image_url;
            img.alt = 'receipt';
            img.addEventListener('click', function () { openLightbox(card.image_url); });
            wrap.appendChild(img);
        }

        var fields = document.createElement('div');
        fields.className = 'receipt-fields';
        var inputs = {};
        function field(label, key, type, value, options) {
            var row = document.createElement('label');
            row.className = 'receipt-field rf-' + key;
            var l = document.createElement('span');
            l.className = 'receipt-label';
            l.textContent = label;
            row.appendChild(l);
            var el;
            if (type === 'select') {
                el = document.createElement('select');
                (options || []).forEach(function (c) {
                    var o = document.createElement('option');
                    o.value = c; o.textContent = c;
                    if (c === value) o.selected = true;
                    el.appendChild(o);
                });
            } else {
                el = document.createElement('input');
                el.type = type;
                if (value !== null && value !== undefined) el.value = value;
                if (type === 'number') { el.step = '0.01'; el.inputMode = 'decimal'; }
            }
            el.disabled = confirmed;
            row.appendChild(el);
            fields.appendChild(row);
            inputs[key] = el;
        }

        // Currency options — common ones, plus whatever was read (so a mis-read value
        // is still selectable/correctable rather than lost).
        var curOpts = ['DKK', 'EUR', 'USD', 'GBP', 'SEK', 'NOK', 'CHF'];
        if (card.currency && curOpts.indexOf(card.currency) === -1) curOpts.unshift(card.currency);

        field('Vendor', 'vendor', 'text', card.vendor);
        field('Date', 'date', 'date', card.date);
        field('Total', 'total', 'number', card.total != null ? card.total : '');
        field('Currency', 'currency', 'select', card.currency || 'DKK', curOpts);
        field('VAT / moms', 'vat', 'number', card.vat != null ? card.vat : '');
        field('Category', 'category', 'select', card.category, card.categories);
        field('Note', 'note', 'text', card.note);
        wrap.appendChild(fields);

        function num(v) { return parseFloat(String(v).replace(',', '.')); }
        function round2(n) { return Math.round(n * 100) / 100; }

        // Editable line items: the AI can misread a description/amount, or miss a line
        // entirely — so the user can edit each field, remove a bad row, or add a missing
        // one. Total & VAT follow the items' sum automatically (VAT keeps its effective
        // rate) UNTIL the user edits Total/VAT by hand, which "unlinks" them — for the odd
        // receipt whose lines don't sum to the printed total (deposit, discount, fee).
        // The list is saved on Confirm.
        var lineItems = (card.line_items || []).map(function (li) {
            return {
                description: li.description || '',
                qty: (li.qty != null ? li.qty : null),
                amount: (li.amount != null ? li.amount : null),
            };
        });

        // Effective VAT rate, derived once, so we can preserve it when the total changes.
        var vatRate = null;
        (function () {
            var t = num(inputs.total.value), v = num(inputs.vat.value);
            if (!isNaN(t) && t > 0 && !isNaN(v) && v > 0) vatRate = v / t;
        })();

        function itemsSum() {
            return lineItems.reduce(function (s, li) {
                var a = (li.amount == null) ? 0 : li.amount;
                return s + (isNaN(a) ? 0 : a);
            }, 0);
        }

        // Total tracks the items' sum only while "linked". Start linked when there are
        // items and their sum already matches the read total (so we never clobber a good
        // total that includes a fee/deposit the lines don't itemise).
        var totalLinked = (function () {
            if (!lineItems.length) return false;
            var t = num(inputs.total.value);
            return !isNaN(t) && Math.abs(round2(itemsSum()) - t) < 0.01;
        })();

        var itemsWrap = document.createElement('div');
        itemsWrap.className = 'receipt-items';
        wrap.appendChild(itemsWrap);
        var sumEl = null, mismatchEl = null;

        function refreshItemsInfo() {
            if (sumEl) sumEl.textContent = 'Sum ' + fmtMoney(round2(itemsSum()), card.currency || 'DKK');
            if (mismatchEl) {
                var t = num(inputs.total.value);
                var diff = !isNaN(t) && Math.abs(round2(itemsSum()) - t) >= 0.01;
                mismatchEl.hidden = !(diff && lineItems.length && !totalLinked);
            }
        }

        function syncTotals() {
            if (totalLinked) {
                var sum = round2(itemsSum());
                inputs.total.value = sum;
                if (vatRate != null) inputs.vat.value = round2(sum * vatRate);
                checkVat();
            }
            refreshItemsInfo();
        }

        function renderItems() {
            itemsWrap.innerHTML = '';
            sumEl = null; mismatchEl = null;
            if (!lineItems.length && confirmed) { itemsWrap.hidden = true; return; }
            itemsWrap.hidden = false;

            var head = document.createElement('div');
            head.className = 'receipt-items-head';
            var lbl = document.createElement('span');
            lbl.textContent = 'Items';
            sumEl = document.createElement('span');
            sumEl.className = 'receipt-items-sum';
            head.appendChild(lbl);
            head.appendChild(sumEl);
            itemsWrap.appendChild(head);

            lineItems.forEach(function (li, idx) {
                var row = document.createElement('div');
                row.className = 'receipt-item' + (confirmed ? ' is-confirmed' : '');

                if (confirmed) {
                    var name = document.createElement('span');
                    name.className = 'receipt-item-name';
                    var q = (li.qty != null && li.qty !== 1) ? (li.qty + '× ') : '';
                    name.textContent = q + (li.description || '');
                    var amt = document.createElement('span');
                    amt.className = 'receipt-item-amt';
                    amt.textContent = li.amount != null ? fmtMoney(li.amount, card.currency || 'DKK') : '';
                    row.appendChild(name);
                    row.appendChild(amt);
                } else {
                    var desc = document.createElement('input');
                    desc.type = 'text'; desc.className = 'receipt-item-desc';
                    desc.placeholder = 'Item'; desc.value = li.description || '';
                    desc.addEventListener('input', function () { lineItems[idx].description = desc.value; });

                    var qtyIn = document.createElement('input');
                    qtyIn.type = 'number'; qtyIn.className = 'receipt-item-qty';
                    qtyIn.step = 'any'; qtyIn.inputMode = 'decimal'; qtyIn.title = 'Qty';
                    qtyIn.value = (li.qty != null ? li.qty : '');
                    qtyIn.addEventListener('input', function () {
                        var q = num(qtyIn.value); lineItems[idx].qty = isNaN(q) ? null : q;
                    });

                    var amtIn = document.createElement('input');
                    amtIn.type = 'number'; amtIn.className = 'receipt-item-amt-in';
                    amtIn.step = '0.01'; amtIn.inputMode = 'decimal'; amtIn.title = 'Amount';
                    amtIn.value = (li.amount != null ? li.amount : '');
                    amtIn.addEventListener('input', function () {
                        var a = num(amtIn.value); lineItems[idx].amount = isNaN(a) ? null : a; syncTotals();
                    });

                    var rm = document.createElement('button');
                    rm.type = 'button'; rm.className = 'receipt-item-rm';
                    rm.title = 'Remove line'; rm.setAttribute('aria-label', 'Remove line'); rm.textContent = '×';
                    rm.addEventListener('click', function () {
                        lineItems.splice(idx, 1); renderItems(); syncTotals();
                    });

                    row.appendChild(desc); row.appendChild(qtyIn); row.appendChild(amtIn); row.appendChild(rm);
                }
                itemsWrap.appendChild(row);
            });

            if (!confirmed) {
                mismatchEl = document.createElement('div');
                mismatchEl.className = 'receipt-items-mismatch';
                mismatchEl.hidden = true;
                var mText = document.createElement('span');
                mText.textContent = 'Items don’t add up to the total. ';
                var mLink = document.createElement('button');
                mLink.type = 'button'; mLink.className = 'receipt-items-relink'; mLink.textContent = 'Use items sum';
                mLink.addEventListener('click', function () { totalLinked = true; syncTotals(); });
                mismatchEl.appendChild(mText); mismatchEl.appendChild(mLink);
                itemsWrap.appendChild(mismatchEl);

                var add = document.createElement('button');
                add.type = 'button'; add.className = 'receipt-add-line'; add.textContent = '+ Add line';
                add.addEventListener('click', function () {
                    lineItems.push({ description: '', qty: null, amount: null });
                    renderItems();
                    var descs = itemsWrap.querySelectorAll('.receipt-item-desc');
                    if (descs.length) descs[descs.length - 1].focus();
                });
                itemsWrap.appendChild(add);
            }

            refreshItemsInfo();
        }
        renderItems();

        // Possible-duplicate note (non-blocking) — same vendor/date/amount exists.
        if (card.duplicate) {
            var dup = document.createElement('div');
            dup.className = 'receipt-dup-hint';
            dup.textContent = 'Possible duplicate — you already logged '
                + (card.duplicate.vendor || 'this') + ' on ' + (card.duplicate.date || '')
                + (card.duplicate.confirmed ? '' : ' (a draft)') + '.';
            dup.insertBefore(iconEl('triangle-alert', 'ic-lead'), dup.firstChild);
            wrap.appendChild(dup);
        }

        // Danish moms is 25% → VAT on a gross total should be total × 0.20. Just
        // state it when it doesn't match (never blocks saving); updates live.
        var vatHint = document.createElement('div');
        vatHint.className = 'receipt-vat-hint';
        vatHint.hidden = true;
        wrap.appendChild(vatHint);

        function checkVat() {
            var cur = inputs.currency ? inputs.currency.value : (card.currency || 'DKK');
            var total = num(inputs.total.value);
            var vat = num(inputs.vat.value);
            // 25% moms is a Danish (DKK) rule — only check then.
            if (cur !== 'DKK' || !(total > 0) || isNaN(vat)) { vatHint.hidden = true; return; }
            var expected = total * 0.20;
            if (Math.abs(vat - expected) > 1) {
                vatHint.hidden = false;
                vatHint.textContent = 'VAT isn\'t 25% — 25% of this total would be '
                    + fmtMoney(expected, cur) + '.';
                vatHint.insertBefore(iconEl('triangle-alert', 'ic-lead'), vatHint.firstChild);
            } else {
                vatHint.hidden = true;
            }
        }
        checkVat();

        // A booked/confirmed expense stays deletable (corrections, test cleanup) — the
        // delete is trailed server-side. No edit fields, just a Delete action.
        if (confirmed) {
            var cactions = document.createElement('div');
            cactions.className = 'receipt-actions';
            var delOnly = document.createElement('button');
            delOnly.type = 'button'; delOnly.className = 'receipt-discard'; delOnly.textContent = 'Delete';
            cactions.appendChild(delOnly);
            wrap.appendChild(cactions);
            delOnly.addEventListener('click', function () {
                if (!window.confirm('Delete this expense?')) return;
                delOnly.disabled = true;
                receiptAction({ action: 'discard', id: card.id }).then(function (res) {
                    if (res && res.deleted) { if (onChange) onChange(); else wrap.remove(); }
                    else delOnly.disabled = false;
                }).catch(function () { delOnly.disabled = false; });
            });
            return;
        }

        // Editing Total/VAT by hand takes manual control (unlinks from the items sum).
        inputs.total.addEventListener('input', function () {
            totalLinked = false;
            // Re-derive the VAT rate from the hand-typed total so future line edits keep it.
            var t = num(inputs.total.value), v = num(inputs.vat.value);
            vatRate = (!isNaN(t) && t > 0 && !isNaN(v) && v > 0) ? v / t : vatRate;
            checkVat(); refreshItemsInfo();
        });
        inputs.vat.addEventListener('input', function () {
            totalLinked = false;
            var t = num(inputs.total.value), v = num(inputs.vat.value);
            vatRate = (!isNaN(t) && t > 0 && !isNaN(v) && v > 0) ? v / t : vatRate;
            checkVat();
        });
        if (inputs.currency) inputs.currency.addEventListener('change', checkVat);

        var actions = document.createElement('div');
        actions.className = 'receipt-actions';
        var confirmBtn = document.createElement('button');
        confirmBtn.type = 'button'; confirmBtn.className = 'receipt-confirm'; confirmBtn.textContent = 'Confirm';
        var discardBtn = document.createElement('button');
        discardBtn.type = 'button'; discardBtn.className = 'receipt-discard'; discardBtn.textContent = 'Discard';
        actions.appendChild(confirmBtn);
        actions.appendChild(discardBtn);
        wrap.appendChild(actions);

        confirmBtn.addEventListener('click', function () {
            confirmBtn.disabled = true; discardBtn.disabled = true;
            var body = { action: 'confirm', id: card.id };
            Object.keys(inputs).forEach(function (k) { body[k] = inputs[k].value; });
            body.line_items = lineItems;
            receiptAction(body).then(function (res) {
                if (res && res.card) { if (onChange) onChange(); else buildReceipt(wrap, res.card); }
                else { confirmBtn.disabled = false; discardBtn.disabled = false; }
            }).catch(function () { confirmBtn.disabled = false; discardBtn.disabled = false; });
        });
        discardBtn.addEventListener('click', function () {
            if (!window.confirm('Discard this expense?')) return;
            receiptAction({ action: 'discard', id: card.id }).then(function (res) {
                if (res && res.deleted) { if (onChange) onChange(); else wrap.remove(); }
            }).catch(function () {});
        });
    }

    function receiptAction(body) {
        return fetch('/api/receipt.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });
    }

    // ---- Income (invoices / revenue) — the income-side sibling of the receipt card ----

    function renderIncome(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card receipt-card income-card';
        buildIncome(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildIncome(wrap, card, onChange) {
        wrap.innerHTML = '';
        var booked = card.status === 'booked';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = booked
            ? daText('Income booked ✓', 'Indtægt bogført ✓')
            : daText('New income — check & confirm', 'Ny indtægt — tjek & bekræft');
        wrap.appendChild(head);

        // The attached bilag (invoice). PDFs open in a new tab; images show a thumb.
        if (card.has_image && card.image_url) {
            if ((card.mime || '').indexOf('pdf') !== -1) {
                var pdfLink = document.createElement('a');
                pdfLink.className = 'income-bilag';
                pdfLink.href = card.image_url;
                pdfLink.target = '_blank';
                pdfLink.rel = 'noopener';
                setIconText(pdfLink, 'file-text', daText('View invoice (PDF)', 'Åbn faktura (PDF)'));
                wrap.appendChild(pdfLink);
            } else {
                var img = document.createElement('img');
                img.className = 'receipt-thumb';
                img.src = card.image_url;
                img.alt = 'invoice';
                img.addEventListener('click', function () { openLightbox(card.image_url); });
                wrap.appendChild(img);
            }
        }

        // Attach (or replace) the invoice file on an entry that already exists — e.g. one
        // created in chat, where the PDF only arrives afterwards.
        if (card.id) {
            var attach = document.createElement('button');
            attach.type = 'button';
            attach.className = 'ghost income-attach';
            setIconText(attach, 'file-plus', card.has_image
                ? daText('Replace invoice file', 'Erstat fakturafil')
                : daText('Attach invoice (PDF or photo)', 'Vedhæft faktura (PDF eller foto)'));
            attach.addEventListener('click', function () {
                pickFile('image/*,application/pdf', function (f) {
                    attach.disabled = true;
                    setIconText(attach, 'file-plus', daText('Uploading…', 'Uploader…'));
                    incomeAttachFile(card.id, f).then(function (j) {
                        if (j && j.card) {
                            buildIncome(wrap, j.card, onChange);
                            if (onChange) onChange(j.card);
                        } else {
                            attach.disabled = false;
                            setIconText(attach, 'file-plus', daText('Upload failed — try again',
                                                                    'Upload mislykkedes — prøv igen'));
                        }
                    });
                });
            });
            wrap.appendChild(attach);
        }

        // Generated (private) invoice: a printable document link + the line items.
        if (card.invoice_url) {
            var docLink = document.createElement('a');
            docLink.className = 'income-bilag income-invoice-doc';
            docLink.href = card.invoice_url;
            docLink.target = '_blank';
            docLink.rel = 'noopener';
            setIconText(docLink, 'file-text', daText('Open / print invoice', 'Åbn / print faktura')
                + (card.doc_number ? ' · ' + card.doc_number : ''));
            wrap.appendChild(docLink);

            var lines = card.line_items || [];
            if (lines.length) {
                var ul = document.createElement('ul');
                ul.className = 'income-lines';
                lines.forEach(function (l) {
                    var li = document.createElement('li');
                    var d = document.createElement('span'); d.className = 'income-line-desc';
                    d.textContent = (l.qty && l.qty !== 1 ? l.qty + '× ' : '') + (l.description || '');
                    var a = document.createElement('span'); a.className = 'books-amt';
                    a.textContent = fmtMoney(l.amount, card.currency || 'DKK');
                    li.appendChild(d); li.appendChild(a); ul.appendChild(li);
                });
                wrap.appendChild(ul);
            }
        }

        var fields = document.createElement('div');
        fields.className = 'receipt-fields';
        var inputs = {};
        function field(label, key, type, value, options) {
            var row = document.createElement('label');
            row.className = 'receipt-field rf-' + key;
            var l = document.createElement('span');
            l.className = 'receipt-label';
            l.textContent = label;
            row.appendChild(l);
            var el;
            if (type === 'select') {
                el = document.createElement('select');
                (options || []).forEach(function (c) {
                    var o = document.createElement('option');
                    o.value = c; o.textContent = c;
                    if (c === value) o.selected = true;
                    el.appendChild(o);
                });
            } else {
                el = document.createElement('input');
                el.type = type;
                if (value !== null && value !== undefined) el.value = value;
                if (type === 'number') { el.step = '0.01'; el.inputMode = 'decimal'; }
            }
            el.disabled = booked;
            row.appendChild(el);
            fields.appendChild(row);
            inputs[key] = el;
        }

        var curOpts = ['DKK', 'EUR', 'USD', 'GBP', 'SEK', 'NOK', 'CHF'];
        if (card.currency && curOpts.indexOf(card.currency) === -1) curOpts.unshift(card.currency);

        field(daText('Customer', 'Kunde'), 'customer', 'text', card.customer);
        field(daText('Invoice no.', 'Fakturanr.'), 'doc_number', 'text', card.doc_number);
        field(daText('Date', 'Dato'), 'date', 'date', card.date);
        field(daText('Amount (ex moms)', 'Beløb (ekskl. moms)'), 'amount_ex_vat', 'number', card.ex != null ? card.ex : '');
        field(daText('Moms (25%)', 'Moms (25%)'), 'vat', 'number', card.vat != null ? card.vat : '');
        field(daText('Total (incl. moms)', 'Total (inkl. moms)'), 'total', 'number', card.total != null ? card.total : '');
        field(daText('Currency', 'Valuta'), 'currency', 'select', card.currency || 'DKK', curOpts);
        field(daText('Category', 'Kategori'), 'category', 'select', card.category, card.categories);
        field(daText('Note', 'Note'), 'note', 'text', card.note);
        wrap.appendChild(fields);

        function num(v) { return parseFloat(String(v).replace(',', '.')); }
        function round2(n) { return Math.round(n * 100) / 100; }

        // Live moms derivation (DKK 25%): the three amounts stay consistent as the user
        // edits, without forcing them to do the arithmetic. Editing one recomputes the others.
        var vatable = (inputs.currency.value === 'DKK');
        function fromTotal() {
            var t = num(inputs.total.value);
            if (isNaN(t)) return;
            var v = vatable ? round2(t / 5) : 0;
            inputs.vat.value = v;
            inputs.amount_ex_vat.value = round2(t - v);
        }
        function fromEx() {
            var ex = num(inputs.amount_ex_vat.value);
            if (isNaN(ex)) return;
            var v = vatable ? round2(ex * 0.25) : 0;
            inputs.vat.value = v;
            inputs.total.value = round2(ex + v);
        }
        function fromVat() {
            var ex = num(inputs.amount_ex_vat.value);
            var v = num(inputs.vat.value);
            if (isNaN(ex) || isNaN(v)) return;
            inputs.total.value = round2(ex + v);
        }

        // ---- Booked entry: the payment date is directly editable (set / change / clear,
        // freely backdatable), plus the invoice document/mark-paid controls. ----
        if (booked) {
            var payRow = document.createElement('div');
            payRow.className = 'receipt-field income-paid';
            var pLabel = document.createElement('span');
            pLabel.className = 'receipt-label';
            pLabel.textContent = daText('Payment date', 'Betalingsdato');
            var pWrap = document.createElement('span');
            pWrap.className = 'income-paid-controls';
            var pDate = document.createElement('input');
            pDate.type = 'date';
            pDate.value = card.paid_at || '';
            var pBtn = document.createElement('button');
            pBtn.type = 'button'; pBtn.className = 'receipt-confirm income-pay-btn';
            pBtn.textContent = card.paid ? daText('Update', 'Opdatér') : daText('Mark paid', 'Markér betalt');
            pWrap.appendChild(pDate);
            pWrap.appendChild(pBtn);
            if (card.paid) {
                var unpaidBtn = document.createElement('button');
                unpaidBtn.type = 'button'; unpaidBtn.className = 'mileage-link';
                unpaidBtn.textContent = daText('mark unpaid', 'markér ubetalt');
                pWrap.appendChild(unpaidBtn);
                unpaidBtn.addEventListener('click', function () {
                    incomeAction({ action: 'update', id: card.id, paid_at: '' }).then(function (res) {
                        if (res && res.card) { if (onChange) onChange(); else buildIncome(wrap, res.card); }
                    });
                });
            }
            payRow.appendChild(pLabel);
            payRow.appendChild(pWrap);
            wrap.appendChild(payRow);
            pBtn.addEventListener('click', function () {
                pBtn.disabled = true;
                var d = pDate.value || new Date().toISOString().slice(0, 10);
                incomeAction({ action: 'mark_paid', id: card.id, date: d }).then(function (res) {
                    if (res && res.card) { if (onChange) onChange(); else buildIncome(wrap, res.card); }
                    else pBtn.disabled = false;
                }).catch(function () { pBtn.disabled = false; });
            });

            // Delete a booked entry (soft-delete: trailed in the audit log, like expenses).
            var delRow = document.createElement('div');
            delRow.className = 'receipt-actions';
            var delBtn = document.createElement('button');
            delBtn.type = 'button'; delBtn.className = 'receipt-discard';
            delBtn.textContent = daText('Delete', 'Slet');
            delRow.appendChild(delBtn);
            wrap.appendChild(delRow);
            delBtn.addEventListener('click', function () {
                if (!window.confirm(daText('Delete this income entry?', 'Slet denne indtægt?'))) return;
                delBtn.disabled = true;
                incomeAction({ action: 'discard', id: card.id }).then(function (res) {
                    if (res && res.deleted) { if (onChange) onChange(); else wrap.remove(); }
                    else delBtn.disabled = false;
                }).catch(function () { delBtn.disabled = false; });
            });
            return;
        }

        // ---- Draft entry: "Paid" toggle (records/clears the date on confirm). ----
        var paidRow = document.createElement('label');
        paidRow.className = 'receipt-field income-paid';
        var paidLabel = document.createElement('span');
        paidLabel.className = 'receipt-label';
        paidLabel.textContent = daText('Paid', 'Betalt');
        var paidWrap = document.createElement('span');
        paidWrap.className = 'income-paid-controls';
        var paidChk = document.createElement('input');
        paidChk.type = 'checkbox';
        paidChk.checked = !!card.paid;
        var paidDate = document.createElement('input');
        paidDate.type = 'date';
        paidDate.value = card.paid_at || card.date || '';
        paidDate.hidden = !paidChk.checked;
        paidWrap.appendChild(paidChk);
        paidWrap.appendChild(paidDate);
        paidRow.appendChild(paidLabel);
        paidRow.appendChild(paidWrap);
        wrap.appendChild(paidRow);
        paidChk.addEventListener('change', function () { paidDate.hidden = !paidChk.checked; });

        inputs.total.addEventListener('input', fromTotal);
        inputs.amount_ex_vat.addEventListener('input', fromEx);
        inputs.vat.addEventListener('input', fromVat);
        inputs.currency.addEventListener('change', function () { vatable = (inputs.currency.value === 'DKK'); });

        var actions = document.createElement('div');
        actions.className = 'receipt-actions';
        var confirmBtn = document.createElement('button');
        confirmBtn.type = 'button'; confirmBtn.className = 'receipt-confirm';
        confirmBtn.textContent = daText('Confirm', 'Bekræft');
        var discardBtn = document.createElement('button');
        discardBtn.type = 'button'; discardBtn.className = 'receipt-discard';
        discardBtn.textContent = daText('Discard', 'Kassér');
        actions.appendChild(confirmBtn);
        actions.appendChild(discardBtn);
        wrap.appendChild(actions);

        confirmBtn.addEventListener('click', function () {
            confirmBtn.disabled = true; discardBtn.disabled = true;
            var body = { action: 'confirm', id: card.id };
            Object.keys(inputs).forEach(function (k) { body[k] = inputs[k].value; });
            body.paid_at = paidChk.checked ? (paidDate.value || body.date) : '';
            incomeAction(body).then(function (res) {
                if (res && res.card) { if (onChange) onChange(); else buildIncome(wrap, res.card); }
                else { confirmBtn.disabled = false; discardBtn.disabled = false; }
            }).catch(function () { confirmBtn.disabled = false; discardBtn.disabled = false; });
        });
        discardBtn.addEventListener('click', function () {
            if (!window.confirm(daText('Discard this income entry?', 'Kassér denne indtægt?'))) return;
            incomeAction({ action: 'discard', id: card.id }).then(function (res) {
                if (res && res.deleted) { if (onChange) onChange(); else wrap.remove(); }
            }).catch(function () {});
        });
    }

    function incomeAction(body) {
        return fetch('/api/income.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });
    }

    // Income summary for a period — read-only (net / moms / gross per currency,
    // outstanding invoices, per-customer breakdown). Mirrors the expenses summary.
    function renderIncomeSummary(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card expenses-card income-summary-card';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || daText('Income', 'Indtægt');
        wrap.appendChild(head);

        var totals = document.createElement('div');
        totals.className = 'exp-totals';
        var currencies = card.currencies || [];
        if (!currencies.length) {
            var zrow = document.createElement('div'); zrow.className = 'exp-cur';
            var zt = document.createElement('div'); zt.className = 'exp-total'; zt.textContent = fmtMoney(0, 'DKK');
            zrow.appendChild(zt); totals.appendChild(zrow);
        }
        currencies.forEach(function (c) {
            var row = document.createElement('div'); row.className = 'exp-cur';
            var t = document.createElement('div'); t.className = 'exp-total'; t.textContent = fmtMoney(c.total, c.currency);
            var s = document.createElement('div'); s.className = 'exp-sub';
            s.textContent = c.count + (c.count === 1 ? ' invoice' : ' invoices')
                + ' · ' + daText('net ', 'netto ') + fmtMoney(c.ex, c.currency)
                + ' · moms ' + fmtMoney(c.vat, c.currency);
            row.appendChild(t); row.appendChild(s); totals.appendChild(row);
        });
        wrap.appendChild(totals);

        // Outstanding (unpaid) invoices — the debtor total.
        (card.outstanding || []).forEach(function (o) {
            var out = document.createElement('div');
            out.className = 'income-outstanding';
            out.textContent = daText('Outstanding: ', 'Udestående: ') + fmtMoney(o.total, o.currency)
                + ' (' + o.count + ')';
            wrap.appendChild(out);
        });

        // Per-customer chips.
        if ((card.by_customer || []).length) {
            var bd = document.createElement('div');
            bd.className = 'exp-breakdown';
            card.by_customer.forEach(function (c) {
                var chip = document.createElement('span');
                chip.className = 'exp-cat';
                chip.textContent = (c.customer || '—') + ' · ' + fmtMoney(c.total, c.currency);
                bd.appendChild(chip);
            });
            wrap.appendChild(bd);
        }

        var items = card.items || [];
        if (items.length) {
            var list = document.createElement('ul');
            list.className = 'exp-list';
            items.forEach(function (it) {
                var li = document.createElement('li');
                var left = document.createElement('div'); left.className = 'exp-when';
                var main = document.createElement('div'); main.className = 'exp-main';
                rowDateName(main, it.date, it.customer || it.doc_number || '');
                left.appendChild(main);
                var right = document.createElement('span');
                right.className = 'exp-amt';
                right.textContent = fmtMoney(it.total, it.currency);
                if (!it.paid) {
                    var badge = document.createElement('span');
                    badge.className = 'income-unpaid-badge';
                    badge.textContent = daText('unpaid', 'ubetalt');
                    left.appendChild(badge);
                }
                li.appendChild(left); li.appendChild(right);
                list.appendChild(li);
            });
            wrap.appendChild(list);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Owner drawings (private hævninger) for a period — read-only total + list.
    function renderOwnerDraws(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card expenses-card owner-draws-card';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = card.title || daText('Owner draws', 'Hævninger');
        wrap.appendChild(head);

        // Per-currency totals, keyed so a row delete can update them live.
        var totals = document.createElement('div');
        totals.className = 'exp-totals';
        var curState = {};
        function drawSub(count) { return count + (count === 1 ? ' draw' : ' draws'); }
        var t2 = (card.totals || []);
        if (!t2.length) {
            var zr = document.createElement('div'); zr.className = 'exp-cur';
            var zt2 = document.createElement('div'); zt2.className = 'exp-total'; zt2.textContent = fmtMoney(0, 'DKK');
            zr.appendChild(zt2); totals.appendChild(zr);
        }
        t2.forEach(function (c) {
            var row = document.createElement('div'); row.className = 'exp-cur';
            var t = document.createElement('div'); t.className = 'exp-total'; t.textContent = fmtMoney(c.total, c.currency);
            var s = document.createElement('div'); s.className = 'exp-sub'; s.textContent = drawSub(c.count);
            row.appendChild(t); row.appendChild(s); totals.appendChild(row);
            curState[c.currency] = { total: Number(c.total) || 0, count: c.count || 0, totalEl: t, subEl: s, rowEl: row };
        });
        wrap.appendChild(totals);

        var hint = document.createElement('div');
        hint.className = 'income-outstanding';
        hint.textContent = daText('Private drawings — not an expense; excluded from profit & moms.',
                                  'Private hævninger — ikke en udgift; tæller ikke i overskud & moms.');
        wrap.appendChild(hint);

        var items = card.items || [];
        if (items.length) {
            var list = document.createElement('ul');
            list.className = 'exp-list';
            items.forEach(function (it) {
                var li = document.createElement('li');
                var left = document.createElement('div'); left.className = 'exp-when';
                var main = document.createElement('div'); main.className = 'exp-main';
                rowDateName(main, it.date, it.note || '');
                left.appendChild(main);
                var right = document.createElement('span');
                right.className = 'exp-amt';
                right.textContent = fmtMoney(it.amount, it.currency);

                var del = deleteButton(daText('Delete draw', 'Slet hævning'));
                del.addEventListener('click', function () {
                    if (!window.confirm(daText('Delete this drawing?', 'Slet denne hævning?'))) return;
                    del.disabled = true;
                    fetch('/api/draws.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ action: 'discard', id: it.id })
                    }).then(function (r) { return r.json(); }).then(function (res) {
                        if (res && res.deleted) {
                            var st = curState[it.currency];
                            if (st) {
                                st.total -= Number(it.amount) || 0;
                                st.count -= 1;
                                if (st.count <= 0) { st.rowEl.remove(); delete curState[it.currency]; }
                                else {
                                    st.totalEl.textContent = fmtMoney(st.total, it.currency);
                                    st.subEl.textContent = drawSub(st.count);
                                }
                            }
                            li.remove();
                        } else { del.disabled = false; }
                    }).catch(function () { del.disabled = false; });
                });

                li.appendChild(left);
                li.appendChild(right);
                li.appendChild(del);
                list.appendChild(li);
            });
            wrap.appendChild(list);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // ---- Bookkeeping cockpit (kind: bookkeeping) — a modular dashboard ----
    // Composed of KPI tiles + income/expense/draw modules, with overview→detail drill-in
    // and period switching. Interactive on its own via /api/books.php (no chat turn).
    // Re-draws mutate the same container in place, so it works in the card panel or the
    // message stream (the panel-redirect only applies on the first render).

    function renderBooks(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card books';
        drawBooksOverview(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function booksFetch(wrap, gran, offset) {
        fetch('/api/books.php?granularity=' + encodeURIComponent(gran) + '&offset=' + (offset || 0), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawBooksOverview(wrap, j.card); })
            .catch(function () {});
    }

    function booksEntry(wrap, id, backGran, backOffset) {
        fetch('/api/books.php?action=entry&id=' + id, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawBooksIncomeDetail(wrap, j.card, backGran, backOffset); })
            .catch(function () {});
    }

    function booksExpenseEntry(wrap, id, backGran, backOffset) {
        fetch('/api/books.php?action=expense&id=' + id, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawBooksExpenseDetail(wrap, j.card, backGran, backOffset); })
            .catch(function () {});
    }

    function booksTile(label, value, sub, tone) {
        var t = document.createElement('div');
        t.className = 'books-kpi' + (tone ? ' books-kpi-' + tone : '');
        var l = document.createElement('div'); l.className = 'books-kpi-label'; l.textContent = label;
        var v = document.createElement('div'); v.className = 'books-kpi-val'; v.textContent = value;
        t.appendChild(l); t.appendChild(v);
        if (sub) { var s = document.createElement('div'); s.className = 'books-kpi-sub'; s.textContent = sub; t.appendChild(s); }
        return t;
    }

    function drawBooksOverview(wrap, card) {
        wrap.innerHTML = '';
        var cur = card.currency || 'DKK';
        var k = card.kpis || {};

        // Header: title, granularity chips, and prev/next period navigation.
        var head = document.createElement('div');
        head.className = 'books-head';
        var title = document.createElement('div');
        title.className = 'books-title';
        title.textContent = daText('Books', 'Regnskab');
        head.appendChild(title);

        var controls = document.createElement('div');
        controls.className = 'books-controls';

        var grans = document.createElement('div');
        grans.className = 'books-periods';
        (card.granularities || []).forEach(function (g) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'books-period' + (g.key === card.granularity ? ' is-active' : '');
            b.textContent = g.label;
            b.addEventListener('click', function () { booksFetch(wrap, g.key, 0); });
            grans.appendChild(b);
        });
        controls.appendChild(grans);

        // Prev ‹ [period] › next — paging back through periods (hidden for "All").
        var nav = document.createElement('div');
        nav.className = 'books-nav';
        if (card.granularity !== 'all') {
            var prev = document.createElement('button');
            prev.type = 'button'; prev.className = 'books-navbtn'; prev.textContent = '‹';
            prev.setAttribute('aria-label', daText('Previous period', 'Forrige periode'));
            prev.addEventListener('click', function () { booksFetch(wrap, card.granularity, (card.offset || 0) - 1); });
            var lbl = document.createElement('span');
            lbl.className = 'books-navlabel'; lbl.textContent = card.period_label || '';
            var next = document.createElement('button');
            next.type = 'button'; next.className = 'books-navbtn'; next.textContent = '›';
            next.setAttribute('aria-label', daText('Next period', 'Næste periode'));
            next.disabled = !card.can_next;
            next.addEventListener('click', function () { if (card.can_next) booksFetch(wrap, card.granularity, (card.offset || 0) + 1); });
            nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
        } else {
            var allLbl = document.createElement('span');
            allLbl.className = 'books-navlabel'; allLbl.textContent = card.period_label || '';
            nav.appendChild(allLbl);
        }
        controls.appendChild(nav);
        head.appendChild(controls);
        wrap.appendChild(head);

        // KPI tiles.
        var kpis = document.createElement('div');
        kpis.className = 'books-kpis';
        var reserve = k.reserve || {};
        var momsTone = (k.net_moms || 0) > 0 ? 'warn' : 'ok';
        var momsSub  = (k.net_moms || 0) >= 0
            ? daText('to pay · salgs − købs', 'at betale · salgs − købs')
            : daText('to reclaim', 'til gode');
        kpis.appendChild(booksTile(daText('Revenue', 'Omsætning'), fmtMoney(k.revenue, cur), daText('ex. moms', 'ekskl. moms')));
        kpis.appendChild(booksTile(daText('Net moms', 'Moms (netto)'), fmtMoney(k.net_moms, cur), momsSub, momsTone));
        kpis.appendChild(booksTile(daText('Expenses', 'Udgifter'), fmtMoney(k.expenses, cur), daText('incl. moms', 'inkl. moms')));
        kpis.appendChild(booksTile(daText('Outstanding', 'Udestående'), fmtMoney(k.outstanding, cur), daText('unpaid invoices', 'ubetalte fakturaer')));
        kpis.appendChild(booksTile(daText('Reserve', 'Hensæt'), fmtMoney(reserve.total, cur),
            daText('moms ', 'moms ') + fmtMoney(reserve.moms, cur) + ' + ' + daText('tax ', 'skat ') + fmtMoney(reserve.tax, cur) + ' (' + (reserve.pct || 0) + '%)', 'accent'));
        wrap.appendChild(kpis);

        // A profit strap line under the tiles.
        var strap = document.createElement('div');
        strap.className = 'books-strap';
        strap.textContent = daText('Profit (revenue − expenses): ', 'Overskud (omsætning − udgifter): ') + fmtMoney(k.profit, cur);
        wrap.appendChild(strap);

        // Modules grid.
        var grid = document.createElement('div');
        grid.className = 'books-modules';
        grid.appendChild(booksIncomeModule(wrap, card, cur));
        grid.appendChild(booksExpenseModule(wrap, card, cur));
        grid.appendChild(booksDrawModule(wrap, card, cur));
        wrap.appendChild(grid);
    }

    function booksModule(titleText, onAdd) {
        var m = document.createElement('div');
        m.className = 'books-module';
        var h = document.createElement('div');
        h.className = 'books-module-head';
        var t = document.createElement('span');
        t.className = 'books-module-title';
        t.textContent = titleText;
        h.appendChild(t);
        if (onAdd) {
            var add = document.createElement('button');
            add.type = 'button';
            add.className = 'books-add';
            add.textContent = '+ ' + daText('Add', 'Tilføj');
            add.title = daText('Add an entry', 'Tilføj en post');
            add.addEventListener('click', onAdd);
            h.appendChild(add);
        }
        m.appendChild(h);
        return m;
    }

    // A small popover under the "+ Add" button offering manual entry vs a photo/PDF read.
    function booksAddChoice(btn, onManual, onPhoto) {
        var head = btn.parentNode;
        var open = head.querySelector('.books-addmenu');
        if (open) { open.remove(); return; }   // toggle off
        var menu = document.createElement('div');
        menu.className = 'books-addmenu';
        function item(label, fn, iconName) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'books-addmenu-item';
            setIconText(b, iconName, label);
            b.addEventListener('click', function () { menu.remove(); fn(); });
            return b;
        }
        menu.appendChild(item(daText('Enter manually', 'Indtast manuelt'), onManual, 'pencil-line'));
        menu.appendChild(item(daText('Photo / PDF', 'Foto / PDF'), onPhoto, 'camera'));
        head.appendChild(menu);
        // Dismiss on the next outside click.
        setTimeout(function () {
            document.addEventListener('click', function off(ev) {
                if (!menu.contains(ev.target) && ev.target !== btn) { menu.remove(); document.removeEventListener('click', off); }
            });
        }, 0);
    }

    // Ephemeral hidden <input type=file> → callback with the chosen file (no DOM left behind).
    function pickFile(accept, cb) {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = accept; inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            document.body.removeChild(inp);
            if (f) cb(f);
        });
        inp.click();
    }

    // A "reading…" placeholder shown in the card while Gemini parses an uploaded bilag.
    function booksReadingState(wrap, label) {
        wrap.innerHTML = '';
        var body = document.createElement('div');
        body.className = 'books-detail-body books-reading';
        setIconText(body, 'hourglass', label);
        wrap.appendChild(body);
    }

    // Photo/PDF invoice → income-upload.php reads it → open the draft in the cockpit editor.
    function booksUploadIncome(wrap, card, file) {
        booksReadingState(wrap, daText('Reading the invoice…', 'Læser fakturaen…'));
        var fd = new FormData(); fd.append('invoice', file);
        fetch('/api/income-upload.php', { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.card) drawBooksIncomeDetail(wrap, j.card, card.granularity, card.offset);
                else booksFetch(wrap, card.granularity, card.offset);
            })
            .catch(function () { booksFetch(wrap, card.granularity, card.offset); });
    }

    // Photo/PDF receipt → receipt-upload.php reads it → open the draft in the cockpit editor.
    function booksUploadExpense(wrap, card, file) {
        booksReadingState(wrap, daText('Reading the receipt…', 'Læser kvitteringen…'));
        var fd = new FormData(); fd.append('photo', file);
        fetch('/api/receipt-upload.php', { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.card) drawBooksExpenseDetail(wrap, j.card, card.granularity, card.offset);
                else booksFetch(wrap, card.granularity, card.offset);
            })
            .catch(function () { booksFetch(wrap, card.granularity, card.offset); });
    }

    // Attach a file to an EXISTING income entry (income_id → the endpoint links it instead
    // of creating a new draft, and does not re-read the amounts).
    function incomeAttachFile(id, file) {
        var fd = new FormData();
        fd.append('invoice', file);
        fd.append('income_id', String(id));
        return fetch('/api/income-upload.php', { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function (r) { return r.json(); })
            .catch(function () { return null; });
    }

    // "+ Add" from the Income module: make a blank draft and open the income editor
    // (customer / amount / VAT / date) — Confirm books it and the cockpit auto-refreshes.
    function booksAddIncome(wrap, card) {
        fetch('/api/income.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create' })
        })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawBooksIncomeDetail(wrap, j.card, card.granularity, card.offset); })
            .catch(function () {});
    }

    // "+ Add" from the Expenses module: blank draft receipt → the expense editor.
    function booksAddExpense(wrap, card) {
        fetch('/api/receipt.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create' })
        })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawBooksExpenseDetail(wrap, j.card, card.granularity, card.offset); })
            .catch(function () {});
    }

    function booksIncomeModule(wrap, card, cur) {
        var inc = card.income || {};
        var counts = inc.counts || {};
        var m = booksModule(daText('Income', 'Indtægt'), function (e) {
            booksAddChoice(e.currentTarget,
                function () { booksAddIncome(wrap, card); },
                function () { pickFile('image/*,application/pdf', function (f) { booksUploadIncome(wrap, card, f); }); });
        });

        var chips = document.createElement('div');
        chips.className = 'books-chips';
        [['draft', daText('Drafts', 'Kladder')], ['booked', daText('Booked', 'Bogført')],
         ['unpaid', daText('Unpaid', 'Ubetalt')], ['paid', daText('Paid', 'Betalt')]].forEach(function (c) {
            var chip = document.createElement('span');
            chip.className = 'books-chip books-chip-' + c[0];
            chip.textContent = c[1] + ' ' + (counts[c[0]] || 0);
            chips.appendChild(chip);
        });
        m.appendChild(chips);

        var list = document.createElement('ul');
        list.className = 'books-list';
        (inc.items || []).forEach(function (it) {
            var li = document.createElement('li');
            li.className = 'books-row books-row-click';
            li.title = daText('Open', 'Åbn');
            var left = document.createElement('div'); left.className = 'books-row-main';
            rowDateName(left, it.date, it.customer || it.doc_number || '—');
            var badge = document.createElement('span');
            var state = it.status === 'draft' ? 'draft' : (it.paid ? 'paid' : 'unpaid');
            badge.className = 'books-badge books-badge-' + state;
            badge.textContent = state === 'draft' ? daText('draft', 'kladde')
                : (state === 'paid' ? daText('paid', 'betalt') : daText('unpaid', 'ubetalt'));
            var amt = document.createElement('span'); amt.className = 'books-amt'; amt.textContent = fmtMoney(it.total, it.currency || cur);
            left.appendChild(badge);
            li.appendChild(left); li.appendChild(amt);
            li.addEventListener('click', function () { booksEntry(wrap, it.id, card.granularity, card.offset); });
            list.appendChild(li);
        });
        if (!(inc.items || []).length) list.appendChild(booksEmptyRow(daText('No income yet.', 'Ingen indtægt endnu.')));
        m.appendChild(list);
        return m;
    }

    function booksExpenseModule(wrap, card, cur) {
        var exp = card.expenses || {};
        var m = booksModule(daText('Expenses', 'Udgifter'), function (e) {
            booksAddChoice(e.currentTarget,
                function () { booksAddExpense(wrap, card); },
                function () { pickFile('image/*,application/pdf', function (f) { booksUploadExpense(wrap, card, f); }); });
        });
        var tot = document.createElement('div');
        tot.className = 'books-module-total';
        tot.textContent = fmtMoney(exp.total, cur) + '  ·  ' + daText('moms ', 'moms ') + fmtMoney(exp.vat, cur);
        m.appendChild(tot);
        var owed = (exp.udlaeg_owed || {});
        if ((owed.total || 0) > 0) {
            var u = document.createElement('div');
            u.className = 'books-note';
            u.textContent = daText('Udlæg owed to you: ', 'Udlæg du har til gode: ') + fmtMoney(owed.total, cur) + ' (' + (owed.count || 0) + ')';
            m.appendChild(u);
        }
        var list = document.createElement('ul');
        list.className = 'books-list';
        (exp.items || []).forEach(function (it) {
            var li = document.createElement('li'); li.className = 'books-row books-row-click';
            li.title = daText('Open', 'Åbn');
            var left = document.createElement('div'); left.className = 'books-row-main';
            rowDateName(left, it.date, it.vendor || '—');
            var amt = document.createElement('span'); amt.className = 'books-amt'; amt.textContent = fmtMoney(it.total, it.currency || cur);
            li.appendChild(left); li.appendChild(amt);
            li.addEventListener('click', function () { booksExpenseEntry(wrap, it.id, card.granularity, card.offset); });
            list.appendChild(li);
        });
        if (!(exp.items || []).length) list.appendChild(booksEmptyRow(daText('No expenses yet.', 'Ingen udgifter endnu.')));
        m.appendChild(list);
        return m;
    }

    function booksDrawModule(wrap, card, cur) {
        var dr = card.draws || {};
        // Draws have no draft/confirm editor, so "+ Add" reveals a small inline form.
        var m = booksModule(daText('Owner draws', 'Hævninger'), function () { toggleForm(); });
        var tot = document.createElement('div');
        tot.className = 'books-module-total';
        tot.textContent = fmtMoney(dr.total, cur) + '  ·  ' + (dr.count || 0) + ' ' + daText('draws', 'hævninger');
        m.appendChild(tot);

        // Inline add form (hidden until "+ Add"): amount + optional note → records at once.
        var form = document.createElement('div');
        form.className = 'books-addform';
        form.style.display = 'none';
        var amt = document.createElement('input');
        amt.type = 'number'; amt.step = '0.01'; amt.min = '0';
        amt.className = 'books-addinput';
        amt.placeholder = daText('Amount (kr)', 'Beløb (kr)');
        var note = document.createElement('input');
        note.type = 'text'; note.className = 'books-addinput';
        note.placeholder = daText('Note (optional)', 'Note (valgfri)');
        var save = document.createElement('button');
        save.type = 'button'; save.className = 'books-addsave';
        save.textContent = daText('Add', 'Tilføj');
        function submit() {
            var v = parseFloat(amt.value);
            if (!(v > 0)) { amt.focus(); return; }
            save.disabled = true;
            fetch('/api/draws.php', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create', amount: v, note: note.value || '' })
            })
                .then(function (r) { return r.json(); })
                .then(function () { booksFetch(wrap, card.granularity, card.offset); })
                .catch(function () { save.disabled = false; });
        }
        save.addEventListener('click', submit);
        amt.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        note.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        form.appendChild(amt); form.appendChild(note); form.appendChild(save);
        m.appendChild(form);
        function toggleForm() {
            var show = form.style.display === 'none';
            form.style.display = show ? 'flex' : 'none';
            if (show) amt.focus();
        }

        var list = document.createElement('ul');
        list.className = 'books-list';
        (dr.items || []).forEach(function (it) {
            var li = document.createElement('li'); li.className = 'books-row books-row-draw';
            var left = document.createElement('div'); left.className = 'books-row-main';
            rowDateName(left, it.date, it.note || '');
            var amt = document.createElement('span'); amt.className = 'books-amt'; amt.textContent = fmtMoney(it.amount, it.currency || cur);
            var del = deleteButton(daText('Delete draw', 'Slet hævning'));
            del.className += ' books-row-del';
            del.addEventListener('click', function () {
                if (!window.confirm(daText('Delete this drawing?', 'Slet denne hævning?'))) return;
                del.disabled = true;
                fetch('/api/draws.php', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'discard', id: it.id })
                })
                    .then(function (r) { return r.json(); })
                    .then(function () { booksFetch(wrap, card.granularity, card.offset); })
                    .catch(function () { del.disabled = false; });
            });
            li.appendChild(left); li.appendChild(amt); li.appendChild(del);
            list.appendChild(li);
        });
        if (!(dr.items || []).length) list.appendChild(booksEmptyRow(daText('No draws yet.', 'Ingen hævninger endnu.')));
        m.appendChild(list);
        return m;
    }

    function booksEmptyRow(text) {
        var li = document.createElement('li');
        li.className = 'books-row books-empty';
        li.textContent = text;
        return li;
    }

    // Drill-in: one income entry as its full editable card, with a back link to the overview.
    function drawBooksIncomeDetail(wrap, entryCard, backGran, backOffset) {
        wrap.innerHTML = '';
        var bar = document.createElement('div');
        bar.className = 'books-detail-bar';
        var back = document.createElement('button');
        back.type = 'button'; back.className = 'books-back';
        back.textContent = daText('← Back to books', '← Tilbage til regnskab');
        back.addEventListener('click', function () { booksFetch(wrap, backGran, backOffset); });
        bar.appendChild(back);
        wrap.appendChild(bar);
        var body = document.createElement('div');
        body.className = 'books-detail-body';
        wrap.appendChild(body);
        // onChange: any edit/confirm/paid/delete auto-refreshes the cockpit (and returns
        // to the updated overview) so the KPIs and lists reflect the change immediately.
        buildIncome(body, entryCard, function () { booksFetch(wrap, backGran, backOffset); });
    }

    // Drill-in: one expense as its full editable receipt card, with a back link.
    function drawBooksExpenseDetail(wrap, receiptCard, backGran, backOffset) {
        wrap.innerHTML = '';
        var bar = document.createElement('div');
        bar.className = 'books-detail-bar';
        var back = document.createElement('button');
        back.type = 'button'; back.className = 'books-back';
        back.textContent = daText('← Back to books', '← Tilbage til regnskab');
        back.addEventListener('click', function () { booksFetch(wrap, backGran, backOffset); });
        bar.appendChild(back);
        wrap.appendChild(bar);
        var body = document.createElement('div');
        body.className = 'books-detail-body';
        wrap.appendChild(body);
        // onChange: confirm/delete auto-refreshes the cockpit back to the updated overview.
        buildReceipt(body, receiptCard, function () { booksFetch(wrap, backGran, backOffset); });
    }

    // ---- Moms (quarterly VAT settlement) card ----------------------------------
    // salgsmoms − købsmoms = tilsvar for a quarter, with the filing deadline. Pages
    // between quarters in place via /api/moms.php (like the books cockpit).
    function renderMoms(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card moms-card';
        drawMoms(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function momsFetch(wrap, offset) {
        fetch('/api/moms.php?offset=' + (offset || 0), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawMoms(wrap, j.card); })
            .catch(function () {});
    }

    function drawMoms(wrap, card) {
        wrap.innerHTML = '';
        var cur = card.currency || 'DKK';
        var pay = !!card.pay;
        var tilsvar = Number(card.tilsvar) || 0;
        var days = Number(card.days_left);

        // Header: title + prev/next quarter navigation.
        var head = document.createElement('div');
        head.className = 'books-head';
        var title = document.createElement('div');
        title.className = 'books-title';
        title.textContent = daText('Moms', 'Moms');
        head.appendChild(title);

        var nav = document.createElement('div');
        nav.className = 'books-nav';
        var prev = document.createElement('button');
        prev.type = 'button'; prev.className = 'books-navbtn'; prev.textContent = '‹';
        prev.setAttribute('aria-label', daText('Previous quarter', 'Forrige kvartal'));
        prev.addEventListener('click', function () { momsFetch(wrap, (card.offset || 0) - 1); });
        var lbl = document.createElement('span');
        lbl.className = 'books-navlabel'; lbl.textContent = card.period_label || '';
        var next = document.createElement('button');
        next.type = 'button'; next.className = 'books-navbtn'; next.textContent = '›';
        next.setAttribute('aria-label', daText('Next quarter', 'Næste kvartal'));
        next.disabled = !card.can_next;
        next.addEventListener('click', function () { if (card.can_next) momsFetch(wrap, (card.offset || 0) + 1); });
        nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
        head.appendChild(nav);
        wrap.appendChild(head);

        // Hero: the tilsvar (what you pay, or get back).
        var hero = document.createElement('div');
        hero.className = 'moms-hero ' + (pay ? 'is-pay' : 'is-refund');
        var heroLabel = document.createElement('div');
        heroLabel.className = 'moms-hero-label';
        heroLabel.textContent = pay
            ? daText('Moms to pay', 'Moms at betale')
            : daText('Moms to reclaim', 'Moms til gode');
        var heroVal = document.createElement('div');
        heroVal.className = 'moms-hero-val';
        heroVal.textContent = fmtMoney(Math.abs(tilsvar), cur);
        hero.appendChild(heroLabel); hero.appendChild(heroVal);
        wrap.appendChild(hero);

        // The salgs − købs = tilsvar breakdown.
        var calc = document.createElement('div');
        calc.className = 'moms-calc';
        function row(label, value, op, strong) {
            var r = document.createElement('div');
            r.className = 'moms-row' + (strong ? ' is-total' : '');
            var o = document.createElement('span'); o.className = 'moms-op'; o.textContent = op || '';
            var l = document.createElement('span'); l.className = 'moms-row-label'; l.textContent = label;
            var v = document.createElement('span'); v.className = 'moms-row-val'; v.textContent = fmtMoney(value, cur);
            r.appendChild(o); r.appendChild(l); r.appendChild(v);
            return r;
        }
        calc.appendChild(row(daText('Salgsmoms (on sales)', 'Salgsmoms (af salg)'), card.salgsmoms, ''));
        calc.appendChild(row(daText('Købsmoms (on expenses)', 'Købsmoms (af udgifter)'), card.kobsmoms, '−'));
        calc.appendChild(row(daText('Tilsvar', 'Tilsvar'), Math.abs(tilsvar), '=', true));
        wrap.appendChild(calc);

        // Deadline line, colour-coded by urgency.
        var dl = document.createElement('div');
        var dlTone = days < 0 ? 'is-overdue' : (days <= 14 ? 'is-soon' : '');
        dl.className = 'moms-deadline ' + dlTone;
        var when;
        if (days < 0) {
            when = daText('overdue by ', 'overskredet med ') + Math.abs(days) + daText(' days', ' dage');
        } else if (days === 0) {
            when = daText('due today', 'frist i dag');
        } else {
            when = daText('in ', 'om ') + days + daText(' days', ' dage');
        }
        setIconText(dl, 'calendar', daText('File & pay by ', 'Angiv & betal senest ') + card.deadline + ' (' + when + ')');
        wrap.appendChild(dl);

        // Record the moms payment (or refund) as a bank movement, so the cash balance
        // stays right. Answers "I paid this moms back" in one tap.
        if (Math.abs(tilsvar) > 0) {
            var rec = document.createElement('button');
            rec.type = 'button'; rec.className = 'moms-record';
            rec.textContent = pay
                ? daText('✓ Record moms payment', '✓ Registrér momsbetaling')
                : daText('✓ Record moms refund', '✓ Registrér momsrefusion');
            rec.addEventListener('click', function () {
                var msg = (pay ? daText('Record a moms payment of ', 'Registrér en momsbetaling på ')
                              : daText('Record a moms refund of ', 'Registrér en momsrefusion på '))
                    + fmtMoney(Math.abs(tilsvar), cur) + ' → ' + daText('Cash?', 'Likviditet?');
                if (!window.confirm(msg)) return;
                rec.disabled = true;
                fetch('/api/cash.php', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add', direction: pay ? 'out' : 'in', amount: Math.abs(tilsvar), category: 'moms', note: (card.period_label || '') + ' moms' })
                })
                    .then(function (r) { return r.json(); })
                    .then(function () { openCashFresh(); })
                    .catch(function () { rec.disabled = false; });
            });
            wrap.appendChild(rec);
        }

        // Caveats: period still open, or unbooked drafts not yet included.
        var notes = [];
        if (card.period_open) {
            notes.push(daText(
                'This quarter is still open — figures will keep changing until it ends.',
                'Kvartalet er stadig åbent — tallene ændrer sig indtil det slutter.'));
        }
        var drafts = (Number(card.draft_income) || 0) + (Number(card.draft_expense) || 0);
        if (drafts > 0) {
            notes.push(daText(
                drafts + ' unbooked draft' + (drafts === 1 ? '' : 's') + ' not yet counted — book them for the real figure.',
                drafts + ' ikke-bogført' + (drafts === 1 ? ' kladde' : 'e kladder') + ' tælles ikke med endnu — bogfør dem for det rigtige tal.'));
        }
        if (!card.sales_count && !card.expense_count) {
            notes.push(daText(
                'No booked activity this quarter — a zero return may still be required.',
                'Ingen bogført aktivitet i kvartalet — en nul-angivelse kan stadig være påkrævet.'));
        }
        notes.forEach(function (n) {
            var el = document.createElement('div');
            el.className = 'moms-note';
            setIconText(el, 'triangle-alert', n);
            wrap.appendChild(el);
        });

        // Footer: this is an estimate to help you file, not a filed figure.
        var foot = document.createElement('div');
        foot.className = 'moms-foot';
        foot.textContent = daText(
            'An estimate to help you file in TastSelv Erhverv — Kachow is your bookkeeping assistant, not the system of record.',
            'Et estimat der hjælper dig med at angive i TastSelv Erhverv — Kachow er din bogføringsassistent, ikke det officielle system.');
        wrap.appendChild(foot);
    }

    // ---- Cash position (kind: cash) — expected bank balance + free-to-spend ----
    // "How much should be in my account." Interactive: log/delete manual movements
    // (moms payments, fees, deposits) in place via /api/cash.php.
    var CASH_CAT_LABELS = {
        moms:    { en: 'Moms payment', da: 'Momsbetaling' },
        tax:     { en: 'Tax payment',  da: 'Skattebetaling' },
        fee:     { en: 'Bank fee',     da: 'Bankgebyr' },
        deposit: { en: 'Money in',     da: 'Indskud' },
        other:   { en: 'Other',        da: 'Andet' }
    };
    function cashCatLabel(c) { var m = CASH_CAT_LABELS[c] || CASH_CAT_LABELS.other; return daText(m.en, m.da); }

    function renderCash(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card cash-card';
        drawCash(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function cashPost(wrap, body) {
        fetch('/api/cash.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawCash(wrap, j.card); })
            .catch(function () {});
    }

    function drawCash(wrap, card) {
        wrap.innerHTML = '';
        var cur = card.currency || 'DKK';
        var reserve = card.reserve || {};
        var mIn = card.money_in || {}, mOut = card.money_out || {};

        var head = document.createElement('div');
        head.className = 'books-head';
        var title = document.createElement('div');
        title.className = 'books-title';
        title.textContent = daText('Cash position', 'Likviditet');
        head.appendChild(title);
        wrap.appendChild(head);

        // Two heroes: expected bank balance, and free-to-spend after the reserve.
        var heroes = document.createElement('div');
        heroes.className = 'cash-heroes';
        function hero(label, value, cls, sub) {
            var h = document.createElement('div'); h.className = 'cash-hero ' + cls;
            var l = document.createElement('div'); l.className = 'cash-hero-label'; l.textContent = label;
            var v = document.createElement('div'); v.className = 'cash-hero-val'; v.textContent = fmtMoney(value, cur);
            h.appendChild(l); h.appendChild(v);
            if (sub) { var s = document.createElement('div'); s.className = 'cash-hero-sub'; s.textContent = sub; h.appendChild(s); }
            return h;
        }
        heroes.appendChild(hero(daText('Expected balance', 'Forventet saldo'), card.expected, 'is-expected',
            daText('what the bank should show', 'hvad banken bør vise')));
        var free = Number(card.free_to_spend) || 0;
        heroes.appendChild(hero(daText('Free to spend', 'Frit at bruge'), free, free < 0 ? 'is-negative' : 'is-free',
            daText('after moms + tax set aside', 'efter moms + skat er hensat')));
        wrap.appendChild(heroes);

        // Reserve note (why free < expected).
        var res = document.createElement('div');
        res.className = 'cash-reserve';
        setIconText(res, 'lock', daText('Set aside: ', 'Hensat: ') + fmtMoney(reserve.total, cur)
            + ' (' + daText('moms ', 'moms ') + fmtMoney(reserve.moms, cur)
            + ' + ' + daText('tax ', 'skat ') + fmtMoney(reserve.tax, cur) + ', ' + (reserve.pct || 0) + '%)');
        wrap.appendChild(res);

        // Expected moms refund SKAT owes you (not yet in the balance) — shown so it's not
        // forgotten, with the "free once it lands" figure.
        var refund = Number(card.refund_expected) || 0;
        if (refund > 0) {
            var rf = document.createElement('div');
            rf.className = 'cash-refund';
            setIconText(rf, 'repeat', daText('SKAT owes you ', 'SKAT skylder dig ') + fmtMoney(refund, cur)
                + daText(' (moms refund, not yet received) → ', ' (momsrefusion, ikke modtaget endnu) → ')
                + fmtMoney(card.free_incl_refund, cur) + daText(' free once paid', ' frit når det er betalt'));
            wrap.appendChild(rf);
        }

        // In / out breakdown.
        var flow = document.createElement('div');
        flow.className = 'cash-flow';
        function flowCol(titleTxt, cls, rows, total) {
            var col = document.createElement('div'); col.className = 'cash-col ' + cls;
            var h = document.createElement('div'); h.className = 'cash-col-head';
            h.textContent = titleTxt + '  ' + fmtMoney(total, cur);
            col.appendChild(h);
            rows.forEach(function (r) {
                if (!r[1]) return;
                var line = document.createElement('div'); line.className = 'cash-col-row';
                var l = document.createElement('span'); l.textContent = r[0];
                var v = document.createElement('span'); v.className = 'books-amt'; v.textContent = fmtMoney(r[1], cur);
                line.appendChild(l); line.appendChild(v); col.appendChild(line);
            });
            return col;
        }
        flow.appendChild(flowCol(daText('Money in', 'Ind'), 'cash-in', [
            [daText('Invoices paid', 'Fakturaer betalt'), mIn.invoices_paid],
            [daText('Other in', 'Andet ind'), mIn.other]
        ], mIn.total));
        flow.appendChild(flowCol(daText('Money out', 'Ud'), 'cash-out', [
            [daText('Expenses', 'Udgifter'), mOut.expenses],
            [daText('Owner draws', 'Hævninger'), mOut.draws],
            [daText('Moms / other', 'Moms / andet'), mOut.other]
        ], mOut.total));
        if (card.opening) {
            var op = document.createElement('div'); op.className = 'cash-opening';
            op.textContent = daText('Opening balance: ', 'Startsaldo: ') + fmtMoney(card.opening, cur);
            wrap.appendChild(op);
        }
        wrap.appendChild(flow);

        // Manual movements list (with delete) — moms payments, fees, deposits.
        var moves = card.movements || [];
        if (moves.length) {
            var mh = document.createElement('div'); mh.className = 'cash-moves-head';
            mh.textContent = daText('Logged movements', 'Registrerede bevægelser');
            wrap.appendChild(mh);
            var list = document.createElement('ul'); list.className = 'books-list';
            moves.forEach(function (it) {
                var li = document.createElement('li'); li.className = 'books-row';
                var left = document.createElement('div'); left.className = 'books-row-main';
                var sign = it.direction === 'in' ? '+' : '−';
                rowDateName(left, it.date, cashCatLabel(it.category) + (it.note ? ' · ' + it.note : ''));
                var amt = document.createElement('span');
                amt.className = 'books-amt cash-' + (it.direction === 'in' ? 'pos' : 'neg');
                amt.textContent = sign + ' ' + fmtMoney(it.amount, cur);
                var del = deleteButton(daText('Delete movement', 'Slet bevægelse'));
                del.className += ' books-row-del';
                del.addEventListener('click', function () {
                    if (!window.confirm(daText('Delete this movement?', 'Slet denne bevægelse?'))) return;
                    del.disabled = true;
                    cashPost(wrap, { action: 'delete', id: it.id });
                });
                li.appendChild(left); li.appendChild(amt); li.appendChild(del);
                list.appendChild(li);
            });
            wrap.appendChild(list);
        }

        // Inline "log a movement" form.
        var form = document.createElement('div');
        form.className = 'books-addform cash-addform';
        form.style.display = 'none';
        var dir = document.createElement('select'); dir.className = 'books-addinput';
        [['out', daText('Out', 'Ud')], ['in', daText('In', 'Ind')]].forEach(function (o) {
            var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; dir.appendChild(op);
        });
        var catSel = document.createElement('select'); catSel.className = 'books-addinput';
        (card.categories || ['moms', 'tax', 'fee', 'deposit', 'other']).forEach(function (c) {
            var op = document.createElement('option'); op.value = c; op.textContent = cashCatLabel(c); catSel.appendChild(op);
        });
        var amt2 = document.createElement('input'); amt2.type = 'number'; amt2.step = '0.01'; amt2.min = '0';
        amt2.className = 'books-addinput'; amt2.placeholder = daText('Amount (kr)', 'Beløb (kr)');
        var note2 = document.createElement('input'); note2.type = 'text'; note2.className = 'books-addinput';
        note2.placeholder = daText('Note (optional)', 'Note (valgfri)');
        var save = document.createElement('button'); save.type = 'button'; save.className = 'books-addsave';
        save.textContent = daText('Add', 'Tilføj');
        function submit() {
            var v = parseFloat(amt2.value);
            if (!(v > 0)) { amt2.focus(); return; }
            save.disabled = true;
            cashPost(wrap, { action: 'add', direction: dir.value, amount: v, category: catSel.value, note: note2.value || '' });
        }
        save.addEventListener('click', submit);
        amt2.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        note2.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        form.appendChild(dir); form.appendChild(catSel); form.appendChild(amt2); form.appendChild(note2); form.appendChild(save);

        var addBtn = document.createElement('button');
        addBtn.type = 'button'; addBtn.className = 'books-add cash-add';
        addBtn.textContent = '+ ' + daText('Log a movement', 'Registrér bevægelse');
        addBtn.addEventListener('click', function () {
            var show = form.style.display === 'none';
            form.style.display = show ? 'flex' : 'none';
            if (show) amt2.focus();
        });
        wrap.appendChild(addBtn);
        wrap.appendChild(form);

        var foot = document.createElement('div');
        foot.className = 'moms-foot';
        foot.textContent = daText(
            'Expected balance from paid invoices, expenses, draws and the movements you log — a cash estimate, not your live bank feed.',
            'Forventet saldo ud fra betalte fakturaer, udgifter, hævninger og de bevægelser du registrerer — et likviditetsestimat, ikke din live bankkonto.');
        wrap.appendChild(foot);
    }

    // ---- Profit & loss (kind: pl) — resultatopgørelse, ex-VAT ----
    function renderPl(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card pl-card';
        drawPl(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function plFetch(wrap, gran, offset) {
        fetch('/api/pl.php?granularity=' + encodeURIComponent(gran) + '&offset=' + (offset || 0), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawPl(wrap, j.card); })
            .catch(function () {});
    }

    function drawPl(wrap, card) {
        wrap.innerHTML = '';
        var cur = card.currency || 'DKK';

        // Header: title + granularity chips + prev/next period nav (mirrors the cockpit).
        var head = document.createElement('div');
        head.className = 'books-head';
        var title = document.createElement('div');
        title.className = 'books-title';
        title.textContent = daText('Profit & loss', 'Resultatopgørelse');
        head.appendChild(title);

        var controls = document.createElement('div');
        controls.className = 'books-controls';
        var grans = document.createElement('div');
        grans.className = 'books-periods';
        (card.granularities || []).forEach(function (g) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'books-period' + (g.key === card.granularity ? ' is-active' : '');
            b.textContent = g.label;
            b.addEventListener('click', function () { plFetch(wrap, g.key, 0); });
            grans.appendChild(b);
        });
        controls.appendChild(grans);
        var nav = document.createElement('div');
        nav.className = 'books-nav';
        if (card.granularity !== 'all') {
            var prev = document.createElement('button');
            prev.type = 'button'; prev.className = 'books-navbtn'; prev.textContent = '‹';
            prev.setAttribute('aria-label', daText('Previous period', 'Forrige periode'));
            prev.addEventListener('click', function () { plFetch(wrap, card.granularity, (card.offset || 0) - 1); });
            var lbl = document.createElement('span'); lbl.className = 'books-navlabel'; lbl.textContent = card.period_label || '';
            var next = document.createElement('button');
            next.type = 'button'; next.className = 'books-navbtn'; next.textContent = '›';
            next.setAttribute('aria-label', daText('Next period', 'Næste periode'));
            next.disabled = !card.can_next;
            next.addEventListener('click', function () { if (card.can_next) plFetch(wrap, card.granularity, (card.offset || 0) + 1); });
            nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
        } else {
            var allLbl = document.createElement('span'); allLbl.className = 'books-navlabel'; allLbl.textContent = card.period_label || '';
            nav.appendChild(allLbl);
        }
        controls.appendChild(nav);
        head.appendChild(controls);
        wrap.appendChild(head);

        // Statement rows.
        var stmt = document.createElement('div');
        stmt.className = 'pl-statement';
        function line(label, value, cls) {
            var row = document.createElement('div');
            row.className = 'pl-line' + (cls ? ' ' + cls : '');
            var l = document.createElement('span'); l.className = 'pl-line-label'; l.textContent = label;
            var v = document.createElement('span'); v.className = 'pl-line-val'; v.textContent = fmtMoney(value, cur);
            row.appendChild(l); row.appendChild(v);
            return row;
        }
        stmt.appendChild(line(daText('Revenue', 'Omsætning'), card.revenue, 'pl-revenue'));

        // Expenses, by category (indented), then a subtotal.
        var cats = card.expense_categories || [];
        if (cats.length) {
            var eh = document.createElement('div'); eh.className = 'pl-subhead';
            eh.textContent = daText('Expenses', 'Udgifter');
            stmt.appendChild(eh);
            cats.forEach(function (c) {
                stmt.appendChild(line('   ' + (c.category || 'Other') + ' (' + (c.count || 0) + ')', -c.ex, 'pl-cat'));
            });
        }
        stmt.appendChild(line(daText('Total expenses', 'Udgifter i alt'), -card.expenses, 'pl-expenses'));
        if (card.mileage) {
            stmt.appendChild(line(daText('Driving (business)', 'Kørsel (erhverv)'), -card.mileage, 'pl-cat'));
        }

        // Profit.
        stmt.appendChild(line(daText('Profit', 'Resultat'), card.profit, 'pl-profit ' + ((card.profit || 0) < 0 ? 'is-loss' : 'is-profit')));
        wrap.appendChild(stmt);

        // Desktop summary (hidden on a phone): profit, margin, after the tax reserve, and
        // where the money went — all from the numbers above, no extra data.
        var tr = card.tax_reserve || {};
        var side = document.createElement('div');
        side.className = 'pl-side';
        var rev = card.revenue || 0, profit = card.profit || 0;
        var margin = rev > 0 ? Math.round(profit / rev * 100) : null;
        side.innerHTML = '<div class="pl-kpis">'
            + '<div class="pl-kpi"><div class="pl-kpi-label">' + progEsc(daText('Profit', 'Resultat')) + '</div><div class="pl-kpi-val' + (profit < 0 ? ' is-loss' : '') + '">' + progEsc(fmtMoney(profit, cur)) + '</div></div>'
            + '<div class="pl-kpi"><div class="pl-kpi-label">' + progEsc(daText('Margin', 'Margin')) + '</div><div class="pl-kpi-val">' + (margin == null ? '—' : margin + '%') + '</div></div>'
            + '<div class="pl-kpi"><div class="pl-kpi-label">' + progEsc(daText('After tax reserve', 'Efter skattehensættelse')) + '</div><div class="pl-kpi-val">' + progEsc(fmtMoney(profit - (tr.amount || 0), cur)) + '</div></div>'
            + '</div>';
        var parts = (card.expense_categories || []).map(function (c) { return { label: c.category || 'Other', value: c.ex || 0 }; });
        if (card.mileage) parts.push({ label: daText('Driving (business)', 'Kørsel (erhverv)'), value: card.mileage });
        var costTotal = parts.reduce(function (a, b) { return a + b.value; }, 0);
        if (parts.length && costTotal > 0) {
            parts.sort(function (a, b) { return b.value - a.value; });
            var bars = '<div class="pl-bars-head">' + progEsc(daText('Where the costs went', 'Hvor udgifterne gik hen')) + '</div>';
            parts.forEach(function (x, i) {
                var pct = Math.round(x.value / costTotal * 100);
                bars += '<div class="wpb-row"><span class="wpb-name">' + progEsc(x.label) + '</span>'
                    + '<span class="wpb-track"><span class="wpb-fill" style="width:' + pct + '%;background:' + seriesColor(i) + '"></span></span>'
                    + '<span class="wpb-val">' + pct + '%</span></div>';
            });
            side.innerHTML += '<div class="pl-bars">' + bars + '</div>';
        }
        wrap.appendChild(side);

        // Tax reserve note.
        var note = document.createElement('div');
        note.className = 'pl-note';
        setIconText(note, 'lock', daText('Set aside for tax (est. ', 'Hensæt til skat (ca. ') + (tr.pct || 0) + '%): '
            + fmtMoney(tr.amount, cur));
        wrap.appendChild(note);

        var foot = document.createElement('div');
        foot.className = 'moms-foot';
        foot.textContent = daText(
            'Accrual, ex-VAT — booked income and confirmed expenses by their own date. An estimate, not a filed annual account.',
            'Periodiseret, ekskl. moms — bogført indtægt og bekræftede udgifter efter egen dato. Et estimat, ikke et indberettet årsregnskab.');
        wrap.appendChild(foot);
    }

    // ---- Mileage (kind: mileage) — kørsel, 60-day rule ----
    function renderMileage(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card mileage-card';
        drawMileage(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function mileageFetch(wrap, offset) {
        fetch('/api/mileage.php?offset=' + (offset || 0), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawMileage(wrap, j.card); })
            .catch(function () {});
    }

    function mileagePost(wrap, body) {
        fetch('/api/mileage.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) drawMileage(wrap, j.card); })
            .catch(function () {});
    }

    // Address → distance lookup (does NOT save; fills a field the user confirms).
    function mileageLookup(home, dest, cb) {
        fetch('/api/mileage.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'lookup_distance', home: home, dest: dest })
        })
            .then(function (r) { return r.json(); })
            .then(function (j) { cb(j || { ok: false, error: 'No response.' }); })
            .catch(function () { cb({ ok: false, error: daText('Network error.', 'Netværksfejl.') }); });
    }

    function drawMileage(wrap, card) {
        wrap.innerHTML = '';
        var cur = card.currency || 'DKK';
        var biz = card.business || {}, com = card.commuter || {};

        // Header + year nav.
        var head = document.createElement('div');
        head.className = 'books-head';
        var title = document.createElement('div'); title.className = 'books-title';
        title.textContent = daText('Mileage', 'Kørsel');
        head.appendChild(title);
        var nav = document.createElement('div'); nav.className = 'books-nav';
        var prev = document.createElement('button');
        prev.type = 'button'; prev.className = 'books-navbtn'; prev.textContent = '‹';
        prev.setAttribute('aria-label', daText('Previous year', 'Forrige år'));
        prev.addEventListener('click', function () { mileageFetch(wrap, (card.offset || 0) - 1); });
        var lbl = document.createElement('span'); lbl.className = 'books-navlabel'; lbl.textContent = card.period_label || '';
        var next = document.createElement('button');
        next.type = 'button'; next.className = 'books-navbtn'; next.textContent = '›';
        next.disabled = !card.can_next;
        next.setAttribute('aria-label', daText('Next year', 'Næste år'));
        next.addEventListener('click', function () { if (card.can_next) mileageFetch(wrap, (card.offset || 0) + 1); });
        nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
        head.appendChild(nav);
        wrap.appendChild(head);

        // Two deduction figures.
        var heroes = document.createElement('div');
        heroes.className = 'cash-heroes';
        function hero(label, value, cls, sub) {
            var h = document.createElement('div'); h.className = 'cash-hero ' + cls;
            var l = document.createElement('div'); l.className = 'cash-hero-label'; l.textContent = label;
            var v = document.createElement('div'); v.className = 'cash-hero-val'; v.textContent = fmtMoney(value, cur);
            h.appendChild(l); h.appendChild(v);
            if (sub) { var s = document.createElement('div'); s.className = 'cash-hero-sub'; s.textContent = sub; h.appendChild(s); }
            return h;
        }
        heroes.appendChild(hero(daText('Business deduction', 'Erhvervsfradrag'), biz.amount, 'is-expected',
            (biz.days || 0) + ' ' + daText('days · in your P&L', 'dage · i din resultatopgørelse')));
        heroes.appendChild(hero(daText('Commuter estimate', 'Pendlerfradrag (est.)'), com.amount, 'is-free',
            (com.days || 0) + ' ' + daText('days · personal tax return', 'dage · personlig selvangivelse')));
        wrap.appendChild(heroes);

        // Suggested drives (phase 5) — detected from location, awaiting confirmation.
        var suggestions = card.suggestions || [];
        if (suggestions.length) {
            var sSec = document.createElement('div'); sSec.className = 'mileage-suggest';
            var sHead = document.createElement('div'); sHead.className = 'mileage-suggest-head';
            sHead.textContent = '🚗 ' + daText('Suggested drives', 'Foreslåede ture');
            sSec.appendChild(sHead);
            suggestions.forEach(function (s) { sSec.appendChild(buildSuggestRow(wrap, s, cur, card)); });
            wrap.appendChild(sSec);
        }

        // Destinations — grouped by tax type (business vs commute), compact cards.
        var dests = card.destinations || [];
        var destSec = document.createElement('div');
        destSec.className = 'mileage-dests';

        var destHead = document.createElement('div');
        destHead.className = 'mileage-dests-head';
        var dhTitle = document.createElement('span');
        dhTitle.className = 'mileage-dests-title';
        dhTitle.textContent = daText('Destinations', 'Destinationer');
        var addDestBtn = document.createElement('button');
        addDestBtn.type = 'button'; addDestBtn.className = 'mileage-link';
        addDestBtn.textContent = '+ ' + daText('Add', 'Tilføj');
        destHead.appendChild(dhTitle); destHead.appendChild(addDestBtn);
        destSec.appendChild(destHead);

        [
            { type: 'business', label: daText('Business · in your P&L', 'Erhverv · i dit resultat'),
              items: dests.filter(function (d) { return d.type !== 'commute'; }) },
            { type: 'commute',  label: daText('Commute · personal return', 'Pendling · personlig selvangivelse'),
              items: dests.filter(function (d) { return d.type === 'commute'; }) }
        ].forEach(function (g) {
            if (!g.items.length) return;
            var gl = document.createElement('div');
            gl.className = 'mileage-group-label mileage-group-' + g.type;
            gl.textContent = g.label;
            destSec.appendChild(gl);
            g.items.forEach(function (d) { destSec.appendChild(buildDestRow(wrap, d, cur)); });
        });
        if (!dests.length) {
            var noDest = document.createElement('div');
            noDest.className = 'mileage-dist';
            noDest.textContent = daText('No destinations yet — add one (a customer or a workplace) to start logging.',
                                        'Ingen destinationer endnu — tilføj en (en kunde eller en arbejdsplads) for at logge.');
            destSec.appendChild(noDest);
        }

        var addEditor = buildDestEditor(wrap, null);
        addEditor.style.display = 'none';
        destSec.appendChild(addEditor);
        addDestBtn.addEventListener('click', function () {
            addEditor.style.display = addEditor.style.display === 'none' ? 'block' : 'none';
        });
        wrap.appendChild(destSec);

        // Log a driving day (destination + date + optional km override).
        var form = document.createElement('div');
        form.className = 'books-addform mileage-logform';
        form.style.display = 'none';
        var dSel = document.createElement('select'); dSel.className = 'books-addinput mileage-destsel';
        [
            { label: daText('Business', 'Erhverv'), items: dests.filter(function (d) { return d.type !== 'commute'; }) },
            { label: daText('Commute', 'Pendling'), items: dests.filter(function (d) { return d.type === 'commute'; }) }
        ].forEach(function (g) {
            if (!g.items.length) return;
            var og = document.createElement('optgroup'); og.label = g.label;
            g.items.forEach(function (d) {
                var opt = document.createElement('option'); opt.value = d.id; opt.textContent = d.name;
                og.appendChild(opt);
            });
            dSel.appendChild(og);
        });
        var dDate = document.createElement('input'); dDate.type = 'date'; dDate.className = 'books-addinput';
        dDate.value = new Date().toISOString().slice(0, 10);
        var dKm = document.createElement('input'); dKm.type = 'number'; dKm.step = '0.1'; dKm.min = '0';
        dKm.className = 'books-addinput'; dKm.placeholder = daText('km (optional)', 'km (valgfri)');
        var dSave = document.createElement('button'); dSave.type = 'button'; dSave.className = 'books-addsave';
        dSave.textContent = daText('Log', 'Registrér');
        dSave.addEventListener('click', function () {
            var body = { action: 'log', date: dDate.value };
            if (dSel.value) body.destination_id = parseInt(dSel.value, 10);
            if (dKm.value) body.km = parseFloat(dKm.value);
            mileagePost(wrap, body);
        });
        form.appendChild(dSel); form.appendChild(dDate); form.appendChild(dKm); form.appendChild(dSave);

        var addBtn = document.createElement('button');
        addBtn.type = 'button'; addBtn.className = 'books-add mileage-add';
        setIconText(addBtn, 'car', daText('Log a driving day', 'Registrér en køredag'));
        addBtn.addEventListener('click', function () {
            if (!dests.length) { addEditor.style.display = 'block'; return; }
            form.style.display = form.style.display === 'none' ? 'flex' : 'none';
        });
        wrap.appendChild(addBtn);
        wrap.appendChild(form);

        // Logged days this year.
        var trips = card.trips || [];
        if (trips.length) {
            var list = document.createElement('ul'); list.className = 'books-list';
            trips.forEach(function (t) {
                var li = document.createElement('li'); li.className = 'books-row';
                var left = document.createElement('div'); left.className = 'books-row-main';
                var badge = document.createElement('span');
                badge.className = 'mileage-badge mileage-badge-' + t.bucket;
                badge.textContent = t.bucket === 'business' ? daText('business', 'erhverv') : daText('commute', 'pendling');
                rowDateName(left, t.date, (t.destination ? t.destination + ' · ' : '') + (t.km || 0) + ' km' + (t.note ? ' · ' + t.note : ''));
                left.appendChild(badge);
                var amt = document.createElement('span'); amt.className = 'books-amt'; amt.textContent = fmtMoney(t.amount, cur);
                var del = deleteButton(daText('Delete day', 'Slet dag'));
                del.className += ' books-row-del';
                del.addEventListener('click', function () {
                    if (!window.confirm(daText('Delete this driving day?', 'Slet denne køredag?'))) return;
                    del.disabled = true;
                    mileagePost(wrap, { action: 'delete', id: t.id });
                });
                li.appendChild(left); li.appendChild(amt); li.appendChild(del);
                list.appendChild(li);
            });
            wrap.appendChild(list);
        }

        var foot = document.createElement('div');
        foot.className = 'moms-foot';
        foot.textContent = daText(
            'Business destinations: first 60 days each = business driving (statens takst, in your P&L); day 61+ = commuting. Commute destinations (a fixed workplace) are befordringsfradrag from day 1 — on your personal return, never in the P&L. An estimate — check the year’s rates.',
            'Erhvervsdestinationer: første 60 dage hver = erhvervskørsel (statens takst, i dit resultat); dag 61+ = pendling. Pendlerdestinationer (en fast arbejdsplads) er befordringsfradrag fra dag 1 — på din personlige selvangivelse, aldrig i resultatet. Et estimat — tjek årets satser.');
        wrap.appendChild(foot);
    }

    // One suggested drive awaiting confirmation. Confirm → log_trip; Dismiss → never re-suggest.
    // If the place isn't linked to a destination yet, the same Log it makes / links the destination (pick what it counts as).
    function buildSuggestRow(wrap, s, cur, card) {
        var row = document.createElement('div'); row.className = 'mileage-sug';

        var main = document.createElement('div'); main.className = 'mileage-sug-main';
        var route = document.createElement('div'); route.className = 'mileage-sug-route'; route.textContent = s.route;
        var meta = document.createElement('div'); meta.className = 'mileage-sug-meta';
        var kmTxt = (s.km != null ? s.km + ' km' : daText('km unknown', 'km ukendt'));
        var gps = (s.gps_km ? '  · GPS ' + s.gps_km + ' km' : '');
        meta.textContent = (s.label || s.date) + ' · ' + kmTxt + gps;
        main.appendChild(route); main.appendChild(meta);
        row.appendChild(main);

        var actions = document.createElement('div'); actions.className = 'mileage-sug-actions';
        if (s.needs_link) {
            // ONE step: say what it counts as, then Log it — a new destination is made from the place (or the place is linked to an existing one)
            // in the same go. (Linking used to be a separate button before "Log it" could appear.)
            var sel = document.createElement('select'); sel.className = 'books-addinput mileage-sug-sel';
            var guess = (s.type === 'business') ? 'business' : 'commute';
            [['new:business', daText('Business', 'Erhverv')], ['new:commute', daText('Commute', 'Pendling')]].forEach(function (o) {
                var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; if (o[0] === 'new:' + guess) op.selected = true; sel.appendChild(op);
            });
            (card.destinations || []).forEach(function (d) {
                var o = document.createElement('option'); o.value = 'dest:' + d.id;
                o.textContent = daText('Same as ', 'Samme som ') + d.name + (d.type === 'commute' ? ' · ' + daText('commute', 'pendling') : '');
                sel.appendChild(o);
            });
            var logIt = document.createElement('button'); logIt.type = 'button'; logIt.className = 'books-addsave';
            logIt.textContent = daText('Log it', 'Registrér');
            logIt.addEventListener('click', function () {
                var body = { action: 'confirm_suggestion', date: s.date, place_id: s.place_id };
                if (s.km != null) body.km = s.km;
                if (sel.value.indexOf('dest:') === 0) { body.destination_id = parseInt(sel.value.slice(5), 10); body.link = true; }
                else body.as_type = sel.value.slice(4);
                mileagePost(wrap, body);
            });
            actions.appendChild(sel); actions.appendChild(logIt);
        } else {
            var conf = document.createElement('button'); conf.type = 'button'; conf.className = 'books-addsave';
            conf.textContent = daText('Log it', 'Registrér');
            conf.addEventListener('click', function () {
                var body = { action: 'confirm_suggestion', date: s.date, destination_id: s.destination_id };
                if (s.km != null) body.km = s.km;
                mileagePost(wrap, body);
            });
            actions.appendChild(conf);
        }
        var dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'mileage-link mileage-sug-dismiss';
        dismiss.textContent = daText('Dismiss', 'Afvis');
        dismiss.addEventListener('click', function () {
            mileagePost(wrap, { action: 'dismiss_suggestion', date: s.date, place_id: s.place_id });
        });
        actions.appendChild(dismiss);
        row.appendChild(actions);

        return row;
    }

    // One COMPACT destination card: name + distance chip + edit; a slim 60-day bar for
    // business destinations; tiny this-year figures; a toggleable editor. A coloured left
    // border marks business vs commute.
    function buildDestRow(wrap, d, cur) {
        var isCommute = d.type === 'commute';
        var row = document.createElement('div');
        row.className = 'mileage-dest mileage-dest-' + (isCommute ? 'commute' : 'business');

        var top = document.createElement('div'); top.className = 'mileage-dest-top';
        var nameEl = document.createElement('span'); nameEl.className = 'mileage-dest-name';
        nameEl.textContent = d.name;
        var dist = document.createElement('span'); dist.className = 'mileage-dest-dist';
        dist.textContent = (d.round_trip > 0) ? d.round_trip + ' km' : daText('set km', 'sæt km');
        var editLink = document.createElement('button');
        editLink.type = 'button'; editLink.className = 'mileage-link mileage-dest-edit';
        editLink.innerHTML = icon('pencil');
        editLink.title = daText('Edit destination', 'Ret destination');
        editLink.setAttribute('aria-label', editLink.title);
        top.appendChild(nameEl); top.appendChild(dist); top.appendChild(editLink);
        row.appendChild(top);

        if (!isCommute && d.counter) {
            var used = d.counter.business_used || 0, limit = d.counter.limit || 60, rem = d.counter.remaining || 0;
            var mini = document.createElement('div');
            mini.className = 'mileage-mini' + (d.counter.commuting_now ? ' is-over' : '');
            var track = document.createElement('div'); track.className = 'mileage-mini-bar';
            var fill = document.createElement('div'); fill.className = 'mileage-mini-fill';
            fill.style.width = Math.min(100, Math.round((used / limit) * 100)) + '%';
            track.appendChild(fill);
            var mlabel = document.createElement('span'); mlabel.className = 'mileage-mini-label';
            mlabel.textContent = d.counter.commuting_now
                ? daText('60/60 · commuting', '60/60 · pendling')
                : used + '/' + limit + ' · ' + rem + ' ' + daText('left', 'tilbage');
            mini.appendChild(track); mini.appendChild(mlabel);
            row.appendChild(mini);
        }

        var figs = [];
        if (d.business && d.business.days) figs.push(d.business.days + daText('d business · ', 'd erhverv · ') + fmtMoney(d.business.amount, cur));
        if (d.commuter && d.commuter.days) figs.push(d.commuter.days + daText('d commute · ', 'd pendling · ') + fmtMoney(d.commuter.amount, cur));
        if (figs.length) {
            var figEl = document.createElement('div'); figEl.className = 'mileage-dest-figs';
            figEl.textContent = figs.join('   ');
            row.appendChild(figEl);
        }

        var editor = buildDestEditor(wrap, d);
        editor.style.display = 'none';
        row.appendChild(editor);
        editLink.addEventListener('click', function () {
            editor.style.display = editor.style.display === 'none' ? 'block' : 'none';
        });

        return row;
    }

    // The add/edit destination editor (d = null → add-new). Includes an address→distance
    // lookup that only fills the km field; the user still confirms with Save.
    function buildDestEditor(wrap, d) {
        var isNew = !d;
        var box = document.createElement('div'); box.className = 'mileage-dest-editor';

        var nameIn = document.createElement('input'); nameIn.type = 'text'; nameIn.className = 'books-addinput';
        nameIn.placeholder = daText('Name (e.g. Customer, Office)', 'Navn (fx Kunde, Kontor)');
        nameIn.value = isNew ? '' : (d.name || '');

        var typeSel = document.createElement('select'); typeSel.className = 'books-addinput';
        [['business', daText('Business (P&L)', 'Erhverv (resultat)')], ['commute', daText('Commute (personal)', 'Pendling (personlig)')]].forEach(function (o) {
            var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
            if (!isNew && d.type === o[0]) opt.selected = true;
            typeSel.appendChild(opt);
        });

        var kmIn = document.createElement('input'); kmIn.type = 'number'; kmIn.step = '0.1'; kmIn.min = '0';
        kmIn.className = 'books-addinput'; kmIn.placeholder = daText('Round-trip km', 'Tur/retur km');
        kmIn.value = isNew ? '' : (d.round_trip || '');

        var homeIn = document.createElement('input'); homeIn.type = 'text'; homeIn.className = 'books-addinput';
        homeIn.placeholder = daText('Home address (for lookup)', 'Hjemmeadresse (til opslag)');
        homeIn.value = isNew ? '' : (d.home_address || '');
        var destIn = document.createElement('input'); destIn.type = 'text'; destIn.className = 'books-addinput';
        destIn.placeholder = daText('Destination address (for lookup)', 'Destinationsadresse (til opslag)');
        destIn.value = isNew ? '' : (d.dest_address || '');

        var lookupBtn = document.createElement('button'); lookupBtn.type = 'button'; lookupBtn.className = 'mileage-link';
        setIconText(lookupBtn, 'map-pin', daText('Look up distance', 'Slå afstand op'));
        var lookupMsg = document.createElement('div'); lookupMsg.className = 'mileage-lookup-msg';
        lookupBtn.addEventListener('click', function () {
            if (!homeIn.value.trim() || !destIn.value.trim()) {
                lookupMsg.textContent = daText('Enter both addresses first.', 'Indtast begge adresser først.');
                return;
            }
            lookupBtn.disabled = true;
            lookupMsg.textContent = daText('Looking up…', 'Slår op…');
            mileageLookup(homeIn.value.trim(), destIn.value.trim(), function (res) {
                lookupBtn.disabled = false;
                if (res && res.ok && res.lookup) {
                    kmIn.value = res.lookup.round_trip_km;
                    lookupMsg.textContent = daText('Round trip ≈ ', 'Tur/retur ≈ ') + res.lookup.round_trip_km + ' km ('
                        + res.lookup.one_way_km + daText(' km each way)', ' km hver vej)');
                } else {
                    lookupMsg.textContent = (res && res.error) || daText('Lookup failed.', 'Opslag mislykkedes.');
                }
            });
        });

        var save = document.createElement('button'); save.type = 'button'; save.className = 'books-addsave';
        save.textContent = daText('Save', 'Gem');
        save.addEventListener('click', function () {
            if (!nameIn.value.trim()) { nameIn.focus(); return; }
            var body = {
                action: isNew ? 'add_destination' : 'update_destination',
                name: nameIn.value.trim(),
                type: typeSel.value,
                km: parseFloat(kmIn.value) || 0,
                home_address: homeIn.value.trim(),
                dest_address: destIn.value.trim()
            };
            if (!isNew) body.id = d.id;
            mileagePost(wrap, body);
        });

        var row1 = document.createElement('div'); row1.className = 'mileage-editrow';
        row1.appendChild(nameIn); row1.appendChild(typeSel); row1.appendChild(kmIn);
        var row2 = document.createElement('div'); row2.className = 'mileage-editrow';
        row2.appendChild(homeIn); row2.appendChild(destIn);
        var row3 = document.createElement('div'); row3.className = 'mileage-editrow';
        row3.appendChild(lookupBtn);
        if (!isNew) {
            var arch = document.createElement('button'); arch.type = 'button'; arch.className = 'mileage-link mileage-archive';
            arch.textContent = daText('archive', 'arkivér');
            arch.addEventListener('click', function () {
                if (!window.confirm(daText('Archive this destination? Its logged days stay.', 'Arkivér denne destination? Loggede dage bevares.'))) return;
                mileagePost(wrap, { action: 'archive_destination', id: d.id });
            });
            row3.appendChild(arch);
        }
        row3.appendChild(save);

        box.appendChild(row1); box.appendChild(row2); box.appendChild(lookupMsg); box.appendChild(row3);
        return box;
    }

    function uploadReceipt(file) {
        clearEmptyHint();
        var bubble = addMessage('', 'user');
        var media = document.createElement('span');
        media.className = 'receipt-media';
        bubble.appendChild(media);
        showReceiptPreview(media, URL.createObjectURL(file)); // falls back to a tile if undecodable (e.g. HEIC)

        var typing = addMessage('Reading the receipt…', 'assistant');
        typing.classList.add('typing');
        var av = typing.querySelector('.avatar');
        if (av) av.src = AVATAR_FLYING;

        var fd = new FormData();
        fd.append('photo', file);
        fetch('/api/receipt-upload.php', { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                typing.remove();
                if (!res.ok || !res.j || res.j.error) {
                    addMessage((res.j && res.j.error) || 'Could not read that receipt.', 'error');
                    return;
                }
                // Swap the preview for the server's converted JPEG (always displayable).
                if (res.j.card && res.j.card.image_url) showReceiptPreview(media, res.j.card.image_url);
                addMessage("Here's what I read — check and confirm:", 'assistant');
                if (res.j.card) renderReceipt(res.j.card);
            })
            .catch(function () { typing.remove(); addMessage('Network error uploading the receipt.', 'error'); });
    }

    // Shows an image in the receipt bubble; on a decode error (HEIC etc.) swaps to
    // a clean placeholder tile instead of the browser's broken-image icon.
    function showReceiptPreview(media, url) {
        var img = document.createElement('img');
        img.className = 'receipt-thumb-msg';
        img.alt = 'receipt';
        img.addEventListener('click', function () { openLightbox(url); });
        img.addEventListener('error', function () {
            var ph = document.createElement('span');
            ph.className = 'receipt-thumb-ph';
            ph.innerHTML = icon('receipt');
            media.innerHTML = '';
            media.appendChild(ph);
        });
        img.src = url;
        media.innerHTML = '';
        media.appendChild(img);
    }

    // General photo → assistant. Unlike a receipt (specialised read-and-book), this
    // runs a full assistant turn with the image attached, so the model reads it and
    // acts (calendar event, list item, reminder, expense…). Response is handled just
    // like a chat reply. An optional caption (whatever's typed in the composer) rides
    // along as an instruction.
    function uploadPhoto(file, caption) {
        if (busy) return;
        busy = true;
        clearEmptyHint();
        resumeConversation = null;   // committing to this chat; drop any resume offer
        clearSuggestions();
        var wasNew = !conversationId;

        var bubble = addMessage(caption || '', 'user');
        var media = document.createElement('span');
        media.className = 'receipt-media';
        bubble.appendChild(media);
        showPhotoPreview(media, URL.createObjectURL(file)); // falls back to a tile if undecodable (HEIC)

        var typing = addMessage('…', 'assistant');
        typing.classList.add('typing');
        var av = typing.querySelector('.avatar');
        if (av) av.src = AVATAR_FLYING;

        var fd = new FormData();
        fd.append('photo', file);
        if (caption) fd.append('caption', caption);
        if (conversationId) fd.append('conversation_id', String(conversationId));
        var turnId = newTurnId();
        fd.append('turn_id', turnId);
        var stopProgress = startToolProgress(typing, turnId);

        fetch('/api/photo.php', { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (j) {
                    return { ok: r.ok, status: r.status, j: j };
                });
            })
            .then(function (res) {
                stopProgress();
                typing.remove();
                if (res.status === 401) { window.location.href = '/index.php'; return; }
                if (!res.ok || !res.j || res.j.error) {
                    if (res.j && res.j.debug) console.error('[Kachow] photo.php:', res.j.debug);
                    addMessage((res.j && res.j.error) || 'Could not read that photo.', 'error');
                    return;
                }
                var data = res.j;
                if (data.conversation_id) {
                    conversationId = data.conversation_id;
                    localStorage.setItem(CONV_KEY, String(conversationId));
                }
                var replyRow = addMessage(data.reply || '(no reply)', 'assistant', data.reply_html);
                attachMessageMeta(replyRow, { id: data.assistant_message_id, diagnostics: data.diagnostics });
                attachMessageMeta(bubble, { id: data.user_message_id });
                if (data.card) { applyAppearanceFromCard(data.card); presentCard(data.card, data.card_mode); }
                if (data.suggestions && data.suggestions.length) renderSuggestions(data.suggestions);
                if (wasNew && conversationId) {
                    fetch('/api/conversations.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ action: 'generate_title', id: conversationId }),
                    }).catch(function () { /* non-fatal */ });
                }
            })
            .catch(function () { typing.remove(); addMessage('Network error uploading the photo.', 'error'); })
            .finally(function () { stopProgress(); busy = false; });
    }

    // Like showReceiptPreview but with a generic image fallback tile for a photo.
    function showPhotoPreview(media, url) {
        var img = document.createElement('img');
        img.className = 'receipt-thumb-msg';
        img.alt = 'photo';
        img.addEventListener('click', function () { openLightbox(url); });
        img.addEventListener('error', function () {
            var ph = document.createElement('span');
            ph.className = 'receipt-thumb-ph';
            ph.innerHTML = icon('image');
            media.innerHTML = '';
            media.appendChild(ph);
        });
        img.src = url;
        media.innerHTML = '';
        media.appendChild(img);
    }

    // Read-only work-hours card: a big total + the day's sessions (in–out).
    // ---- Location day (OwnTracks raw points on a map) --------------------------------
    // Leaflet is self-hosted (assets/leaflet, BSD-2) and loaded only when a map card first
    // renders, so the app shell stays light. Tiles come from OpenStreetMap (attribution shown).
    var leafletLoading = null;
    function loadLeaflet() {
        if (window.L && window.L.map) return Promise.resolve(window.L);
        if (leafletLoading) return leafletLoading;
        leafletLoading = new Promise(function (resolve, reject) {
            var css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = '/assets/leaflet/leaflet.css?v=1.9.4';
            document.head.appendChild(css);
            var js = document.createElement('script');
            js.src = '/assets/leaflet/leaflet.js?v=1.9.4';
            js.onload = function () { resolve(window.L); };
            js.onerror = function () { leafletLoading = null; reject(new Error('leaflet')); };
            document.head.appendChild(js);
        });
        return leafletLoading;
    }

    function locToday() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function locShiftDate(ymd, days) {
        var p = ymd.split('-').map(Number);
        var d = new Date(p[0], p[1] - 1, p[2] + days);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function fetchLocationDay(date) {
        return fetch('/api/location.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: date })
        }).then(function (r) { return r.json(); });
    }

    // ---- Location: ONE card — the day (route, stats, timeline) and the saved places — over ONE map ----------
    // A 'location_day' card opens on the Day tab and a 'places' card on the Places tab; the other half is fetched the first time its
    // tab is used. Both views draw into layer groups of the same Leaflet map and into the same side pane, so asking for "my location"
    // and then for "the registered places" is one card you flip, not two.
    function adoptPanelCard(card, wrap) {
        // The tabs change which kind the panel shows: keep the panel's own record (title, summary, rail) in step with it.
        if (!cardPanel || !wrap.closest('#cardPanelBody')) return;
        panelKind = card.kind;
        panelCard = card;
        setIconText(cardPanelTitle, cardIconFor(card), cardTitleFor(card));
        cardPanelSub.textContent = cardSubFor(card);
        recordRailCard(card);
        renderRail();
    }

    function renderLocation(initial) {
        clearEmptyHint();
        var ctx = {
            view: initial.kind === 'places' ? 'places' : 'day',
            day: initial.kind === 'location_day' ? initial : null,
            places: initial.kind === 'places' ? initial : null,
            token: 0, mapReady: null, fit: null
        };
        var L = null, map = null;                       // Leaflet and the one shared map
        var dayLayer = null, placeLayer = null, draftLayer = null, placeLayers = {};
        var draft = null, hint = null;                  // the place being edited (Places view)
        var card = null, places = [];                   // the Places payload the editor below works on

        var wrap = document.createElement('div');
        wrap.className = 'plan-card loc-card';
        var tabs = document.createElement('div');
        tabs.className = 'loc-tabs';
        var tabBtns = {};
        [['day', daText('Day', 'Dag')], ['places', daText('Places', 'Steder')]].forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'loc-tab';
            b.textContent = t[1];
            b.addEventListener('click', function () { if (ctx.view !== t[0]) show(t[0]); });
            tabs.appendChild(b);
            tabBtns[t[0]] = b;
        });
        var side = document.createElement('div');
        side.className = 'loc-side';
        var mapEl = document.createElement('div');
        mapEl.className = 'loc-map';
        wrap.appendChild(tabs);
        wrap.appendChild(side);
        wrap.appendChild(mapEl);
        messages.appendChild(wrap);

        function adopt(c) { adoptPanelCard(c, wrap); }

        function hasData(view) {
            var c = view === 'day' ? ctx.day : ctx.places;
            if (!c) return false;
            if (c.stripped) {                           // reopened from chat history: no coordinates were kept
                return view === 'day' ? (c.points || []).length > 0 || !c.date : (c.places || []).length > 0 || !c.count;
            }
            return true;
        }

        function show(view) {
            ctx.view = view;
            draft = null;
            wrap.setAttribute('data-view', view);
            Object.keys(tabBtns).forEach(function (k) { tabBtns[k].classList.toggle('is-active', k === view); });
            mapEl.classList.toggle('places-map', view === 'places');
            var mine = ++ctx.token;                     // a slow answer for an earlier tab must not paint over this one
            if (hasData(view)) { paint(); return; }
            side.innerHTML = '';
            clearLayers();
            var ld = document.createElement('div');
            ld.className = 'plan-empty';
            ld.textContent = view === 'day' ? daText('Loading the day…', 'Henter dagen…') : daText('Loading places…', 'Henter steder…');
            side.appendChild(ld);
            var req = view === 'day'
                ? fetchLocationDay(ctx.day && ctx.day.date ? ctx.day.date : locToday())
                : postPlaces({ action: 'list' }, true);
            req.then(function (j) {
                if (mine !== ctx.token) return;
                if (!j || !j.card) throw new Error('no card');
                if (view === 'day') ctx.day = j.card; else ctx.places = j.card;
                adopt(j.card);
                paint();
            }).catch(function () {
                if (mine === ctx.token) ld.textContent = daText('Could not load that.', 'Kunne ikke hente det.');
            });
        }

        // A saved / deleted place changes what the day card says about "time in your places", so the day is re-read next time.
        function placesChanged(c) {
            ctx.places = c;
            ctx.day = null;
            adopt(c);
            show('places');
        }

        function paint() {
            draft = null;
            side.innerHTML = '';
            if (ctx.view === 'day') buildDay(); else buildPlaces();
            withMap(function () { if (ctx.view === 'day') drawDay(); else drawPlaces(); });
        }

        // ---------- the shared map ----------
        function clearLayers() {
            if (!map) return;
            dayLayer.clearLayers();
            placeLayer.clearLayers();
            draftLayer.clearLayers();
            placeLayers = {};
        }
        function withMap(fn) {
            if (map) { fn(); return; }
            if (!ctx.mapReady) {
                ctx.mapReady = loadLeaflet().then(function (lib) {
                    if (!mapEl.isConnected) return null;
                    L = lib;
                    map = L.map(mapEl, { zoomControl: true, attributionControl: true });
                    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
                    }).addTo(map);
                    dayLayer = L.layerGroup().addTo(map);
                    placeLayer = L.layerGroup().addTo(map);
                    draftLayer = L.featureGroup().addTo(map);
                    map.on('click', function (ev) {
                        if (ctx.view !== 'places' || !draft) return;
                        var ll = [Math.round(ev.latlng.lat * 1e6) / 1e6, Math.round(ev.latlng.lng * 1e6) / 1e6];
                        if (draft.shape === 'circle') { draft.lat = ll[0]; draft.lon = ll[1]; }
                        else draft.polygon.push(ll);
                        drawDraft();
                    });
                    if (window.ResizeObserver) {
                        var lastW = mapEl.clientWidth;
                        new ResizeObserver(function () {
                            if (mapEl.clientWidth && mapEl.clientWidth !== lastW) {
                                lastW = mapEl.clientWidth;
                                if (ctx.fit) ctx.fit(); else map.invalidateSize();
                            }
                        }).observe(mapEl);
                    }
                    return map;
                });
            }
            ctx.mapReady.then(function (m) { if (m) fn(); })
                .catch(function () { mapEl.textContent = daText('The map could not load.', 'Kortet kunne ikke indlæses.'); });
        }

        // ---------- Day view ----------
        function buildDay() {
            var card = ctx.day;
            var st = card.stats || {};
        // Header: day with previous / next (no "next" past today).
        var head = document.createElement('div');
        head.className = 'plan-card-title loc-head';
        var prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'loc-nav';
        prev.setAttribute('aria-label', daText('Previous day', 'Forrige dag'));
        prev.innerHTML = icon('chevron-left');
        var title = document.createElement('span');
        title.className = 'loc-title';
        title.textContent = card.title || card.date || '';
        var next = document.createElement('button');
        next.type = 'button';
        next.className = 'loc-nav';
        next.setAttribute('aria-label', daText('Next day', 'Næste dag'));
        next.innerHTML = icon('chevron-right');
        next.disabled = !card.date || card.date >= locToday();
        function go(days) {
            if (!card.date) return;
            prev.disabled = next.disabled = true;
            fetchLocationDay(locShiftDate(card.date, days)).then(function (j) {
                if (j && j.card) { ctx.day = j.card; adopt(j.card); paint(); }
            }).catch(function () {
                prev.disabled = false;
                next.disabled = card.date >= locToday();
                toast(daText('Could not load that day.', 'Kunne ikke hente den dag.'));
            });
        }
        prev.addEventListener('click', function () { go(-1); });
        next.addEventListener('click', function () { go(1); });
        head.appendChild(prev);
        head.appendChild(title);
        head.appendChild(next);
        side.appendChild(head);

        // Stats (data quality for phase 1): points, span, distance, cadence, gaps, accuracy, battery.
        var stats = document.createElement('div');
        stats.className = 'loc-stats';
        function stat(label, value) {
            if (value == null || value === '') return;
            var d = document.createElement('div');
            d.className = 'loc-stat';
            d.innerHTML = '<span class="loc-stat-v">' + progEsc(String(value)) + '</span>'
                + '<span class="loc-stat-l">' + progEsc(label) + '</span>';
            stats.appendChild(d);
        }
        if (st.points) {
            stat(daText('distance', 'distance'), st.distance_km + ' km');
            stat(daText('tracked', 'sporet'), st.first + ' – ' + st.last);
            stat(daText('points', 'punkter'), st.points);
            stat(daText('avg interval', 'gns. interval'), st.avg_interval_min != null ? st.avg_interval_min + ' min' : null);
            if (st.largest_gap && st.largest_gap.minutes) {
                stat(daText('largest gap ', 'største hul ') + st.largest_gap.from + '–' + st.largest_gap.to, st.largest_gap.minutes + ' min');
            }
            stat(daText('median accuracy', 'median nøjagtighed'), st.median_acc_m != null ? '±' + st.median_acc_m + ' m' : null);
            if (st.battery) stat(daText('battery', 'batteri'), st.battery.from + '% → ' + st.battery.to + '%');
        }
        side.appendChild(stats);

        // Time in the user's places (phase 2: a first, simple estimate from runs of points inside).
        if ((st.in_places || []).length) {
            var ip = document.createElement('div');
            ip.className = 'loc-inplaces';
            st.in_places.forEach(function (pl) {
                var row = document.createElement('div');
                row.className = 'loc-ip';
                var visits = (pl.visits || []).map(function (v) {
                    return v.from + '–' + (v.ongoing ? daText('now', 'nu') : v.to);
                }).join(', ');
                row.innerHTML = '<span class="loc-ip-dot" style="background:' + placeColor(pl.type) + '"></span>'
                    + '<span class="loc-ip-name">' + progEsc(pl.place) + '</span>'
                    + '<span class="loc-ip-time">' + progEsc(pl.minutes ? wchFmtMin(pl.minutes) : '—') + '</span>'
                    + '<span class="loc-ip-visits">' + progEsc(visits
                        + (pl.passes ? (visits ? ' · ' : '') + pl.passes + ' ' + daText(pl.passes === 1 ? 'pass-by' : 'pass-bys', 'forbikørsler') : '')) + '</span>';
                ip.appendChild(row);
            });
            side.appendChild(ip);
        }

        // Timeline (phase 3): stays and the trips between them, in order.
        if ((card.timeline || []).length) {
            var tl = document.createElement('ol');
            tl.className = 'loc-timeline';
            card.timeline.forEach(function (it) {
                var li = document.createElement('li');
                if (it.kind === 'stay') {
                    li.className = 'tl-stay' + (it.ongoing ? ' is-live' : '');
                    var name = it.place || daText('Unnamed place', 'Unavngivet sted');
                    li.innerHTML = '<span class="loc-ip-dot" style="background:' + (it.place ? placeColor(it.type) : '#94a3b8') + '"></span>'
                        + '<span class="tl-when">' + progEsc((it.prev_day ? '… ' : '') + it.from + '–' + (it.ongoing ? daText('now', 'nu') : it.to) + (it.next_day ? ' …' : '')) + '</span>'
                        + '<span class="tl-name' + (it.place ? '' : ' is-unnamed') + '">' + progEsc(name) + '</span>'
                        + '<span class="tl-dur">' + progEsc(wchFmtMin(it.minutes)) + '</span>';
                } else if (it.kind === 'gap') {
                    // The phone reported nothing here. Say so — never fill it in with a guess.
                    li.className = 'tl-gap' + (it.ongoing ? ' is-stopped' : '');
                    li.innerHTML = '<span class="tl-line is-dashed"></span>'
                        + '<span class="tl-when">' + progEsc((it.prev_day ? '… ' : '') + it.start_time + '–' + it.end_time + (it.next_day ? ' …' : '')) + '</span>'
                        + '<span class="tl-name">' + progEsc(it.ongoing
                            ? daText('No data — tracking stopped', 'Ingen data — sporing stoppet')
                            : daText('No data', 'Ingen data')) + '</span>'
                        + '<span class="tl-dur">' + progEsc(wchFmtMin(it.minutes)) + '</span>';
                } else {
                    li.className = 'tl-trip';
                    var mode = { walk: daText('walk', 'gang'), bike: daText('bike', 'cykel'), vehicle: daText('car/train', 'bil/tog'), unknown: '' }[it.mode] || '';
                    li.innerHTML = '<span class="tl-line"></span>'
                        + '<span class="tl-when">' + progEsc(it.start_time + '–' + it.end_time) + '</span>'
                        + '<span class="tl-name">' + progEsc([mode, it.km + ' km'].filter(Boolean).join(' · ')) + '</span>'
                        + '<span class="tl-dur">' + progEsc(wchFmtMin(it.minutes)) + '</span>';
                }
                tl.appendChild(li);
            });
            side.appendChild(tl);
        }


            if (!(card.points || []).length && !(card.timeline || []).length) {
                var empty = document.createElement('div');
                empty.className = 'plan-empty';
                empty.textContent = daText('No location points for this day.', 'Ingen positioner for denne dag.');
                side.appendChild(empty);
            }
        }

        function drawDay() {
            var c = ctx.day;
            if (!c) return;
            clearLayers();
            var pts = c.points || [];
            (c.places || []).forEach(function (pl) { drawPlace(L, dayLayer, pl, false); });
            (c.timeline || []).forEach(function (it) {
                if (it.kind !== 'stay') return;
                L.circleMarker([it.lat, it.lon], { radius: 9, weight: 2, color: '#fff',
                    fillColor: it.place ? placeColor(it.type) : '#94a3b8', fillOpacity: 0.95 })
                    .bindTooltip((it.place || daText('Unnamed place', 'Unavngivet sted')) + ' · ' + it.from + '–'
                        + (it.ongoing ? daText('now', 'nu') : it.to)).addTo(dayLayer);
            });
            var goodAcc = c.good_acc_m || 100;
            var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
            var good = pts.filter(function (p) { return p[3] == null || p[3] <= goodAcc; });
            var line = good.map(function (p) { return [p[0], p[1]]; });
            if (line.length > 1) L.polyline(line, { color: accent, weight: 4, opacity: 0.85 }).addTo(dayLayer);
            pts.forEach(function (p) {
                var isGood = p[3] == null || p[3] <= goodAcc;
                L.circleMarker([p[0], p[1]], {
                    radius: isGood ? 3 : 2, weight: 1, color: accent,
                    opacity: isGood ? 0.9 : 0.35, fillOpacity: isGood ? 0.6 : 0.15
                }).bindTooltip(p[2] + (p[3] != null ? ' · ±' + p[3] + ' m' : '') + (p[4] ? ' · ' + p[4] + ' km/h' : '')).addTo(dayLayer);
            });
            var first = pts[0], last = pts[pts.length - 1];
            if (first) {
                // Start drawn larger underneath, so a round trip (start ≈ end) still shows both.
                L.circleMarker([first[0], first[1]], { radius: 10, weight: 2, color: '#fff', fillColor: '#16a34a', fillOpacity: 1 })
                    .bindTooltip(daText('Start ', 'Start ') + first[2]).addTo(dayLayer);
                L.circleMarker([last[0], last[1]], { radius: 6, weight: 2, color: '#fff', fillColor: '#dc2626', fillOpacity: 1 })
                    .bindTooltip(daText('Last ', 'Seneste ') + last[2]).addTo(dayLayer);
            }
            var stayLL = (c.timeline || []).filter(function (it) { return it.kind === 'stay'; }).map(function (it) { return [it.lat, it.lon]; });
            var all = line.concat(stayLL);
            if (!all.length) all = pts.map(function (p) { return [p[0], p[1]]; });
            ctx.fit = function () {
                map.invalidateSize();
                if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 16 });
                else if ((c.places || []).length) {
                    var b = placeBounds(L, c.places[0]);
                    c.places.slice(1).forEach(function (p) { b.extend(placeBounds(L, p)); });
                    map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
                } else map.setView([55.68, 12.57], 11);
            };
            ctx.fit();
        }

        // ---------- Places view ----------
        function buildPlaces() {
            card = ctx.places;
            places = card.places || [];
            showList();
        }

        // --- list view ---
        function showList() {
            draft = null;
            clearDraftLayer();
            side.innerHTML = '';
            var add = document.createElement('button');
            add.type = 'button';
            add.className = 'places-add';
            add.innerHTML = icon('plus', 'ic-lead') + progEsc(daText('Add place', 'Tilføj sted'));
            add.addEventListener('click', function () { edit(null); });
            side.appendChild(add);
            if (!places.length) {
                var e = document.createElement('div');
                e.className = 'plan-empty';
                e.textContent = daText('No places yet. Add one here, or tell me "mark where I am as Office".',
                    'Ingen steder endnu. Tilføj et her, eller skriv "gem stedet her som Kontor".');
                side.appendChild(e);
            }
            // Frequent unnamed places (phase 3): name one with a tap.
            if ((card.suggestions || []).length) {
                var sh = document.createElement('div');
                sh.className = 'places-sugg-head';
                sh.textContent = daText('Suggested — places you keep returning to', 'Forslag — steder du ofte kommer');
                side.appendChild(sh);
                var su = document.createElement('ul');
                su.className = 'places-list places-sugg';
                card.suggestions.forEach(function (sg, i) {
                    var li = document.createElement('li');
                    // A nearby POI (e.g. a supermarket) gives a best-effort name — shown as a
                    // hint here, and pre-filled (still editable) when you tap to name it.
                    var label = sg.suggested_name
                        ? sg.suggested_name
                        : daText('Suggestion ', 'Forslag ') + (i + 1);
                    li.innerHTML = '<span class="loc-ip-dot sugg-dot"></span>'
                        + '<span class="pl-name">' + progEsc(label) + '</span>'
                        + '<span class="pl-meta">' + progEsc(sg.days + ' ' + daText('days', 'dage') + ' · ~' + wchFmtMin(sg.avg_minutes)) + '</span>'
                        + '<span class="pl-sub">' + progEsc(sg.typical) + '</span>';
                    li.title = daText('Name this place', 'Navngiv stedet');
                    li.addEventListener('click', function () {
                        edit({ id: null, name: sg.suggested_name || '', type: 'other', shape: 'circle', lat: sg.lat, lon: sg.lon, radius_m: 100, polygon: [] });
                    });
                    su.appendChild(li);
                });
                side.appendChild(su);
            }
            var ul = document.createElement('ul');
            ul.className = 'places-list';
            places.forEach(function (pl) {
                var li = document.createElement('li');
                if (card.focus === pl.id) li.className = 'is-focus';
                li.innerHTML = '<span class="loc-ip-dot" style="background:' + placeColor(pl.type) + '"></span>'
                    + '<span class="pl-name">' + progEsc(pl.name) + '</span>'
                    + '<span class="pl-meta">' + progEsc(placeTypeLabel(pl.type) + ' · '
                        + (pl.shape === 'polygon' ? daText('polygon', 'polygon') : pl.radius_m + ' m')) + '</span>';
                li.addEventListener('click', function () { edit(pl); });
                ul.appendChild(li);
            });
            side.appendChild(ul);
            if (map) fitAll();
        }

        // --- editor (new place or existing) ---
        function edit(pl) {
            var here = card.here || null;
            var c = map && map._loaded ? map.getCenter() : null;
            var isNew = !pl || !pl.id;
            draft = pl ? JSON.parse(JSON.stringify(pl)) : {
                id: null, name: '', type: 'work', shape: 'circle',
                lat: here ? here[0] : (c ? c.lat : null), lon: here ? here[1] : (c ? c.lng : null),
                radius_m: 100, polygon: []
            };
            if (draft.shape === 'polygon' && !draft.polygon) draft.polygon = [];
            side.innerHTML = '';

            var f = document.createElement('div');
            f.className = 'places-form';
            f.innerHTML =
                '<div class="pf-row2"><label>' + progEsc(daText('Name', 'Navn')) + '<input type="text" class="pf-name" maxlength="64"></label>'
                + '<label>' + progEsc(daText('Type', 'Type')) + '<select class="pf-type"></select></label></div>'
                + '<div class="pf-shape" role="group"><button type="button" data-shape="circle">' + progEsc(daText('Circle', 'Cirkel'))
                + '</button><button type="button" data-shape="polygon">' + progEsc(daText('Polygon', 'Polygon')) + '</button></div>'
                + '<label class="pf-radius-row">' + progEsc(daText('Radius', 'Radius')) + ' <span class="pf-radius-v"></span>'
                + '<input type="range" class="pf-radius" step="5"></label>'
                + '<div class="pf-poly-row"><button type="button" class="pf-undo">' + progEsc(daText('Undo corner', 'Fortryd hjørne'))
                + '</button><button type="button" class="pf-clear">' + progEsc(daText('Clear', 'Ryd')) + '</button></div>'
                + '<div class="pf-hint"></div>'
                + '<div class="pf-actions"><button type="button" class="pf-save">' + progEsc(daText('Save', 'Gem'))
                + '</button><button type="button" class="pf-cancel">' + progEsc(daText('Cancel', 'Annuller')) + '</button>'
                + (!isNew ? '<button type="button" class="pf-delete">' + progEsc(daText('Delete', 'Slet')) + '</button>' : '') + '</div>';
            side.appendChild(f);

            var nameIn = f.querySelector('.pf-name'), typeSel = f.querySelector('.pf-type');
            var radius = f.querySelector('.pf-radius'), radiusV = f.querySelector('.pf-radius-v');
            hint = f.querySelector('.pf-hint');
            nameIn.value = draft.name;
            Object.keys(PLACE_TYPES).forEach(function (t) {
                var o = document.createElement('option');
                o.value = t; o.textContent = placeTypeLabel(t);
                if (t === draft.type) o.selected = true;
                typeSel.appendChild(o);
            });
            radius.min = card.min_radius_m || 25;
            // the slider covers 25–1000 m; a wider circle the assistant made (a stretch of motorway) keeps its radius and widens the slider to it
            radius.max = Math.min(card.max_radius_m || 2000, Math.max(1000, draft.radius_m || 0));
            radius.value = draft.radius_m || 100;
            radiusV.textContent = radius.value >= 1000 ? (radius.value / 1000).toFixed(1).replace(/\.0$/, '') + ' km' : radius.value + ' m';

            function syncShape() {
                f.querySelectorAll('.pf-shape button').forEach(function (b) {
                    b.classList.toggle('is-on', b.getAttribute('data-shape') === draft.shape);
                });
                f.querySelector('.pf-radius-row').hidden = draft.shape !== 'circle';
                f.querySelector('.pf-poly-row').hidden = draft.shape !== 'polygon';
                hint.textContent = draft.shape === 'circle'
                    ? daText('Tap the map to move the centre.', 'Tryk på kortet for at flytte midten.')
                    : daText('Tap the map to add corners (at least 3).', 'Tryk på kortet for at sætte hjørner (mindst 3).');
                drawDraft();
            }
            f.querySelectorAll('.pf-shape button').forEach(function (b) {
                b.addEventListener('click', function () {
                    draft.shape = b.getAttribute('data-shape');
                    if (draft.shape === 'polygon' && !draft.polygon) draft.polygon = [];
                    syncShape();
                });
            });
            nameIn.addEventListener('input', function () { draft.name = nameIn.value; });
            typeSel.addEventListener('change', function () { draft.type = typeSel.value; drawDraft(); });
            radius.addEventListener('input', function () {
                draft.radius_m = Number(radius.value);
                radiusV.textContent = radius.value >= 1000 ? (radius.value / 1000).toFixed(1).replace(/\.0$/, '') + ' km' : radius.value + ' m';
                drawDraft();
            });
            f.querySelector('.pf-undo').addEventListener('click', function () { draft.polygon.pop(); drawDraft(); });
            f.querySelector('.pf-clear').addEventListener('click', function () { draft.polygon = []; drawDraft(); });
            f.querySelector('.pf-cancel').addEventListener('click', showList);
            var del = f.querySelector('.pf-delete');
            if (del) del.addEventListener('click', function () {
                if (!confirm(daText('Delete "' + pl.name + '"?', 'Slet "' + pl.name + '"?'))) return;
                postPlaces({ action: 'delete', id: pl.id }, !!card.suggestions).then(function (j) { placesChanged(j.card); })
                    .catch(function (e) { toast(e.message); });
            });
            f.querySelector('.pf-save').addEventListener('click', function () {
                var body = { action: draft.id ? 'update' : 'create', id: draft.id || undefined,
                    name: (draft.name || '').trim(), type: draft.type };
                if (!body.name) { toast(daText('Give the place a name.', 'Giv stedet et navn.')); nameIn.focus(); return; }
                if (draft.shape === 'polygon') {
                    if (draft.polygon.length < 3) { toast(daText('A polygon needs at least 3 corners.', 'En polygon skal have mindst 3 hjørner.')); return; }
                    body.polygon = draft.polygon;
                } else {
                    if (draft.lat == null) { toast(daText('Tap the map to place it.', 'Tryk på kortet for at placere det.')); return; }
                    body.lat = draft.lat; body.lon = draft.lon; body.radius_m = draft.radius_m;
                }
                postPlaces(body, !!card.suggestions).then(function (j) { placesChanged(j.card); })
                    .catch(function (e) { toast(e.message); });
            });

            syncShape();
            nameIn.focus();
            if (map) {
                // No animation: the map must not drift under the user's first tap.
                if (draft.shape === 'polygon' && draft.polygon.length) map.fitBounds(L.latLngBounds(draft.polygon), { padding: [30, 30], maxZoom: 17, animate: false });
                else if (draft.lat != null) map.setView([draft.lat, draft.lon], Math.max(map.getZoom(), 16), { animate: false });
            }
        }


        function clearDraftLayer() { if (draftLayer) draftLayer.clearLayers(); }
        function drawDraft() {
            if (!map || !draft || ctx.view !== 'places') return;
            clearDraftLayer();
            Object.keys(placeLayers).forEach(function (id) {
                placeLayers[id].setStyle({ opacity: String(id) === String(draft.id) ? 0 : 0.35, fillOpacity: String(id) === String(draft.id) ? 0 : 0.06 });
            });
            var col = placeColor(draft.type);
            if (draft.shape === 'circle' && draft.lat != null) {
                L.circle([draft.lat, draft.lon], { radius: draft.radius_m, color: col, weight: 3, fillColor: col, fillOpacity: 0.2, dashArray: '6 4' }).addTo(draftLayer);
                L.circleMarker([draft.lat, draft.lon], { radius: 5, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 }).addTo(draftLayer);
            } else if (draft.shape === 'polygon' && draft.polygon.length) {
                (draft.polygon.length >= 3 ? L.polygon(draft.polygon, { color: col, weight: 3, fillColor: col, fillOpacity: 0.2, dashArray: '6 4' })
                    : L.polyline(draft.polygon, { color: col, weight: 3, dashArray: '6 4' })).addTo(draftLayer);
                draft.polygon.forEach(function (v) { L.circleMarker(v, { radius: 5, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 }).addTo(draftLayer); });
            }
        }

        function fitAll() {
            Object.keys(placeLayers).forEach(function (id) { placeLayers[id].setStyle({ opacity: 0.9, fillOpacity: card.focus === Number(id) ? 0.22 : 0.12 }); });
            map.invalidateSize();
            var focusPl = places.filter(function (p) { return p.id === card.focus; })[0];
            if (focusPl) map.fitBounds(placeBounds(L, focusPl), { padding: [40, 40], maxZoom: 17 });
            else if (places.length) {
                var all = placeBounds(L, places[0]);
                places.slice(1).forEach(function (p) { all.extend(placeBounds(L, p)); });
                map.fitBounds(all, { padding: [30, 30], maxZoom: 16 });
            } else if (card.here) map.setView(card.here, 15);
            else map.setView([55.68, 12.57], 11);
        }

        function drawPlaces() {
            if (!ctx.places) return;
            card = ctx.places;
            places = card.places || [];
            clearLayers();
            places.forEach(function (pl) {
                var layer = drawPlace(L, placeLayer, pl, card.focus === pl.id);
                layer.on('click', function (ev) { if (!draft) { L.DomEvent.stopPropagation(ev); edit(pl); } });
                placeLayers[pl.id] = layer;
            });
            (card.suggestions || []).forEach(function (sg, i) {
                var label = sg.suggested_name || (daText('Suggestion ', 'Forslag ') + (i + 1));
                L.circle([sg.lat, sg.lon], { radius: 60, color: '#94a3b8', weight: 2, dashArray: '4 4', fillOpacity: 0.08 })
                    .bindTooltip(label).addTo(placeLayer)
                    .on('click', function (ev) { if (!draft) { L.DomEvent.stopPropagation(ev); edit({ id: null, name: sg.suggested_name || '', type: 'other', shape: 'circle', lat: sg.lat, lon: sg.lon, radius_m: 100, polygon: [] }); } });
            });
            if (card.here) {
                L.circleMarker(card.here, { radius: 6, color: '#fff', weight: 2, fillColor: '#0ea5e9', fillOpacity: 1 })
                    .bindTooltip(daText('Your latest position', 'Din seneste position')).addTo(placeLayer);
            }
            ctx.fit = fitAll;
            fitAll();
            if (draft) drawDraft();
        }

        show(ctx.view);
    }

    // ---- Places (location tracking phase 2): the user's own named places on a map ------------
    var PLACE_TYPES = {
        work:     ['Work', 'Arbejde', '#2563eb'],
        business: ['Business', 'Erhverv', '#ea580c'],
        commute:  ['Commute', 'Pendling', '#7c3aed'],
        home:     ['Home', 'Hjem', '#16a34a'],
        private:  ['Private', 'Privat', '#db2777'],
        other:    ['Other', 'Andet', '#64748b'],
        region:   ['Region', 'Område', '#0891b2']   // an area for routines ("east of Roskilde"): never a destination in the timeline or mileage
    };
    function placeColor(type) { return (PLACE_TYPES[type] || PLACE_TYPES.other)[2]; }
    function placeTypeLabel(type) { var t = PLACE_TYPES[type] || PLACE_TYPES.other; return daText(t[0], t[1]); }

    // Draws one place (circle or polygon) on a Leaflet map; returns the layer.
    function drawPlace(L, map, pl, focused) {
        var style = { color: placeColor(pl.type), weight: focused ? 3 : 2, opacity: 0.9,
            fillColor: placeColor(pl.type), fillOpacity: focused ? 0.22 : 0.12 };
        if (pl.type === 'region') { style.dashArray = '6 6'; style.fillOpacity = focused ? 0.12 : 0.05; }   // an area, not a spot: dashed and faint
        var layer = pl.shape === 'polygon' && (pl.polygon || []).length >= 3
            ? L.polygon(pl.polygon, style)
            : L.circle([pl.lat, pl.lon], Object.assign({ radius: pl.radius_m || 100 }, style));
        layer.bindTooltip(pl.name, { direction: 'center', className: 'place-label', permanent: false });
        return layer.addTo(map);
    }

    // Bounds from the place's own data (a Leaflet circle can't measure itself before the map has a view).
    function placeBounds(L, pl) {
        if (pl.shape === 'polygon' && (pl.polygon || []).length >= 3) return L.latLngBounds(pl.polygon);
        return L.latLng(pl.lat, pl.lon).toBounds((pl.radius_m || 100) * 2);
    }

    function postPlaces(body, withSuggestions) {
        if (withSuggestions) body.suggest = true;
        return fetch('/api/places.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'error'); return j; }); });
    }

    // ---- Work hours card ------------------------------------------------------------------
    // ONE card for hours (it used to be a sessions card plus a separate bar chart): a summary tile with the
    // total as the hero and, above the session lines, one bar per day/week/month — tap a bar and the lines
    // narrow to it. A toggle (Today / Week / 4 wks / 12 wks / Year) re-reads the card in place. Colours come
    // from theme tokens only. Cards stored before this lack some fields and still render: no `bars` → one bar
    // per day is derived from `from`/`to` when the range is known; no `date` → grouped by the day text.
    var WK_WD  = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], da: ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'] };
    var WK_MON = {
        en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        da: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']
    };
    var WK_MODES = [['today', 'Today', 'I dag'], ['week', 'Week', 'Uge'], ['4w', '4 wks', '4 uger'], ['12w', '12 wks', '12 uger'], ['year', 'Year', 'År']];
    var WK_WORDS = { day: ['day', 'days', 'dag', 'dage'], week: ['week', 'weeks', 'uge', 'uger'], month: ['month', 'months', 'måned', 'måneder'] };

    function wkIsoToDate(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    }
    function wkDateToIso(d) {
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    // "Sat 17 Oct" / "lør 17 okt" from an ISO date (falls back to the server's own text).
    function wkDayLabel(iso, fallback) {
        var d = wkIsoToDate(iso);
        if (!d) return fallback || '';
        var l = daText('en', 'da');
        return WK_WD[l][d.getDay()] + ' ' + d.getDate() + ' ' + WK_MON[l][d.getMonth()];
    }
    function wkMinutes(hhmm) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    }
    function wkWord(word, n) {
        var w = WK_WORDS[word] || WK_WORDS.day;
        return n === 1 ? daText(w[0], w[2]) : daText(w[1], w[3]);
    }
    function wkEl(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    // 460 → <span class="wk-n">7</span><span class="wk-unit">h</span><span class="wk-n">40</span><span class="wk-unit">m</span>
    function wkTotalHtml(min, fallback) {
        if (typeof min !== 'number' || isNaN(min)) return progEsc(fallback || '0m');
        var h = Math.floor(min / 60), m = min % 60, out = '';
        if (h > 0) out += '<span class="wk-n">' + h + '</span><span class="wk-unit">h</span>';
        if (m > 0 || h === 0) out += '<span class="wk-n">' + m + '</span><span class="wk-unit">m</span>';
        return out;
    }

    // One bar for a single day: where in the day the sessions sit.
    function wkTimeline(sessions, colorOf) {
        var segs = [];
        sessions.forEach(function (x) {
            var s = wkMinutes(x.in);
            if (s != null) segs.push({ s: s, e: Math.min(1440, s + Math.max(1, x.minutes || 0)), x: x });
        });
        if (!segs.length) return null;
        var lo = Math.min.apply(null, segs.map(function (g) { return g.s; }));
        var hi = Math.max.apply(null, segs.map(function (g) { return g.e; }));
        var start = Math.max(0, Math.floor((lo - 30) / 60) * 60);
        var end = Math.min(1440, Math.ceil((hi + 30) / 60) * 60);
        while (end - start < 480 && !(start === 0 && end === 1440)) {   // never narrower than 8 hours
            if (start > 0) start -= 60;
            if (end - start < 480 && end < 1440) end += 60;
        }
        var span = end - start;

        var box = wkEl('div', 'wk-viz');
        var track = wkEl('div', 'wk-tl');
        segs.forEach(function (g) {
            var seg = wkEl('span', 'wk-seg' + (g.x.ongoing ? ' is-live' : ''));
            seg.style.left = (100 * (g.s - start) / span) + '%';
            seg.style.width = Math.max(1.5, 100 * (g.e - g.s) / span) + '%';
            if (!g.x.ongoing) seg.style.background = colorOf(g.x.place || '');
            seg.title = g.x.in + ' – ' + (g.x.out || daText('now', 'nu')) + (g.x.place ? ' · ' + g.x.place : '') + ' · ' + g.x.duration;
            track.appendChild(seg);
        });
        box.appendChild(track);
        var ticks = wkEl('div', 'wk-ticks');
        var step = Math.ceil(span / 4 / 60) * 60;
        for (var t = start; t <= end; t += step) {
            var lab = wkEl('span', 'wk-tick' + (t === start ? ' first' : '') + (t === end ? ' last' : ''), ((t / 60) % 24 < 10 ? '0' : '') + ((t / 60) % 24) + ':00');
            lab.style.left = (100 * (t - start) / span) + '%';
            ticks.appendChild(lab);
        }
        box.appendChild(ticks);
        return box;
    }

    // The bars the card shows: the server's (one per day / week / month), or — for a card without them whose
    // range is known — one per day worked out from its sessions.
    function wkBars(card, sessions) {
        if (card.bars && card.bars.length > 1) return card.bars;
        var a = wkIsoToDate(card.from), b = wkIsoToDate(card.to);
        if (!a || !b) return [];
        var n = Math.round((b - a) / 86400000) + 1;
        if (n < 2 || n > 62) return [];
        var perDay = {};
        sessions.forEach(function (x) {
            if (!x.date) return;
            var g = perDay[x.date] || (perDay[x.date] = { minutes: 0, ongoing: false });
            g.minutes += x.minutes || 0;
            g.ongoing = g.ongoing || !!x.ongoing;
        });
        var lang = daText('en', 'da'), out = [];
        for (var i = 0; i < n; i++) {
            var d = new Date(a.getFullYear(), a.getMonth(), a.getDate() + i), iso = wkDateToIso(d), g = perDay[iso];
            out.push({
                label: n <= 8 ? WK_WD[lang][d.getDay()] : String(d.getDate()), sub: wkDayLabel(iso, ''), from: iso, to: iso,
                minutes: g ? g.minutes : 0, total: g ? wchFmtMin(g.minutes) : '0m', ongoing: g ? g.ongoing : false
            });
        }
        return out;
    }

    // A readable name for one bar ("Tue 13 Oct", "Week of 12 Oct", "Oct 2026").
    function wkBarTitle(card, b) {
        if (b.from && b.from === b.to) return wkDayLabel(b.from, b.sub || b.label);
        if (card.bucket_word === 'month') return b.label + ' ' + b.sub;
        return daText('Week of ', 'Uge fra ') + (b.from ? wkDayLabel(b.from, b.sub) : b.sub);
    }

    function wkGroupByDay(sessions) {
        var keys = [], groups = {};
        sessions.forEach(function (x) {
            var k = x.date || x.day;
            if (!groups[k]) { groups[k] = { label: wkDayLabel(x.date, x.day), items: [], minutes: 0 }; keys.push(k); }
            groups[k].items.push(x);
            groups[k].minutes += x.minutes || 0;
        });
        return { keys: keys, groups: groups };
    }

    // Lines for a stretch of days the card doesn't carry (a tapped bar of a long range): one small request, cached.
    function wkFetchSessions(card, b) {
        if (card.person) return Promise.reject(new Error('shared card'));   // never ask for OUR hours under someone else's name
        var key = b.from + '|' + b.to;
        card._cache = card._cache || {};
        if (card._cache[key]) return Promise.resolve(card._cache[key]);
        var q = card.query || {};
        return fetch('/api/work-hours.php', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ only: 'sessions', date: b.from, to: b.to, place: q.place || undefined })
        }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            if (!j || !j.sessions) throw new Error('no sessions');
            card._cache[key] = j.sessions;
            return j.sessions;
        });
    }

    // Switch the period (Today / Week / …): the same card, re-read in place.
    function wkSwitchPeriod(wrap, card, key) {
        wrap.classList.add('loading');
        var q = card.query || {};
        fetch('/api/work-hours.php', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ period: key, place: q.place || undefined })
        }).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
            wrap.classList.remove('loading');
            if (res && res.card) {
                buildWorkHours(wrap, res.card);
                // Keep the once-a-minute refresh on the view just switched to.
                if (panelKind === 'work_hours' && cardPanelBody.contains(wrap)) panelCard = res.card;
            } else {
                toast(daText('Could not load that period.', 'Kunne ikke hente den periode.'));
            }
        }).catch(function () {
            wrap.classList.remove('loading');
            toast(daText('Could not load that period.', 'Kunne ikke hente den periode.'));
        });
    }

    function renderWorkHours(card) {
        clearEmptyHint();
        var wrap = wkEl('div', 'plan-card work-card');
        buildWorkHours(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildWorkHours(wrap, card) {
        wrap.innerHTML = '';
        var shared = !!card.person;   // someone else's hours: look only — nothing here may fetch or act on OUR data
        wrap.classList.toggle('no-modes', shared || !card.query);
        var sessions = (card.sessions || []).slice();
        if (sessions.length > 1 && sessions.every(function (x) { return x.date; })) {
            sessions.sort(function (p, q) { return p.date === q.date ? (p.in < q.in ? -1 : p.in > q.in ? 1 : 0) : (p.date < q.date ? -1 : 1); });
        }
        var places = card.places || [];
        var multi = places.length > 1;
        var placeIdx = {};
        places.forEach(function (p, i) { placeIdx[p.place || ''] = i; });
        function colorOf(name) { return multi ? seriesColor(placeIdx.hasOwnProperty(name) ? placeIdx[name] : 5) : 'var(--accent)'; }

        var bars = wkBars(card, sessions);
        var multiDay = bars.length > 1 || (card.from && card.to && card.from !== card.to) || wkGroupByDay(sessions).keys.length > 1;
        // Do the carried sessions cover the whole range? (A long range carries only its latest bar's.)
        var sc = card.sessions_scope;
        var complete = !sc || !card.from || (sc.from <= card.from && sc.to >= card.to);

        // Which bar is selected: null = the whole range. Kept on the card so a refresh doesn't lose it.
        var sel = card._sel;
        if (sel === undefined || (sel !== null && !bars[sel])) {
            sel = null;
            if (bars.length && !complete) {
                for (var i = bars.length - 1; i >= 0; i--) { if (bars[i].minutes > 0) { sel = i; break; } }
            }
        }
        card._sel = sel;

        // ---- header + period toggle ----
        var head = wkEl('div', 'wk-head');
        var title = wkEl('div', 'wk-title');
        setIconText(title, 'clock', card.title || 'Work');
        head.appendChild(title);
        if (card.range && card.range !== card.title) head.appendChild(wkEl('div', 'wk-range', card.range));
        wrap.appendChild(head);

        if (!shared && card.query) {
            var ctl = wkEl('div', 'prog-controls wk-modes');
            var seg = wkEl('div', 'prog-seg');
            WK_MODES.forEach(function (m) {
                var btn = wkEl('button', 'prog-seg-btn' + (m[0] === card.mode ? ' on' : ''), daText(m[1], m[2]));
                btn.type = 'button';
                btn.addEventListener('click', function () { if (m[0] !== card.mode) wkSwitchPeriod(wrap, card, m[0]); });
                seg.appendChild(btn);
            });
            ctl.appendChild(seg);
            wrap.appendChild(ctl);
        }

        // ---- summary tile ----
        var side = wkEl('div', 'work-side');
        var hero = wkEl('div', 'wk-hero');
        var total = wkEl('div', 'work-total');
        total.innerHTML = wkTotalHtml(card.total_minutes, card.total);
        total.setAttribute('aria-label', card.total || '');
        hero.appendChild(total);
        if (card.ongoing) {
            var liveSince = sessions.filter(function (x) { return x.ongoing; })[0];
            var live = wkEl('span', 'work-live');
            live.appendChild(wkEl('i', 'wk-dot'));
            live.appendChild(document.createTextNode(daText('On the clock', 'Stemplet ind') + (liveSince ? ' · ' + daText('since ', 'siden ') + liveSince.in : '')));
            hero.appendChild(live);
        }
        side.appendChild(hero);

        var meta = null;
        if (bars.length > 1) {
            var active = bars.filter(function (b) { return b.minutes > 0; }).length;
            var word = card.bucket_word || 'day';
            var avgMin = active ? Math.round((card.total_minutes || 0) / active) : 0;
            meta = active + ' ' + wkWord(word, active) + ' · ' + daText('avg ', 'gns. ') + (card.avg || wchFmtMin(avgMin)) + ' / ' + wkWord(word, 1)
                + (complete && sessions.length ? ' · ' + sessions.length + ' ' + daText(sessions.length === 1 ? 'session' : 'sessions', sessions.length === 1 ? 'session' : 'sessioner') : '');
        } else if (sessions.length && !multiDay) {
            var lastS = sessions[sessions.length - 1];
            meta = sessions.length + ' ' + daText(sessions.length === 1 ? 'session' : 'sessions', sessions.length === 1 ? 'session' : 'sessioner')
                + ' · ' + sessions[0].in + ' – ' + (lastS.out || daText('now', 'nu'));
        }
        if (meta) side.appendChild(wkEl('div', 'work-stats', meta));

        // Bars (several days) or the day's timeline.
        var barsBox = null, cols = [];
        function paintSel() {
            if (!barsBox) return;
            barsBox.classList.toggle('has-sel', sel !== null);
            cols.forEach(function (c, i) {
                c.classList.toggle('is-sel', i === sel);
                c.setAttribute('aria-pressed', i === sel ? 'true' : 'false');
            });
        }
        if (bars.length > 1) {
            var todayIso = wkDateToIso(new Date());
            var H = 56, max = Math.max.apply(null, bars.map(function (b) { return b.minutes; }).concat([1]));
            var every = bars.length <= 12 ? 1 : Math.ceil(bars.length / 8);
            barsBox = wkEl('div', 'wk-viz');
            var grid = wkEl('div', 'wk-bars' + (bars.length > 16 ? ' dense' : ''));
            bars.forEach(function (b, idx) {
                var col = wkEl('button', 'wk-col' + (b.minutes === 0 ? ' is-empty' : '') + (b.ongoing ? ' is-live' : '')
                    + (b.from && b.from <= todayIso && todayIso <= (b.to || b.from) ? ' is-today' : ''));
                col.type = 'button';
                col.title = wkBarTitle(card, b) + ' · ' + (b.minutes ? wchFmtMin(b.minutes) : '–');
                var bar = wkEl('span', 'wk-bar');
                bar.style.height = (b.minutes > 0 ? Math.max(5, Math.round(H * b.minutes / max)) : 3) + 'px';
                if (card.stacked && b.split) {
                    bar.classList.add('stacked');
                    b.split.forEach(function (m, si) {
                        if (!m) return;
                        var part = wkEl('i', 'wk-bpart');
                        part.style.flex = m + ' 1 0';
                        part.style.background = seriesColor(si);
                        bar.appendChild(part);
                    });
                }
                col.appendChild(bar);
                col.appendChild(wkEl('span', 'wk-lab', (idx % every === 0 || idx === bars.length - 1) ? String(b.label) : ''));
                col.addEventListener('click', function () { choose(idx === sel && complete ? null : idx); });
                cols.push(col);
                grid.appendChild(col);
            });
            barsBox.appendChild(grid);
            side.appendChild(barsBox);
        } else if (sessions.length && !multiDay) {
            var tl = wkTimeline(sessions, colorOf);
            if (tl) side.appendChild(tl);
        }

        // Split per workplace (only when there are several).
        if (multi) {
            var sum = places.reduce(function (s, p) { return s + (p.minutes || 0); }, 0) || 1;
            var br = wkEl('div', 'wk-places');
            var stack = wkEl('div', 'wk-stack');
            var legend = wkEl('ul', 'wk-legend');
            places.forEach(function (p, i) {
                var seg2 = wkEl('span');
                seg2.style.flexGrow = String(Math.max(1, p.minutes || 0));
                seg2.style.background = seriesColor(i);
                seg2.title = (p.place || '—') + ' · ' + p.total;
                stack.appendChild(seg2);
                var li = wkEl('li');
                var sw = wkEl('i', 'wk-sw');
                sw.style.background = seriesColor(i);
                li.appendChild(sw);
                li.appendChild(wkEl('span', 'wk-name', p.place || '—'));
                li.appendChild(wkEl('span', 'wk-pct', Math.round(100 * (p.minutes || 0) / sum) + '%'));
                li.appendChild(wkEl('span', 'wk-val', p.total));
                legend.appendChild(li);
            });
            br.appendChild(stack);
            br.appendChild(legend);
            side.appendChild(br);
        }

        // A forgotten clock-out.
        if ((card.needs_fix || []).length) {
            var f = card.needs_fix[0], more = card.needs_fix.length - 1;
            var warn = wkEl('div', 'wk-alert');
            warn.appendChild(iconEl('triangle-alert', 'ic-lead'));
            var wt = wkEl('div', 'wk-alert-text');
            wt.appendChild(wkEl('b', null, daText('Missing clock-out', 'Mangler stempling ud')));
            wt.appendChild(wkEl('span', null, f.day + (f.place ? ' · ' + f.place : '') + ' · ' + daText('in at ', 'ind kl. ') + f.in
                + (more > 0 ? ' (+' + more + ')' : '') + '. ' + daText("Tell me when you left and I'll fix it.", 'Sig hvornår du gik, så retter jeg det.')));
            warn.appendChild(wt);
            side.appendChild(warn);
        }
        wrap.appendChild(side);

        // ---- the lines: the whole range, or the bar you tapped ----
        var tile = null;
        function inScope(b) { return !sc || (sc.from <= b.from && b.to <= sc.to); }
        function sessionsFor(b) {
            if (inScope(b)) return sessions.filter(function (x) { return !x.date || (x.date >= b.from && x.date <= b.to); });
            var cached = card._cache && card._cache[b.from + '|' + b.to];
            return cached ? cached.slice() : null;   // null = not loaded yet
        }
        function buildTile() {
            var ul = wkEl('ul', 'work-sessions');
            var b = sel !== null ? bars[sel] : null;
            var list = b ? sessionsFor(b) : sessions;

            if (b) {
                var hd = wkEl('li', 'wk-selhead');
                hd.appendChild(wkEl('span', 'wk-selname', wkBarTitle(card, b)));
                hd.appendChild(wkEl('span', 'wk-seltotal', b.minutes ? wchFmtMin(b.minutes) : '–'));
                if (complete) {
                    var clear = wkEl('button', 'wk-selclear');
                    clear.type = 'button';
                    clear.setAttribute('aria-label', daText('Show the whole period', 'Vis hele perioden'));
                    clear.appendChild(iconEl('x', 'ic-lead'));
                    clear.addEventListener('click', function () { choose(null); });
                    hd.appendChild(clear);
                }
                ul.appendChild(hd);
            }
            if (list === null) {
                ul.appendChild(wkEl('li', 'wk-note', daText('Loading…', 'Henter…')));
                wkFetchSessions(card, b).then(function () {
                    if (sel !== null && bars[sel] === b) swapTile();
                }).catch(function () {
                    if (sel !== null && bars[sel] === b) { ul.lastChild.textContent = daText("Couldn't load these.", 'Kunne ikke hente dem.'); }
                });
                return ul;
            }
            if (!list.length) {
                ul.appendChild(wkEl('li', 'wk-note', b ? daText('Nothing logged here.', 'Intet registreret her.') : daText('No time logged yet.', 'Ingen tid registreret endnu.')));
                return ul;
            }
            var g = wkGroupByDay(list);
            var byDay = g.keys.length > 1 || (b && b.from !== b.to);
            g.keys.forEach(function (k) {
                var grp = g.groups[k];
                if (byDay) {
                    var dh = wkEl('li', 'wk-day');
                    dh.appendChild(wkEl('span', null, grp.label));
                    if (grp.items.length > 1) dh.appendChild(wkEl('span', 'wk-day-total', wchFmtMin(grp.minutes)));   // one session: its own row says it
                    ul.appendChild(dh);
                }
                grp.items.forEach(function (x) {
                    var li = wkEl('li', 'wk-sess' + (x.ongoing ? ' is-live' : ''));
                    var when = wkEl('span', 'wk-when');
                    when.appendChild(wkEl('span', 'wk-time', x.in + ' – ' + (x.out || (x.ongoing ? daText('now', 'nu') : '?'))));
                    var where = wkEl('span', 'wk-where' + (x.place ? '' : ' is-none'));
                    if (x.place) {
                        var dot = wkEl('i', 'wk-sw');
                        dot.style.background = colorOf(x.place);
                        where.appendChild(dot);
                        where.appendChild(document.createTextNode(x.place));
                    }
                    when.appendChild(where);
                    li.appendChild(when);
                    li.appendChild(wkEl('span', 'wk-dur', x.duration));
                    ul.appendChild(li);
                });
            });
            return ul;
        }
        function swapTile() {
            var next = buildTile();
            if (tile && tile.parentNode === wrap) wrap.replaceChild(next, tile);
            tile = next;
        }
        function choose(i) {
            sel = i;
            card._sel = i;
            paintSel();
            swapTile();
        }

        tile = buildTile();
        wrap.appendChild(tile);
        paintSel();
    }

    // Pick a weather glyph + animation class from cloud cover, rain, and day/night.
    // Returns { glyph, anim } where anim drives a small CSS animation.
    function wxSymbol(cloudPct, precipMm, isNight) {
        var p = (precipMm == null) ? 0 : precipMm;
        // icon = Lucide name; tone colours it (flat icons instead of emoji).
        if (p >= 2)   return { icon: 'cloud-rain', tone: 'rain', anim: 'rain' };
        if (p >= 0.2) return { icon: isNight ? 'cloud-drizzle' : 'cloud-sun-rain', tone: 'rain', anim: 'rain' };
        if (cloudPct == null) return isNight ? { icon: 'moon', tone: 'night', anim: 'glow' } : { icon: 'sun', tone: 'sun', anim: 'spin' };
        if (cloudPct >= 85) return { icon: 'cloud', tone: 'cloud', anim: 'drift' };
        if (cloudPct >= 45) return isNight ? { icon: 'cloud-moon', tone: 'night', anim: 'drift' } : { icon: 'cloud-sun', tone: 'sun', anim: 'drift' };
        return isNight ? { icon: 'moon', tone: 'night', anim: 'glow' } : { icon: 'sun', tone: 'sun', anim: 'spin' };
    }

    function wxSymbolEl(cloudPct, precipMm, isNight, cls) {
        var s = wxSymbol(cloudPct, precipMm, isNight);
        var el = document.createElement('span');
        el.className = (cls || 'wx-sym') + ' wx-' + s.anim + ' wx-tone-' + s.tone;
        el.innerHTML = icon(s.icon);
        el.setAttribute('aria-hidden', 'true');
        return el;
    }

    function hourOf(str) {
        // "2026-07-10 15:00" or "15:00" -> 15
        var m = String(str).match(/(\d{1,2}):\d{2}\s*$/);
        return m ? parseInt(m[1], 10) : 12;
    }
    function isNightHour(h) { return h < 6 || h >= 21; }
    function fmtTemp(t) { return (t == null) ? '–' : Math.round(t) + '°'; }

    // Weather card: an optional "now" hero, an optional hourly strip, and daily rows.
    function renderWeather(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card weather-card';

        if (card.title) {
            var h = document.createElement('div');
            h.className = 'plan-card-title';
            h.textContent = card.title;
            wrap.appendChild(h);
        }

        // Current conditions hero.
        if (card.current) {
            var c = card.current;
            var night = isNightHour(new Date().getHours());
            var hero = document.createElement('div');
            hero.className = 'wx-now';
            hero.appendChild(wxSymbolEl(null, c.precip_mm, night, 'wx-now-sym'));

            var main = document.createElement('div');
            main.className = 'wx-now-main';
            var temp = document.createElement('div');
            temp.className = 'wx-now-temp';
            temp.textContent = fmtTemp(c.temp_c);
            main.appendChild(temp);

            var bits = [];
            if (c.wind_ms != null) bits.push(icon('wind', 'ic-lead') + Math.round(c.wind_ms) + ' m/s' + (c.wind_from ? ' ' + progEsc(c.wind_from) : ''));
            if (c.humidity_pct != null) bits.push(icon('droplets', 'ic-lead') + Math.round(c.humidity_pct) + '%');
            if (c.precip_mm != null && c.precip_mm > 0) bits.push(icon('cloud-rain', 'ic-lead') + progEsc(c.precip_mm) + ' mm');
            if (bits.length) {
                var stats = document.createElement('div');
                stats.className = 'wx-now-stats';
                stats.innerHTML = bits.map(function (b) { return '<span class="wx-stat">' + b + '</span>'; }).join('');
                main.appendChild(stats);
            }
            hero.appendChild(main);
            wrap.appendChild(hero);
        }

        // Hourly strip (forecast).
        var hourly = card.hourly || [];
        if (hourly.length) {
            var strip = document.createElement('div');
            strip.className = 'wx-hourly';
            hourly.forEach(function (hr) {
                var hh = hourOf(hr.time);
                var cell = document.createElement('div');
                cell.className = 'wx-hour';
                var t = document.createElement('div');
                t.className = 'wx-hour-time';
                t.textContent = (hh < 10 ? '0' + hh : hh) + ':00';
                cell.appendChild(t);
                cell.appendChild(wxSymbolEl(hr.cloud_pct, hr.precip_mm, isNightHour(hh)));
                var tp = document.createElement('div');
                tp.className = 'wx-hour-temp';
                tp.textContent = fmtTemp(hr.temp_c);
                cell.appendChild(tp);
                if (hr.precip_mm != null && hr.precip_mm >= 0.1) {
                    var pr = document.createElement('div');
                    pr.className = 'wx-hour-precip';
                    pr.textContent = hr.precip_mm + 'mm';
                    cell.appendChild(pr);
                }
                strip.appendChild(cell);
            });
            wrap.appendChild(strip);
        }

        // Daily rows (forecast).
        var days = card.days || [];
        if (days.length) {
            var list = document.createElement('div');
            list.className = 'wx-days';
            days.forEach(function (d) {
                var row = document.createElement('div');
                row.className = 'wx-day';

                var name = document.createElement('span');
                name.className = 'wx-day-name';
                name.textContent = (d.weekday || '').slice(0, 3);
                row.appendChild(name);

                row.appendChild(wxSymbolEl(d.cloud_avg_pct, d.precip_mm, false));

                var range = document.createElement('span');
                range.className = 'wx-day-temp';
                range.textContent = fmtTemp(d.temp_min_c) + ' / ' + fmtTemp(d.temp_max_c);
                row.appendChild(range);

                var extra = document.createElement('span');
                extra.className = 'wx-day-extra';
                var ex = [];
                if (d.precip_mm != null && d.precip_mm > 0) ex.push(icon('cloud-rain', 'ic-lead') + progEsc(d.precip_mm) + ' mm');
                if (d.wind_max_ms != null) ex.push(icon('wind', 'ic-lead') + Math.round(d.wind_max_ms));
                extra.innerHTML = ex.map(function (b) { return '<span class="wx-stat">' + b + '</span>'; }).join('');
                row.appendChild(extra);

                list.appendChild(row);
            });
            wrap.appendChild(list);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function toggleCardItem(cb, itemId, endpoint, doneKey) {
        const want = cb.checked;
        const li = cb.closest('li');
        cb.disabled = true;
        const body = { item_id: itemId };
        body[doneKey] = want;
        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
            .then(function (data) {
                cb.disabled = false;
                if (li) li.classList.toggle('done', want);
                if (want && data && data.also_logged && li) {
                    const tag = document.createElement('span');
                    tag.className = 'plan-logged';
                    tag.textContent = 'logged ✓';
                    li.appendChild(tag);
                    setTimeout(function () { tag.remove(); }, 2500);
                }
            })
            .catch(function () {
                cb.disabled = false;
                cb.checked = !want; // revert on failure
            });
    }

    function autogrow() {
        input.style.height = 'auto';
        // scrollHeight is the content + padding; the box also has a border, so add it — otherwise an empty box is 2 px too short and shows a scrollbar
        var border = input.offsetHeight - input.clientHeight;
        var want = input.scrollHeight + border;
        input.style.height = Math.min(want, 140) + 'px';
        input.style.overflowY = want > 140 ? 'auto' : 'hidden';
    }

    // Does this message plausibly need the device's location? (weather, "near me")
    function needsLocation(text) {
        var s = String(text || '');
        return looksLikeWeather(s) || /\bnear(by| me| here)?\b|closest|nearest|around here|where i am|i'?m (at|home|here)|i am (at|home|here)|næmeste|nærmeste|i nærheden|tæt på|jeg er (hjemme|her|på|ved)|hvor jeg er|stedet her/i.test(s);
    }

    // Resolve the device location on demand (cached for the session). Resolves to
    // null if unavailable/denied — the assistant then falls back to named places.
    function getLocation() {
        // Short-lived cache: "I'm at home now" must not reuse a fix from across town.
        if (deviceLocation && Date.now() - deviceLocation.at < 120000) return Promise.resolve(deviceLocation);
        if (!('geolocation' in navigator)) return Promise.resolve(null);
        return new Promise(function (resolve) {
            navigator.geolocation.getCurrentPosition(
                function (pos) {
                    deviceLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy), at: Date.now() };
                    resolve(deviceLocation);
                },
                function () { resolve(null); },
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 }
            );
        });
    }

    // Flip the Send button into a red "Stop" that aborts the in-flight request,
    // or back to normal Send when idle.
    var ICON_SEND = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 20V6M6 12l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';
    function setSendStopMode(on) {
        if (on) {
            sendBtn.innerHTML = ICON_STOP;
            sendBtn.classList.add('stopping');
            sendBtn.setAttribute('aria-label', 'Stop');
            sendBtn.title = 'Stop the assistant';
        } else {
            sendBtn.innerHTML = ICON_SEND;
            sendBtn.classList.remove('stopping');
            sendBtn.setAttribute('aria-label', 'Send');
            sendBtn.title = 'Send';
        }
    }

    // ---------- Quick-reply chips (from the assistant's [[suggest: …]] marker) ----------
    var suggestionsEl = null;
    function clearSuggestions() {
        if (suggestionsEl) { suggestionsEl.remove(); suggestionsEl = null; }
    }
    function renderSuggestions(list) {
        clearSuggestions();
        suggestionsEl = document.createElement('div');
        suggestionsEl.className = 'suggestions';
        list.forEach(function (text) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip suggestion-chip';
            b.textContent = text;
            b.addEventListener('click', function () { send(text); });
            suggestionsEl.appendChild(b);
        });
        messages.appendChild(suggestionsEl);
        messages.scrollTop = messages.scrollHeight;
    }

    async function send(text) {
        if (busy || !text.trim()) return;
        busy = true;
        resumeConversation = null;          // committing to this fresh chat; drop the resume offer
        clearSuggestions();                 // any pending quick-reply chips are now moot
        // Keep the button enabled but turn it into a Stop control.
        sendController = new AbortController();
        setSendStopMode(true);
        const wasNewConversation = !conversationId;
        const userRow = addMessage(text, 'user');

        const typing = addMessage('…', 'assistant');
        typing.classList.add('typing');
        // Flap the wings only while thinking — swap the still frame for the GIF.
        const typingAvatar = typing.querySelector('.avatar');
        if (typingAvatar) typingAvatar.src = AVATAR_FLYING;

        // Only fetch/attach location when the message actually calls for it.
        const location = needsLocation(text) ? await getLocation() : null;

        // Live "what I'm doing" steps in the typing bubble while the turn runs.
        const turnId = newTurnId();
        const stopProgress = startToolProgress(typing, turnId);

        try {
            const res = await fetch('/api/chat.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    message: text,
                    conversation_id: conversationId || undefined,
                    location: location || undefined,
                    turn_id: turnId,
                    // First reply in a chat opened from a notification: the server stores the
                    // notification as the opening assistant turn, so the model has the context.
                    notice: pendingNotice ? pendingNotice.text : undefined,
                    view: currentOpenView() || undefined,
                }),
                signal: sendController ? sendController.signal : undefined,
            });
            stopProgress();

            if (res.status === 401) {
                window.location.href = '/index.php';
                return;
            }

            const data = await res.json().catch(() => ({}));
            typing.remove();

            if (!res.ok) {
                // Full server detail goes to the console; the bubble stays friendly.
                if (data.debug) console.error('[Kachow] chat.php:', data.debug);
                addMessage(data.error || 'Something went wrong.', 'error');
                return;
            }

            pendingNotice = null;   // saved with this message (or irrelevant): never sent twice
            lastActivityAt = Date.now();
            if (data.conversation_id) {
                conversationId = data.conversation_id;
                localStorage.setItem(CONV_KEY, String(conversationId));
            }
            const replyRow = addMessage(data.reply || '(no reply)', 'assistant', data.reply_html);
            attachMessageMeta(replyRow, { id: data.assistant_message_id, diagnostics: data.diagnostics });
            attachMessageMeta(userRow, { id: data.user_message_id });
            if (data.card) { applyAppearanceFromCard(data.card); presentCard(data.card, data.card_mode); }
            if (data.suggestions && data.suggestions.length) renderSuggestions(data.suggestions);

            // For a brand-new conversation, generate its history title in the
            // background (fire-and-forget, so it never slows the reply).
            if (wasNewConversation && conversationId) {
                fetch('/api/conversations.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ action: 'generate_title', id: conversationId }),
                }).catch(function () { /* non-fatal */ });
            }
        } catch (err) {
            stopProgress();
            typing.remove();
            if (err && err.name === 'AbortError') {
                // User hit Stop — acknowledge quietly, no error styling.
                addMessage('Stopped.', 'assistant');
            } else {
                addMessage('Network error. Please try again.', 'error');
            }
        } finally {
            busy = false;
            sendController = null;
            setSendStopMode(false);
            input.focus();
        }
    }

    form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        // While a reply is in flight the button is a Stop control — abort instead.
        if (busy) {
            if (sendController) sendController.abort();
            return;
        }
        const text = input.value;
        input.value = '';
        autogrow();
        send(text);
    });

    input.addEventListener('input', function () {
        autogrow();
    });
    input.addEventListener('keydown', function (ev) {
        // Enter sends; Shift+Enter makes a newline.
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            form.requestSubmit();
        }
    });

    newChatBtn.addEventListener('click', function () {
        conversationId = null;
        localStorage.removeItem(CONV_KEY);
        messages.innerHTML = '';
        hidePanel();
        showEmptyHint();
        input.focus();
    });

    // Load a past conversation's messages into the view and make it the active one.
    // Note: old interactive cards aren't restored — only the text of each turn.
    // A scheduled task's run, as opened from its notification. The task's stored instruction is not
    // something the user typed, so it shows as a quiet note (instruction tucked behind a tap) rather
    // than a "You" bubble; the notification itself shows as the notification it was.
    function addScheduledNote(instruction, label, atLocal) {
        clearEmptyHint();
        var when = atLocal ? new Date(String(atLocal).replace(' ', 'T')) : null;
        var note = document.createElement('details');
        note.className = 'sched-note';
        var sum = document.createElement('summary');
        setIconText(sum, 'alarm-clock', daText('Scheduled task', 'Planlagt opgave')
            + (label ? ' · ' + label : '')
            + (when && !isNaN(when.getTime()) ? ' · ' + emailDate(when.toISOString()) : ''));
        note.appendChild(sum);
        var body = document.createElement('div');
        body.className = 'sched-note-text';
        body.textContent = instruction;
        note.appendChild(body);
        messages.appendChild(note);
        return note;
    }

    function addNotificationBubble(text, atLocal) {
        clearEmptyHint();
        var parts = String(text).split('\n');
        var title = parts.shift() || '';
        var bubble = document.createElement('div');
        bubble.className = 'msg notification';
        var h = document.createElement('div');
        h.className = 'notif-title';
        setIconText(h, 'bell', title);
        bubble.appendChild(h);
        if (parts.length) {
            var b = document.createElement('div');
            b.className = 'notif-body';
            appendLinkified(b, parts.join('\n'));
            bubble.appendChild(b);
        }
        var when = atLocal ? new Date(String(atLocal).replace(' ', 'T')) : null;
        if (when && !isNaN(when.getTime())) bubble.title = emailDate(when.toISOString());
        messages.appendChild(bubble);
        return bubble;
    }

    function loadConversation(id, gen) {
        return fetch('/api/conversations.php?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('load failed')); })
            .then(function (data) {
                // A notification opened meanwhile (startup restore only): leave its view alone.
                if (gen !== undefined && gen !== navGen) return data;
                pendingNotice = null;
                messages.innerHTML = '';
                hidePanel();
                // Cards live in the panel now (the "current view"), not inline in the
                // transcript — so restore just the most recent one for this chat.
                var lastCard = null;
                (data.messages || []).forEach(function (m) {
                    if (m.role === 'scheduled') {
                        addScheduledNote(m.content, (data.scheduled && data.scheduled.label) || '', m.at);
                    } else if (m.role === 'notification') {
                        addNotificationBubble(m.content, m.at);
                    } else if (m.role === 'assistant') {
                        var row = addMessage(m.content, 'assistant', m.html, m.at);
                        attachMessageMeta(row, { id: m.id, diagnostics: m.diagnostics });
                        if (m.card) lastCard = m.card;
                    } else {
                        var urow = addMessage(m.content, 'user', null, m.at);
                        attachMessageMeta(urow, { id: m.id });
                    }
                });
                if (lastCard) presentCard(lastCard);
                conversationId = id;
                lastActivityAt = Date.now();
                localStorage.setItem(CONV_KEY, String(id));
                if (!messages.children.length) showEmptyHint();
                messages.scrollTop = messages.scrollHeight;
                return data;
            });
    }

    fetchQuickActions();

    // Deep link from a tapped push notification: open a FRESH chat showing the card
    // that matches the notification (e.g. ?card=cycle). Takes priority over restoring
    // the last conversation.
    var _params = new URLSearchParams(window.location.search);
    var cardParam = _params.get('card');
    // A scheduled task's own notification deep-links straight to its conversation
    // (?conv=<id>, set by notify_me) rather than a card — so the user sees exactly what
    // that run did/found, not just a generic card.
    var convParam = _params.get('conv');
    // A home-screen shortcut (?open=<card key>, see Shortcuts in the cards picker / the manifest): lands on that card.
    var openParam = _params.get('open');
    // A tapped notification wins over restoring the last conversation. The service worker
    // parks the tap (with the notification's own text) in CacheStorage, because iOS often
    // drops its postMessage to a suspended or discarded page — so check that first.
    takePendingOpen().then(function (p) {
        var gen = navGen;
        if (p) startFromNotification(p);
        else if (convParam) loadConversation(Number(convParam), gen).catch(function () { if (gen === navGen) decideStartupChat(); });
        else if (cardParam) openNotificationCard(cardParam, _params.get('rid'), null);
        else if (openParam && HOME_CARDS[openParam]) openShortcutCard(openParam);
        else decideStartupChat();
    });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        takePendingOpen().then(function (p) { if (p) handlePendingOpen(p); });
    });

    // Cold start from a tapped notification: first bring back the chat you were in if it is
    // still warm (the same rule as a normal start), so the notification lands inside it
    // instead of replacing it; a notification for a specific conversation just opens that.
    function startFromNotification(p) {
        var toConv = /[?&]conv=\d/.test(String(p.url || ''));
        if (toConv) { handlePendingOpen(p); return; }
        fetch('/api/conversations.php?recent=1', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                showUnseenTaskAlert(data && data.unseen_tasks);
                var recent = data && data.recent ? data.recent : null;
                if (recent && recent.age_seconds <= IDLE_RESUME_SECONDS) {
                    return loadConversation(recent.id).then(function () {
                        lastActivityAt = Date.now() - recent.age_seconds * 1000;
                    });
                }
                resumeConversation = (recent && recent.id) ? recent : null;
            })
            .catch(function () { /* start without the old chat */ })
            .then(function () { handlePendingOpen(p); });
    }

    // A scheduled task found something (notify_me fired, see bin/scheduled-tasks-cron.php)
    // but the push may have been missed (dismissed, phone off, notifications denied) — show
    // a persistent banner above the chat until its conversation is actually opened, which
    // clears it server-side. tasks is api/conversations.php?recent=1's unseen_tasks.
    function showUnseenTaskAlert(tasks) {
        var el = document.getElementById('taskAlert');
        if (!el) return;
        if (!tasks || !tasks.length) { el.hidden = true; return; }
        var first = tasks[0];
        var extra = tasks.length > 1 ? ' (+' + (tasks.length - 1) + ' more)' : '';
        var open = function () {
            el.hidden = true;
            loadConversation(first.conversation_id).catch(function () { /* non-fatal */ });
        };
        setIconText(el, 'bell', (first.last_result_title || first.label) + extra + ' — tap to view');
        el.onclick = open;
        el.onkeydown = function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        };
        el.hidden = false;
    }

    // Resume the last conversation only if it's still "warm" (server says its last
    // message was <1h ago) — a quick refresh lands you back where you were. After a
    // longer gap, start a fresh chat but offer a "pick up where you left off" pill.
    // The idle age is measured server-side, so it's robust across devices/clock skew.
    function decideStartupChat() {
        // If a notification opens while this is still loading, it wins: every step below
        // checks the generation and stands down instead of overwriting the notification view.
        var gen = navGen;
        fetch('/api/conversations.php?recent=1', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (gen !== navGen) return;
                showUnseenTaskAlert(data && data.unseen_tasks);
                var recent = data && data.recent ? data.recent : null;
                if (recent && recent.age_seconds <= IDLE_RESUME_SECONDS) {
                    loadConversation(recent.id, gen).catch(function () { if (gen === navGen) startFreshChat(recent); });
                } else {
                    startFreshChat(recent);   // idle gap (or no history) → fresh screen
                }
            })
            .catch(function () {
                if (gen !== navGen) return;
                // Endpoint/network failure → fall back to the old restore behavior.
                if (conversationId) {
                    loadConversation(conversationId, gen).catch(function () { if (gen === navGen) startFreshChat(null); });
                } else {
                    startFreshChat(null);
                }
            });
    }

    // ---- Live voice (the mic button): the dock + Gemini Live live in assets/voice.js, loaded on first use ----
    (function initLiveVoice() {
        var btn = document.getElementById('mic');
        if (!btn) return;
        // Needs the mic, an AudioContext with worklets, and WebSocket; otherwise the button stays hidden.
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket
            && (window.AudioContext || window.webkitAudioContext))) return;
        btn.hidden = false;
        var loading = null;
        function load() {
            if (window.KachowVoice) return Promise.resolve(window.KachowVoice);
            if (!loading) loading = new Promise(function (resolve, reject) {
                var sc = document.createElement('script');
                sc.src = '/assets/voice.js?v=' + Date.now();
                sc.onload = function () { resolve(window.KachowVoice); };
                sc.onerror = function () { loading = null; reject(new Error('Could not load voice.')); };
                document.head.appendChild(sc);
            });
            return loading;
        }
        var hooks = {
            // the voice session has its own conversation: show it empty and let the spoken turns fill it
            begin: function (id) {
                clearSuggestions();
                messages.innerHTML = '';
                hidePanel();
                conversationId = id;
                localStorage.setItem(CONV_KEY, String(id));
                lastActivityAt = Date.now();
                btn.classList.add('listening');
            },
            end: function () { lastActivityAt = Date.now(); btn.classList.remove('listening'); },
            addMessage: function (text, role) { addMessage(text, role); },
            presentCard: function (card, mode) { if (card) { applyAppearanceFromCard(card); presentCard(card, mode || 'open'); } }
        };
        btn.addEventListener('click', function () {
            load().then(function (v) { return v.isActive() ? v.stop() : v.start(hooks); }).catch(function (e) { toast(e.message || 'Voice failed.'); });
        });
    })();

    var skipStartCard = false;      // a shortcut opens its own card, so the first start card must not
    function startFreshChat(recent) {
        conversationId = null;
        localStorage.removeItem(CONV_KEY);
        resumeConversation = (recent && recent.id) ? recent : null;
        messages.innerHTML = '';
        showEmptyHint();
        // The start screen shows the user's first start card (desktop: in the card column; phone: folded under its header,
        // one tap to unfold) — unless a notification or another card got there first.
        var gen = navGen;
        if (homeCardsReady) homeCardsReady.then(function (list) {
            if (!list.length || gen !== navGen || panelCard || skipStartCard) return;
            var desktop = window.matchMedia && window.matchMedia('(min-width: 1024px)').matches;
            if (desktop) openHomeCard(list[0], 'open');   // on a phone the start cards are tiles on the start screen instead
        });
    }

    // A home-screen shortcut: a fresh chat with the chosen card open on top. The query is dropped so a refresh does not repeat it.
    function openShortcutCard(key) {
        navGen++;
        try { window.history.replaceState({}, '', window.location.pathname); } catch (e) { /* ignore */ }
        skipStartCard = true;
        startFreshChat(null);
        skipStartCard = false;
        openHomeCard(key);
    }

    // Short contextual line shown in the fresh chat when a notification card opens, so
    // it isn't just a card over an empty conversation. Language auto-picks from the
    // device (Danish for da-*, English otherwise).
    var CARD_INTRO = {
        routines:   { en: 'A routine is asking before it runs 🔔',    da: 'En rutine spørger før den kører 🔔' },
        work_week:  { en: "Here's your work summary for last week 📊", da: 'Her er din arbejdsoversigt for sidste uge 📊' },
        work_hours: { en: "Here are today's hours 🕒",                 da: 'Her er dagens timer 🕒' },
        work_log:   { en: "Here's your work log for this week 📝",     da: 'Her er din arbejdslog for denne uge 📝' },
        cycle:      { en: "Here's your cycle status 🌙",               da: 'Her er din cyklusstatus 🌙' },
        moms:        { en: "Here's the moms to file for the quarter 🧾", da: 'Her er momsen at angive for kvartalet 🧾' },
        reminder:   { en: "Here's your reminder ⏰",                   da: 'Her er din påmindelse ⏰' }
    };
    function cardIntro(key) {
        var m = CARD_INTRO[key];
        if (!m) return null;
        return (navigator.language || '').toLowerCase().indexOf('da') === 0 ? m.da : m.en;
    }

    // Quick replies offered under a notification, per type — each is a complete sentence,
    // so it reads naturally as the user's answer (the notification text is in the chat too).
    var NOTIF_REPLIES = {
        checkout_nudge: { en: ['Clock me out now', 'I left earlier — I\'ll tell you when'], da: ['Stempl mig ud nu', 'Jeg gik tidligere — jeg siger hvornår'] },
        reminder:       { en: ['Done ✓', 'Remind me again in 1 hour'],                    da: ['Klaret ✓', 'Mind mig om det igen om 1 time'] },
        cycle_upcoming: { en: ['My period started today', 'Not yet'],                        da: ['Min menstruation startede i dag', 'Ikke endnu'] },
        work_log_nudge: { en: ['Nothing to log today'],                                       da: ['Intet at logge i dag'] },
        wfh_prompt:     { en: ['Yes, I\'m working from home today', 'Not working today'],    da: ['Ja, jeg arbejder hjemmefra i dag', 'Jeg arbejder ikke i dag'] },
        tracking_silent: { en: ['Check my tracking setup', 'Show me today on the map'],          da: ['Tjek min sporing', 'Vis mig i dag på kortet'] }
    };
    function notifReplies(type) {
        var m = NOTIF_REPLIES[type];
        if (!m) return null;
        return (navigator.language || '').toLowerCase().indexOf('da') === 0 ? m.da : m.en;
    }

    // Generation counter: bumped when a notification opens, so a slower startup restore
    // (decideStartupChat → loadConversation) never overwrites the notification view.
    var navGen = 0;
    // The notification a fresh chat was opened from — sent with the first message so the
    // server stores it as the assistant's opening turn (the model then knows the context).
    var pendingNotice = null;
    // When this chat last had activity (loaded, sent, answered) — decides whether a tapped
    // notification joins it or starts a fresh chat.
    var lastActivityAt = 0;
    var lastPendingAt = 0;

    // Read + clear the tap the service worker parked in CacheStorage (null if none / stale).
    function takePendingOpen() {
        if (!window.caches) return Promise.resolve(null);
        return caches.open('kachow-pending').then(function (c) {
            return c.match('/__pending-open').then(function (r) {
                if (!r) return null;
                return r.json().then(function (p) {
                    c.delete('/__pending-open');
                    return p && p.at && Date.now() - p.at < 10 * 60 * 1000 ? p : null;
                });
            });
        }).catch(function () { return null; });
    }

    // One tapped notification → the matching view. The SW both posts it and parks it, so
    // the same tap can arrive twice: handle each tap once.
    function handlePendingOpen(p) {
        if (!p || (p.at && p.at === lastPendingAt)) return;
        lastPendingAt = p.at || 0;
        if (window.caches) caches.open('kachow-pending').then(function (c) { c.delete('/__pending-open'); }).catch(function () {});
        refreshInboxCount();
        landNotification(p);
    }

    // Where a notification lands (a tap on the push, or on its entry in the bell list):
    //  • its own conversation, already open  → stay in it; never reload or wipe it;
    //  • its own conversation, another one   → open that, with the notification at the bottom;
    //  • a card/plain notification, and a chat that is still warm (<1h, same rule as the app
    //    start) → show it INSIDE that chat, so what you were doing is not thrown away;
    //  • otherwise (no chat / gone cold)     → a fresh chat that opens with it.
    // A notification already shown in this chat is not added again — re-tapping it just
    // scrolls to it (and re-opens its card).
    function landNotification(p) {
        var u;
        try { u = new URL(p.url || '/', location.origin); } catch (e) { u = new URL('/', location.origin); }
        var convId = Number(u.searchParams.get('conv')) || 0;
        var key = u.searchParams.get('card'), rid = u.searchParams.get('rid');
        try { window.history.replaceState({}, '', window.location.pathname); } catch (e) { /* ignore */ }

        if (convId && convId === conversationId) {
            showNoticeBubble(p, false);
            return;
        }
        if (convId) {
            navGen++;
            var gen = navGen;
            loadConversation(convId).then(function () {
                if (gen === navGen) showNoticeBubble(p, false);
            }).catch(function () {
                if (gen === navGen) openNotificationCard(null, null, p);
            });
            return;
        }
        if (conversationIsWarm()) {
            landInOpenConversation(key, rid, p);
            return;
        }
        openNotificationCard(key, rid, p);
    }

    // A chat is warm while it has content and was last used within IDLE_RESUME_SECONDS.
    function conversationIsWarm() {
        return !!(conversationId && messages.querySelector('.msg') && Date.now() - lastActivityAt < IDLE_RESUME_SECONDS * 1000);
    }

    // The notification as a bubble at the bottom of the open chat. Returns true when it was
    // added, false when this chat already showed it. `store` also queues it to be saved with
    // the next message (so the model knows what a reply like "Done" refers to).
    function showNoticeBubble(note, store) {
        var title = (note && note.title) || '', body = (note && note.body) || '';
        if (!title && !body) { messages.scrollTop = messages.scrollHeight; return false; }
        var k = title + '\n' + body, shown = null;
        messages.querySelectorAll('.msg.notification').forEach(function (b) {
            var t = b.querySelector('.notif-title');
            if (b.dataset.key === k || (t && t.textContent.trim() === title.trim())) shown = b;
        });
        if (shown) {
            shown.scrollIntoView({ block: 'end', behavior: 'smooth' });
            return false;
        }
        var bubble = addNotificationBubble(body ? title + '\n' + body : title);
        bubble.dataset.key = k;
        messages.scrollTop = messages.scrollHeight;
        if (store) {
            var text = [title, body].filter(Boolean).join(' — ');
            pendingNotice = { text: pendingNotice ? pendingNotice.text + '\n' + text : text, type: note.type || '' };
        }
        return true;
    }

    function landInOpenConversation(key, rid, note) {
        navGen++;
        var gen = navGen;
        var added = showNoticeBubble(note, true);
        var replies = notifReplies(note && note.type);
        if (replies && added) renderSuggestions(replies);
        if (!key) return;
        var url = '/api/card.php?for=' + encodeURIComponent(key);
        if (rid) url += '&rid=' + encodeURIComponent(rid);
        fetch(url, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('load failed')); })
            .then(function (data) {
                if (gen !== navGen) return;
                if (data && data.card) presentCard(data.card, 'open');
            })
            .catch(function () { /* the notification text is already in the chat */ });
    }

    function openNotificationCard(key, rid, note) {
        navGen++;
        // Start clean: no active conversation, empty transcript.
        conversationId = null;
        localStorage.removeItem(CONV_KEY);
        resumeConversation = null;
        clearSuggestions();
        messages.innerHTML = '';
        hidePanel();
        // Drop the query params so a refresh doesn't re-trigger it.
        try { window.history.replaceState({}, '', window.location.pathname); } catch (e) { /* ignore */ }

        // Lead with what the notification actually said (not a generic line), so the chat
        // picks up exactly where the push left off; fall back to the card's stock intro.
        var noticeText = note && (note.title || note.body)
            ? [note.title, note.body].filter(Boolean).join(' — ') : null;
        if (noticeText) {
            var nb = addNotificationBubble(note.body ? (note.title || '') + '\n' + note.body : (note.title || note.body));
            nb.dataset.key = (note.title || '') + '\n' + (note.body || '');
            pendingNotice = { text: noticeText, type: note.type || '' };
        } else {
            pendingNotice = null;
        }
        var replies = notifReplies(note && note.type);
        var gen = navGen;

        if (!key) {                                   // a notification without a card
            if (!noticeText) showEmptyHint();
            if (replies) renderSuggestions(replies);
            return;
        }
        var url = '/api/card.php?for=' + encodeURIComponent(key);
        if (rid) url += '&rid=' + encodeURIComponent(rid);
        fetch(url, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('load failed')); })
            .then(function (data) {
                if (gen !== navGen) return;
                if (data && data.card) {
                    if (!noticeText) {
                        var intro = cardIntro(key);
                        if (intro) addMessage(intro, 'assistant');
                    }
                    presentCard(data.card, 'open');
                } else if (!noticeText) {
                    showEmptyHint();
                }
                if (replies) renderSuggestions(replies);
            })
            .catch(function () {
                if (gen !== navGen) return;
                if (!noticeText) showEmptyHint();
                if (replies) renderSuggestions(replies);
            });
    }

    // Location is requested lazily (only when a message actually needs it — see
    // getLocation/needsLocation), not eagerly on load, so we don't prompt or send
    // coordinates unless it matters.

    if ('serviceWorker' in navigator) {
        // When a new service worker (a new deploy) takes control, reload once so the
        // page runs the fresh assets. Crucial for the installed PWA, which can stay
        // open for days. Only for pages that were already controlled (returning
        // users), so a first-time visitor doesn't get a spurious reload.
        // But never under the user's fingers: launching the PWA right after a deploy swaps the
        // worker 1–2 s in, and an immediate reload wiped whatever was being typed (dev report).
        // So the reload waits until the composer is empty, unfocused and no reply is in flight
        // (or the app goes to the background), and a draft is carried across it regardless.
        var hadController = !!navigator.serviceWorker.controller;
        var refreshing = false;
        var reloadPending = false;
        var DRAFT_KEY = 'kachow-draft-across-reload';
        function safeToReload() {
            return !busy && input.value.trim() === '' && document.activeElement !== input;
        }
        function reloadNow() {
            if (refreshing) return;
            refreshing = true;
            try { if (input.value) sessionStorage.setItem(DRAFT_KEY, input.value); } catch (e) { /* private mode */ }
            window.location.reload();
        }
        function maybeReload() {
            if (reloadPending && (safeToReload() || document.visibilityState === 'hidden')) reloadNow();
        }
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (refreshing || !hadController) return;
            reloadPending = true;
            maybeReload();
        });
        input.addEventListener('blur', function () { setTimeout(maybeReload, 300); });
        document.addEventListener('visibilitychange', maybeReload);
        setInterval(maybeReload, 5000);   // e.g. right after a reply finishes
        try {
            var carried = sessionStorage.getItem(DRAFT_KEY);
            if (carried) {
                sessionStorage.removeItem(DRAFT_KEY);
                if (!input.value) { input.value = carried; autogrow(); }
            }
        } catch (e) { /* private mode */ }

        // A tapped notification on an already-open app: the SW hands us the deep-link
        // URL (since iOS won't navigate it), and we open the matching card in a fresh chat.
        navigator.serviceWorker.addEventListener('message', function (e) {
            var d = e.data || {};
            if (d.type !== 'kachow-open' || !d.url) return;
            handlePendingOpen({ url: d.url, type: d.ntype || '', title: d.title, body: d.body, at: d.at });
        });

        window.addEventListener('load', function () {
            // Registered via sw.php so the worker carries a per-deploy version stamp
            // (its bytes change each deploy → the browser picks up the new version).
            navigator.serviceWorker.register('/sw.php').then(function (reg) {
                // Check for a new version when the app regains focus — covers a PWA
                // that was backgrounded/suspended rather than fully relaunched.
                var lastCheck = Date.now();
                document.addEventListener('visibilitychange', function () {
                    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 60000) {
                        lastCheck = Date.now();
                        reg.update().catch(function () { /* offline / non-fatal */ });
                    }
                });
            }).catch(function () { /* non-fatal */ });
        });
    }

    // ---------- Push notifications ----------
    (function initNotifications() {
        var btn = document.getElementById('notifBtn');
        var modal = document.getElementById('notifModal');
        var body = document.getElementById('notifBody');
        var closeBtn = document.getElementById('notifClose');
        if (!btn || !modal || !body) return;

        var pushSupported = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
        var config = null; // { supported, public_key, types }

        // iOS only allows push for the installed Home-Screen app.
        function isStandalone() {
            return window.navigator.standalone === true ||
                (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
        }
        function isiOS() { return /iP(hone|ad|od)/.test(navigator.userAgent); }

        btn.hidden = false;
        btn.addEventListener('click', openModal);
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

        function openModal() { modal.hidden = false; render(); loadConfig(); }
        function closeModal() { modal.hidden = true; }

        function urlBase64ToUint8Array(base64String) {
            var padding = '='.repeat((4 - base64String.length % 4) % 4);
            var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            var raw = atob(base64);
            var arr = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            return arr;
        }

        function api(payload) {
            return fetch('/api/push.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(payload),
            }).then(function (r) { return r.json(); });
        }

        function loadConfig() {
            fetch('/api/push.php', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) { config = data; render(); })
                .catch(function () { /* leave placeholder */ });
        }

        function currentSubscription() {
            if (!pushSupported) return Promise.resolve(null);
            return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); });
        }

        function subscribe() {
            return navigator.serviceWorker.ready.then(function (reg) {
                return reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(config.public_key),
                });
            }).then(function (sub) {
                return api({ action: 'subscribe', subscription: sub.toJSON() });
            });
        }

        function unsubscribe() {
            return currentSubscription().then(function (sub) {
                if (!sub) return;
                var endpoint = sub.endpoint;
                return sub.unsubscribe().then(function () { return api({ action: 'unsubscribe', endpoint: endpoint }); });
            });
        }

        function render() {
            body.innerHTML = '';

            if (!pushSupported) {
                body.appendChild(note('This browser doesn\'t support notifications.'));
                return;
            }
            if (isiOS() && !isStandalone()) {
                body.appendChild(note('To get notifications on iPhone, add Kachow to your Home Screen (Share → Add to Home Screen), then open it from there.'));
                return;
            }
            if (config && config.supported === false) {
                body.appendChild(note('Notifications aren\'t configured on the server yet.'));
                return;
            }
            if (!config) {
                body.appendChild(note('Loading…'));
                return;
            }

            // Master enable row (reflects the actual browser subscription).
            var masterRow = row('Notifications on this device', 'Turn on to receive pushes here.');
            var masterSwitch = toggle(false, function (on) {
                masterSwitch.checkbox.disabled = true;
                (on ? requestAndSubscribe() : unsubscribe())
                    .catch(function () {})
                    .then(function () { masterSwitch.checkbox.disabled = false; refreshMaster(); });
            });
            masterRow.appendChild(masterSwitch);
            body.appendChild(masterRow);

            var typesWrap = document.createElement('div');
            typesWrap.id = 'notifTypes';
            body.appendChild(typesWrap);

            var testBtn = document.createElement('button');
            testBtn.className = 'notif-test';
            testBtn.type = 'button';
            testBtn.textContent = 'Send a test notification';
            testBtn.addEventListener('click', function () {
                testBtn.disabled = true;
                testBtn.textContent = 'Sending…';
                api({ action: 'test' }).then(function (r) {
                    testBtn.textContent = r && r.sent ? 'Sent ✓' : 'No device subscribed yet';
                    setTimeout(function () { testBtn.disabled = false; testBtn.textContent = 'Send a test notification'; }, 2500);
                }).catch(function () { testBtn.disabled = false; testBtn.textContent = 'Send a test notification'; });
            });
            body.appendChild(testBtn);

            // Deep-linked test: a push that should open the work-week card on tap. Lets us
            // verify the notification → card path on demand (no waiting for a real nudge).
            var testCardBtn = document.createElement('button');
            testCardBtn.className = 'notif-test';
            testCardBtn.type = 'button';
            testCardBtn.textContent = 'Send a test card notification';
            testCardBtn.addEventListener('click', function () {
                testCardBtn.disabled = true;
                testCardBtn.textContent = 'Sending…';
                api({ action: 'test_card' }).then(function (r) {
                    testCardBtn.textContent = r && r.sent ? 'Sent ✓ — background the app, then tap it' : 'No device subscribed yet';
                    setTimeout(function () { testCardBtn.disabled = false; testCardBtn.textContent = 'Send a test card notification'; }, 4000);
                }).catch(function () { testCardBtn.disabled = false; testCardBtn.textContent = 'Send a test card notification'; });
            });
            body.appendChild(testCardBtn);

            function refreshMaster() {
                currentSubscription().then(function (sub) {
                    masterSwitch.checkbox.checked = !!sub;
                    testBtn.disabled = !sub;
                    testCardBtn.disabled = !sub;
                });
            }
            function renderTypes() {
                typesWrap.innerHTML = '';
                (config.types || []).forEach(function (t) {
                    var r = row(t.label, t.description);
                    var sw = toggle(t.enabled, function (on) {
                        sw.checkbox.disabled = true;
                        api({ action: 'set_pref', type: t.key, enabled: on })
                            .catch(function () { sw.checkbox.checked = !on; })
                            .then(function () { sw.checkbox.disabled = false; });
                    });
                    r.appendChild(sw);
                    typesWrap.appendChild(r);
                });
            }
            refreshMaster();
            renderTypes();
        }

        function requestAndSubscribe() {
            // iOS requires the permission request to come from this user gesture.
            return Notification.requestPermission().then(function (perm) {
                if (perm !== 'granted') throw new Error('denied');
                return subscribe();
            });
        }

        function note(text) {
            var d = document.createElement('div');
            d.className = 'notif-note';
            d.textContent = text;
            return d;
        }
        function row(title, sub) {
            var r = document.createElement('div');
            r.className = 'notif-row';
            var txt = document.createElement('div');
            txt.className = 'notif-row-text';
            var h = document.createElement('div'); h.className = 'notif-row-title'; h.textContent = title;
            var s = document.createElement('div'); s.className = 'notif-row-sub'; s.textContent = sub;
            txt.appendChild(h); txt.appendChild(s);
            r.appendChild(txt);
            return r;
        }
        // Returns the <label class="switch"> element; access the input via `.checkbox`.
        function toggle(checked, onChange) {
            var label = document.createElement('label');
            label.className = 'switch';
            var input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!checked;
            input.addEventListener('change', function () { onChange(input.checked); });
            var slider = document.createElement('span');
            slider.className = 'slider';
            label.appendChild(input);
            label.appendChild(slider);
            label.checkbox = input;
            return label;
        }
    })();

    // ---------- Cards button (phones / tablets): a sheet with every card, your own first, then the ones opened this session ----------
    (function initCardSheet() {
        var btn = document.getElementById('cardsBtn');
        var composer = document.getElementById('composer');
        if (!btn || !composer) return;
        var sheet = document.createElement('div');
        sheet.className = 'card-sheet';
        sheet.id = 'cardSheet';
        sheet.hidden = true;
        document.body.appendChild(sheet);

        function head(text) {
            var h = document.createElement('div');
            h.className = 'cs-head';
            h.textContent = text;
            sheet.appendChild(h);
        }
        function tile(grid, iconName, label, open, mine, isOpen) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'cs-tile' + (mine ? ' is-mine' : '') + (isOpen ? ' is-open' : '');
            b.innerHTML = icon(iconName);
            var t = document.createElement('span');
            t.textContent = label;
            b.appendChild(t);
            b.addEventListener('click', function () { close(); open(); });
            grid.appendChild(b);
        }
        function fill() {
            sheet.innerHTML = '';
            var mine = homeCards.length ? homeCards.slice() : [];
            var rest = HOME_CARD_ORDER.filter(function (k) { return mine.indexOf(k) === -1; });
            var grid = document.createElement('div');
            grid.className = 'cs-grid';
            if (mine.length) {
                head(daText('Your cards', 'Dine kort'));
                mine.forEach(function (k) { var c = HOME_CARDS[k]; tile(grid, c.icon, daText(c.en, c.da), function () { openHomeCard(k); }, true, railKind(panelKind) === c.kind); });
                sheet.appendChild(grid);
                grid = document.createElement('div');
                grid.className = 'cs-grid';
                head(daText('All cards', 'Alle kort'));
            }
            rest.forEach(function (k) { var c = HOME_CARDS[k]; tile(grid, c.icon, daText(c.en, c.da), function () { openHomeCard(k); }, false, railKind(panelKind) === c.kind); });
            RAIL_STAPLES.forEach(function (s) {                 // the default staples that are not in HOME_CARDS (Appearance …)
                if (HOME_CARD_ORDER.some(function (k) { return HOME_CARDS[k].kind === s.kind; })) return;
                tile(grid, s.icon, s.label, s.open, false, railKind(panelKind) === s.kind);
            });
            sheet.appendChild(grid);
            if (railRecents.length) {
                head(daText('Opened this session', 'Åbnet i denne session'));
                var g2 = document.createElement('div');
                g2.className = 'cs-grid';
                railRecents.forEach(function (r) { tile(g2, r.icon, r.label, function () { presentCard(r.card); }, false, railKind(panelKind) === r.kind); });
                sheet.appendChild(g2);
            }
        }
        function place() {
            var top = composer.getBoundingClientRect().top;
            sheet.style.bottom = Math.max(8, Math.round(window.innerHeight - top + 8)) + 'px';
        }
        function open() { fill(); place(); sheet.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
        function close() { sheet.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); if (sheet.hidden) open(); else close(); });
        document.addEventListener('click', function (ev) { if (!sheet.hidden && !sheet.contains(ev.target) && ev.target !== btn && !btn.contains(ev.target)) close(); });
        document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !sheet.hidden) close(); });
        window.addEventListener('resize', function () { if (!sheet.hidden) place(); });
    })();

    // ---------- Composer overflow menu (＋ → New chat / Add receipt) ----------
    (function initComposerMenu() {
        var menu = document.getElementById('composerMenu');
        if (!menu) return;
        // The items keep their own handlers (New chat / receipt); just collapse after.
        menu.querySelectorAll('.composer-menu-item').forEach(function (b) {
            b.addEventListener('click', function () { menu.removeAttribute('open'); });
        });
        // Close when tapping anywhere outside the menu.
        document.addEventListener('click', function (ev) {
            if (menu.open && !menu.contains(ev.target)) menu.removeAttribute('open');
        });
    })();

    // ---------- Top-bar overflow menu (☰) ----------
    (function initTopbarMenu() {
        var menu = document.getElementById('topbarMenu');
        if (!menu) return;
        document.addEventListener('click', function (ev) {
            if (menu.open && !menu.contains(ev.target)) menu.removeAttribute('open');
        });
        // Opening Notifications hands off to its modal, so collapse the menu.
        var notif = document.getElementById('notifBtn');
        if (notif) notif.addEventListener('click', function () { menu.removeAttribute('open'); });
        // Appearance → show the theme picker card.
        var appBtn = document.getElementById('appearanceBtn');
        if (appBtn) appBtn.addEventListener('click', function () {
            menu.removeAttribute('open');
            openAppearanceCard();
        });
    })();

    // ---------- Theme: sync chrome colour on load, reconcile with server ----------
    (function initTheme() {
        // The inline <head> script already set data-theme from localStorage (no flash);
        // re-apply so the browser theme-colour meta matches too.
        applyTheme(themeChoice(), false);
        // Pull the account's saved choice and looks (set on another device) and apply if anything differs.
        fetch('/api/settings.php', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var v = j && j.values;
                if (!v) return;
                var changed = false;
                if (v.theme_dark && v.theme_dark !== lsGet(THEME_DARK_KEY)) { lsSet(THEME_DARK_KEY, v.theme_dark); changed = true; }
                if (v.theme_light && v.theme_light !== lsGet(THEME_LIGHT_KEY)) { lsSet(THEME_LIGHT_KEY, v.theme_light); changed = true; }
                if (v.theme && v.theme !== lsGet(THEME_KEY)) changed = true;
                if (changed) applyTheme(v.theme || themeChoice(), false);
            })
            .catch(function () { /* offline / not logged in — keep the local theme */ });
    })();

    // ---------- Start cards picker (☰ → Start cards) ----------
    (function initHomeCardsPicker() {
        var btn = document.getElementById('homeCardsBtn');
        var modal = document.getElementById('homeCardsModal');
        var list = document.getElementById('homeCardsList');
        if (!btn || !modal || !list) return;

        var state = { chosen: [] };
        function render() { fillHomeCardsList(list, state, render); }
        function openModal() {
            var menu = document.getElementById('topbarMenu');
            if (menu) menu.removeAttribute('open');
            (homeCardsReady || Promise.resolve(homeCards)).then(function () {
                state.chosen = homeCards.slice();
                render();
                modal.hidden = false;
            });
        }
        function closeModal() { modal.hidden = true; }
        function saveValue(value) {
            saveHomeCards(value, function (ok, msg) {
                toast(msg);
                if (ok) closeModal();
            });
        }
        btn.addEventListener('click', openModal);
        document.getElementById('homeCardsClose').addEventListener('click', closeModal);
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
        document.getElementById('homeCardsSave').addEventListener('click', function () { saveValue(state.chosen.join(',')); });
        document.getElementById('homeCardsReset').addEventListener('click', function () { saveValue(''); });
    })();

    // ---------- Receipt photo upload ----------
    (function initReceiptUpload() {
        var btn = document.getElementById('receiptBtn');
        var fileInput = document.getElementById('receiptInput');
        if (!btn || !fileInput) return;
        btn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            fileInput.value = ''; // allow re-picking the same file
            if (file) uploadReceipt(file);
        });
    })();

    // ---------- General photo upload (read & act) ----------
    (function initPhotoUpload() {
        var btn = document.getElementById('photoBtn');
        var fileInput = document.getElementById('photoInput');
        if (!btn || !fileInput) return;
        btn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            fileInput.value = ''; // allow re-picking the same file
            if (!file) return;
            // Whatever the user typed in the composer rides along as a caption/instruction.
            var caption = (input.value || '').trim();
            input.value = '';
            autogrow();
            uploadPhoto(file, caption);
        });
    })();

    // ---------- Invoice upload → income draft (image or PDF) ----------
    function uploadInvoice(file) {
        clearEmptyHint();
        addMessage(daText('Invoice', 'Faktura') + ' (PDF/photo)', 'user');
        var typing = addMessage(daText('Reading the invoice…', 'Læser fakturaen…'), 'assistant');
        typing.classList.add('typing');
        var av = typing.querySelector('.avatar');
        if (av) av.src = AVATAR_FLYING;

        var fd = new FormData();
        fd.append('invoice', file);
        fetch('/api/income-upload.php', { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                typing.remove();
                if (!res.ok || !res.j || res.j.error) {
                    addMessage((res.j && res.j.error) || daText('Could not read that invoice.', 'Kunne ikke læse fakturaen.'), 'error');
                    return;
                }
                addMessage(daText("Here's what I read — check and confirm:", 'Her er hvad jeg læste — tjek og bekræft:'), 'assistant');
                if (res.j.card) presentCard(res.j.card);
            })
            .catch(function () { typing.remove(); addMessage(daText('Network error uploading the invoice.', 'Netværksfejl ved upload af fakturaen.'), 'error'); });
    }

    (function initInvoiceUpload() {
        var btn = document.getElementById('invoiceBtn');
        var fileInput = document.getElementById('invoiceInput');
        if (!btn || !fileInput) return;
        btn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            fileInput.value = ''; // allow re-picking the same file
            if (file) uploadInvoice(file);
        });
    })();

    // ---------- Connect a mailbox over IMAP (app password) ----------
    (function initImapConnect() {
        var modal = document.getElementById('imapModal');
        if (!modal) return;
        var closeBtn = document.getElementById('imapClose');
        var title = document.getElementById('imapTitle');
        var hint = document.getElementById('imapHint');
        var email = document.getElementById('imapEmail');
        var password = document.getElementById('imapPassword');
        var host = document.getElementById('imapHost');
        var port = document.getElementById('imapPort');
        var ssl = document.getElementById('imapSsl');
        var errorBox = document.getElementById('imapError');
        var connectBtn = document.getElementById('imapConnect');

        var PRESETS = {
            outlook: {
                title: 'Connect Hotmail / Outlook',
                hint: 'Enter your full Hotmail/Outlook address and an app password (Microsoft account → Security → app passwords). Two-step verification must be on.',
                host: 'outlook.office365.com', port: 993, ssl: true,
            },
            custom: {
                title: 'Connect a mailbox (IMAP)',
                hint: 'Enter your mailbox\'s IMAP server, your address, and its password (or an app password).',
                host: '', port: 993, ssl: true,
            },
        };

        document.querySelectorAll('[data-imap-preset]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var d = btn.closest('details');
                if (d) d.removeAttribute('open');   // close the email menu popover
                open(btn.getAttribute('data-imap-preset'));
            });
        });
        if (closeBtn) closeBtn.addEventListener('click', close);
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        if (connectBtn) connectBtn.addEventListener('click', submit);

        function open(presetKey) {
            var p = PRESETS[presetKey] || PRESETS.custom;
            title.textContent = p.title;
            hint.textContent = p.hint;
            host.value = p.host;
            port.value = p.port;
            ssl.checked = p.ssl;
            password.value = '';
            hideError();
            modal.hidden = false;
            setTimeout(function () { email.focus(); }, 30);
        }
        function close() { modal.hidden = true; }
        function hideError() { errorBox.hidden = true; errorBox.textContent = ''; }
        function showError(msg) { errorBox.hidden = false; errorBox.textContent = msg; }

        function submit() {
            hideError();
            var body = {
                email: (email.value || '').trim(),
                password: password.value || '',
                host: (host.value || '').trim(),
                port: parseInt(port.value, 10) || 993,
                ssl: !!ssl.checked,
            };
            if (!body.email || !body.password || !body.host) {
                showError('Email, app password and server are all required.');
                return;
            }
            connectBtn.disabled = true;
            connectBtn.textContent = 'Connecting…';
            fetch('/api/email-imap-connect.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            })
                .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
                .then(function (r) {
                    if (r.ok && r.d && r.d.ok) {
                        // Reload so the topbar badge + connected list refresh.
                        window.location.href = '/index.php?email=connected';
                        return;
                    }
                    showError((r.d && r.d.error) || 'Could not connect that mailbox.');
                    connectBtn.disabled = false;
                    connectBtn.textContent = 'Connect';
                })
                .catch(function () {
                    showError('Network error. Please try again.');
                    connectBtn.disabled = false;
                    connectBtn.textContent = 'Connect';
                });
        }
    })();

    // ---------- Disconnect a mailbox (the × next to it in the menu) ----------
    document.querySelectorAll('[data-email-disconnect]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            var email = btn.getAttribute('data-email') || 'this mailbox';
            if (!window.confirm(daText('Disconnect ' + email + '? Kachow will no longer read or send from it.', 'Frakobl ' + email + '? Kachow læser og sender ikke længere fra den.'))) return;
            btn.disabled = true;
            fetch('/api/email-disconnect.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ id: Number(btn.getAttribute('data-email-disconnect')) })
            })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (r) {
                    if (r.ok && r.j && r.j.ok) {
                        var row = btn.closest('.tm-acc');
                        if (row) row.remove();
                        toast(daText('Disconnected.', 'Frakoblet.'));
                    } else {
                        btn.disabled = false;
                        toast((r.j && r.j.error) || daText('Could not disconnect.', 'Kunne ikke frakoble.'));
                    }
                })
                .catch(function () { btn.disabled = false; toast(daText('Network error.', 'Netværksfejl.')); });
        });
    });

    // ---------- Notification history (the bell) ----------
    // Every push the app sends is kept server-side (api/notifications.php), so one that was missed or
    // dismissed can still be read and opened. Tapping an entry opens what the push opens; the badge
    // counts the unread ones.
    var refreshInboxCount = function () {};
    (function initInbox() {
        var btn = document.getElementById('inboxBtn');
        var badge = document.getElementById('inboxCount');
        var modal = document.getElementById('inboxModal');
        var list = document.getElementById('inboxList');
        var closeBtn = document.getElementById('inboxClose');
        var readAll = document.getElementById('inboxReadAll');
        var settings = document.getElementById('inboxSettings');
        if (!btn || !modal || !list) return;

        var TYPE_ICONS = {
            checkout_nudge: 'clock', weekly_summary: 'chart-column', work_log_nudge: 'notebook-pen',
            cycle_upcoming: 'moon', moms_deadline: 'percent', reminder: 'alarm-clock', wfh_prompt: 'clock',
            tracking_silent: 'map-pin', scheduled_task: 'sparkles', work_clock_gap: 'clock', feedback_report: 'flag', important_email: 'mail', routine_ask: 'sparkles', test: 'bell'
        };
        var oldest = null;     // smallest id shown, for "Show older"

        function setBadge(n) {
            if (!badge) return;
            badge.hidden = !n;
            badge.textContent = n > 99 ? '99+' : String(n || '');
            btn.classList.toggle('has-unread', n > 0);
            btn.setAttribute('aria-label', daText('Notification history', 'Notifikationshistorik') + (n ? ' (' + n + ' ' + daText('unread', 'ulæste') + ')' : ''));
            if (readAll) readAll.hidden = !n;
        }

        refreshInboxCount = function () {
            fetch('/api/notifications.php?count=1', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) { if (j && typeof j.unread === 'number') setBadge(j.unread); })
                .catch(function () { /* offline / not logged in */ });
        };

        function ago(atLocal) {
            var d = new Date(String(atLocal).replace(' ', 'T'));
            if (isNaN(d.getTime())) return '';
            var min = Math.round((Date.now() - d.getTime()) / 60000);
            if (min < 1) return daText('just now', 'lige nu');
            if (min < 60) return min + ' ' + daText('min ago', 'min siden');
            if (min < 24 * 60 && d.toDateString() === new Date().toDateString()) return Math.round(min / 60) + ' ' + daText('h ago', 't siden');
            return emailDate(d.toISOString());
        }

        function open() { modal.hidden = false; load(null); }
        function close() { modal.hidden = true; }

        function failed() {
            list.innerHTML = '<div class="history-empty">' + daText("Couldn't load.", 'Kunne ikke hente.') + '</div>';
        }

        function load(before) {
            if (!before) { list.innerHTML = '<div class="history-empty">' + daText('Loading…', 'Henter…') + '</div>'; oldest = null; }
            fetch('/api/notifications.php' + (before ? '?before=' + before : ''), { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    if (!j || !j.items) { failed(); return; }
                    setBadge(j.unread || 0);
                    if (!before) list.innerHTML = '';
                    var more = list.querySelector('.inbox-more');
                    if (more) more.remove();
                    if (!j.items.length && !before) {
                        list.innerHTML = '<div class="history-empty">' + daText('No notifications yet. Anything the app sends you will be listed here.',
                            'Ingen notifikationer endnu. Alt hvad appen sender dig står her.') + '</div>';
                        return;
                    }
                    j.items.forEach(function (it) { list.appendChild(row(it)); oldest = it.id; });
                    if (j.items.length >= 50) {
                        var m = document.createElement('button');
                        m.type = 'button'; m.className = 'inbox-more';
                        m.textContent = daText('Show older', 'Vis ældre');
                        m.addEventListener('click', function () { load(oldest); });
                        list.appendChild(m);
                    }
                })
                .catch(failed);
        }

        function row(it) {
            var el = document.createElement('div');
            el.className = 'history-item inbox-item' + (it.read ? '' : ' unread');
            el.tabIndex = 0;
            el.setAttribute('role', 'button');
            var ic = document.createElement('span');
            ic.className = 'inbox-ic';
            ic.innerHTML = icon(TYPE_ICONS[it.type] || 'bell');
            var main = document.createElement('div');
            main.className = 'history-main';
            var t = document.createElement('div');
            t.className = 'history-title';
            t.textContent = it.title;
            var b = document.createElement('div');
            b.className = 'inbox-body';
            b.textContent = it.body;
            var sub = document.createElement('div');
            sub.className = 'history-sub';
            sub.textContent = [it.label, ago(it.at)].filter(Boolean).join(' · ');
            main.appendChild(t); main.appendChild(b); main.appendChild(sub);
            el.appendChild(ic); el.appendChild(main);
            var go = function () { openEntry(it, el); };
            el.addEventListener('click', go);
            el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
            return el;
        }

        function openEntry(it, el) {
            if (!it.read) {
                it.read = true;
                el.classList.remove('unread');
                fetch('/api/notifications.php', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                    body: JSON.stringify({ action: 'read', id: it.id })
                }).then(function () { refreshInboxCount(); }).catch(function () { /* non-fatal */ });
            }
            close();
            landNotification({ url: it.url, type: it.type || '', title: it.title, body: it.body });
        }

        btn.addEventListener('click', open);
        if (closeBtn) closeBtn.addEventListener('click', close);
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        if (readAll) readAll.addEventListener('click', function () {
            fetch('/api/notifications.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ action: 'read_all' })
            }).then(function () {
                list.querySelectorAll('.inbox-item.unread').forEach(function (e) { e.classList.remove('unread'); });
                setBadge(0);
            }).catch(function () { /* non-fatal */ });
        });
        if (settings) settings.addEventListener('click', function () {
            close();
            var nb = document.getElementById('notifBtn');
            if (nb) nb.click();
        });

        refreshInboxCount();
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshInboxCount(); });
        setInterval(function () { if (document.visibilityState === 'visible') refreshInboxCount(); }, 60000);
    })();

    // ---------- Chat history ----------
    (function initHistory() {
        var btn = document.getElementById('historyBtn');
        var modal = document.getElementById('historyModal');
        var closeBtn = document.getElementById('historyClose');
        var search = document.getElementById('historySearch');
        var list = document.getElementById('historyList');
        if (!btn || !modal || !list) return;

        var searchTimer = null;

        btn.addEventListener('click', open);
        if (closeBtn) closeBtn.addEventListener('click', close);
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        if (search) {
            search.addEventListener('input', function () {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(function () { load(search.value.trim()); }, 250);
            });
        }

        function open() { modal.hidden = false; if (search) search.value = ''; load(''); }
        function close() { modal.hidden = true; }

        function load(q) {
            list.innerHTML = '<div class="history-empty">Loading…</div>';
            var url = '/api/conversations.php' + (q ? '?q=' + encodeURIComponent(q) : '');
            fetch(url, { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) { render(data.conversations || [], q); })
                .catch(function () { list.innerHTML = '<div class="history-empty">Couldn\'t load history.</div>'; });
        }

        function render(items, q) {
            list.innerHTML = '';
            if (!items.length) {
                list.innerHTML = '<div class="history-empty">' + (q ? 'No matches.' : 'No conversations yet.') + '</div>';
                return;
            }
            var lazyBudget = 3; // AI-title a few untitled chats per open (background)
            items.forEach(function (c) {
                var rowEl = document.createElement('div');
                rowEl.className = 'history-item' + (c.id === conversationId ? ' current' : '');

                var main = document.createElement('div');
                main.className = 'history-main';
                var title = document.createElement('div');
                title.className = 'history-title';
                title.textContent = c.title || c.preview || 'Conversation';
                var sub = document.createElement('div');
                sub.className = 'history-sub';
                var bits = [];
                if (c.title && c.preview) bits.push(c.preview);
                bits.push((c.count || 0) + (c.count === 1 ? ' msg' : ' msgs'));
                if (c.when) bits.push(c.when);
                sub.textContent = bits.join(' · ');
                main.appendChild(title);
                main.appendChild(sub);

                var exp = exportButton('Export conversation');
                exp.addEventListener('click', function (e) {
                    e.stopPropagation();
                    downloadUrl('/api/chat-export.php?id=' + encodeURIComponent(c.id));
                });

                var del = deleteButton('Delete conversation');
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (!window.confirm('Delete this conversation?')) return;
                    removeConversation(c.id, rowEl);
                });

                rowEl.appendChild(main);
                rowEl.appendChild(exp);
                rowEl.appendChild(del);
                rowEl.addEventListener('click', function () {
                    loadConversation(c.id).then(close).catch(function () {});
                });
                list.appendChild(rowEl);

                // Older untitled chats: generate a title in the background, update in place.
                if (!c.title && lazyBudget > 0) {
                    lazyBudget--;
                    generateTitle(c.id, title, sub, c.preview);
                }
            });
        }

        function generateTitle(id, titleEl, subEl, preview) {
            fetch('/api/conversations.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'generate_title', id: id }),
            }).then(function (r) { return r.json(); }).then(function (res) {
                if (!res || !res.title) return;
                titleEl.textContent = res.title;
                if (preview) subEl.textContent = preview + (subEl.textContent ? ' · ' + subEl.textContent : '');
            }).catch(function () { /* non-fatal */ });
        }

        function removeConversation(id, rowEl) {
            fetch('/api/conversations.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'delete', id: id }),
            }).then(function (r) { return r.json(); }).then(function (res) {
                if (!res || !res.ok) return;
                rowEl.remove();
                if (id === conversationId) {
                    conversationId = null;
                    localStorage.removeItem(CONV_KEY);
                    messages.innerHTML = '';
                    showEmptyHint();
                }
                if (!list.children.length) {
                    list.innerHTML = '<div class="history-empty">No conversations yet.</div>';
                }
            }).catch(function () { /* non-fatal */ });
        }
    })();
})();
