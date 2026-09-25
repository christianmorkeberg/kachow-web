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
    // Hands-free voice mode: once on, the mic stays armed across turns until the
    // user manually switches back to text (by typing) or taps the mic off.
    let voiceMode = false;
    let quickActions = null;   // cached suggestions for the empty-screen chips
    let resumeConversation = null;      // {id,title} offered as a "pick up where you left off" pill
    const IDLE_RESUME_SECONDS = 3600;   // only auto-resume the last chat if <1h since its last message
    let deviceLocation = null; // {lat, lon} from the browser, for weather etc.

    function showEmptyHint() {
        if (messages.children.length) return;
        const wrap = document.createElement('div');
        wrap.className = 'empty';
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.textContent = 'Ask about your shopping list, workouts, or calendar.';
        wrap.appendChild(hint);
        const chips = document.createElement('div');
        chips.className = 'chips';
        wrap.appendChild(chips);
        messages.appendChild(wrap);
        renderChips(chips);
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

    function addMessage(text, role, html) {
        clearEmptyHint();

        const bubble = document.createElement('div');
        bubble.className = 'msg ' + role;
        if (role === 'assistant' && typeof html === 'string' && html) {
            // Server-rendered, HTML-escaped markdown (see Support\Markdown).
            bubble.innerHTML = html;
        } else {
            bubble.textContent = text;
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
        [/chart/,                               'chart-column',  'a chart',            'en graf']
    ];
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
        remember_about_me:    ['Remembering that', 'Husker det']
    };
    function toolInfo(name) {
        name = String(name || '');
        var dom = null;
        for (var i = 0; i < TOOL_DOMAINS.length; i++) {
            if (TOOL_DOMAINS[i][0].test(name)) { dom = TOOL_DOMAINS[i]; break; }
        }
        var iconName = dom ? dom[1] : 'sparkles';
        if (TOOL_SPECIAL[name]) return { icon: iconName, text: daText(TOOL_SPECIAL[name][0], TOOL_SPECIAL[name][1]) };
        var obj = dom ? daText(dom[2], dom[3]) : daText('something', 'noget');
        var verb = /^(get|list|read|search|export)_/.test(name) ? ['Looking up', 'Slår op i']
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
            if (!steps.length) return;
            // Redraw only on change, and fade in only NEW steps (a full redraw per poll
            // would restart the animation and leave every line half-transparent).
            var key = JSON.stringify([st.phase, steps]);
            if (key === lastKey) return;
            lastKey = key;
            row.classList.add('has-tools');
            var first = Math.max(0, steps.length - 5), prevShown = shown;
            shown = steps.length;
            box.innerHTML = steps.slice(first).map(function (x, i) {
                var info = toolInfo(x.tool);
                var mark = x.status === 'running' ? icon('loader-circle', 'tl-spin')
                    : x.status === 'error' ? icon('circle-x', 'tl-err') : icon('check', 'tl-ok');
                var fresh = (first + i) >= prevShown ? ' tl-new' : '';
                return '<div class="tl-step tl-' + progEsc(x.status) + fresh + '">' + icon(info.icon, 'tl-ic')
                    + '<span class="tl-text">' + progEsc(info.text) + '</span>' + mark + '</div>';
            }).join('') + (st.phase === 'answering'
                ? '<div class="tl-step tl-running">' + icon('sparkles', 'tl-ic') + '<span class="tl-text">'
                    + progEsc(daText('Putting the answer together', 'Samler svaret')) + '</span>' + icon('loader-circle', 'tl-spin') + '</div>'
                : '');
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

        // Desktop convenience; the visible ⚑ button is the primary path on touch (a
        // long-press would fight native text selection, so we don't use it).
        bubble.addEventListener('contextmenu', function (e) { e.preventDefault(); openReportDialog(msgId); });
    }

    function buildDiagPanel(d) {
        var wrap = document.createElement('details');
        wrap.className = 'msg-diag';
        var sum = document.createElement('summary');
        sum.textContent = 'diagnostics';
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

    // kind → [icon, title]. Icon names come from assets/icons.js (Lucide).
    var CARD_TITLES = {
        shopping_list: ['shopping-cart', 'Shopping list'],
        workout_plan:  ['dumbbell', 'Workout plan'],
        agenda:        ['calendar', 'Agenda'],
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
        income_summary:['trending-up', 'Income'],
        owner_draws:   ['wallet', 'Owner draws'],
        bookkeeping:   ['book-open', 'Books'],
        moms:          ['percent', 'Moms'],
        cash:          ['landmark', 'Cash'],
        pl:            ['trending-up', 'P&L'],
        mileage:       ['car', 'Mileage'],
        email_list:    ['inbox', 'Inbox'],
        email:         ['mail', 'Email'],
        email_draft:   ['pencil-line', 'Draft'],
        feedback:      ['wrench', 'Feedback'],
        personality:   ['drama', 'Personality'],
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
    // and with UserSettings::THEMES on the server.
    var THEMES = [
        { id: 'aurora',   label: 'Aurora',   bg: '#0f172a', panel: '#16233f', accent: '#38bdf8', text: '#e6edf7', radius: 14 },
        { id: 'noir',     label: 'Noir',     bg: '#141414', panel: '#242424', accent: '#e0a24e', text: '#eaeaea', radius: 10 },
        { id: 'paper',    label: 'Paper',    bg: '#f5f5f4', panel: '#ffffff', accent: '#2563eb', text: '#1c1c1c', radius: 10 },
        { id: 'lavender', label: 'Lavender', bg: '#f3f0fb', panel: '#faf8ff', accent: '#8b5cf6', text: '#2e2545', radius: 16 },
        { id: 'blush',    label: 'Blush',    bg: '#fdf2f6', panel: '#fffafc', accent: '#ec4899', text: '#3d2233', radius: 18 },
        { id: 'disco',    label: 'Disco',    bg: '#0d0221', panel: '#2a0e52', accent: '#ff2d95', text: '#ffe9ff', radius: 20 }
    ];
    var THEME_KEY = 'kachow-theme';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme')
            || (function () { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } })()
            || 'aurora';
    }

    // Apply a theme everywhere: set the CSS attribute, cache it (instant on next load),
    // sync the browser chrome colour, and (when save) persist server-side for other devices.
    function applyTheme(id, save) {
        var t = THEMES.filter(function (x) { return x.id === id; })[0] || THEMES[0];
        document.documentElement.setAttribute('data-theme', t.id);
        try { localStorage.setItem(THEME_KEY, t.id); } catch (e) { /* private mode */ }
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', t.bg);
        if (save) {
            fetch('/api/settings.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ key: 'theme', value: t.id })
            }).catch(function () { /* non-fatal — localStorage already holds it */ });
        }
    }

    function openAppearanceCard() {
        presentCard({ kind: 'appearance', theme: currentTheme() });
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
        if (card.kind === 'personality' && card.level) {
            return daText('Level ', 'Niveau ') + card.level + '/5';
        }
        if (card.kind === 'appearance') {
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
        if (card.kind === 'shopping_list' && Array.isArray(card.items)) {
            var openN = card.items.filter(function (i) { return !i.done; }).length;   // hidden checked don't count
            return openN + (openN === 1 ? ' item' : ' items');
        }
        if (typeof card.remaining === 'number') return card.remaining + ' left';
        if (Array.isArray(card.items)) return card.items.length + (card.items.length === 1 ? ' item' : ' items');
        return '';
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
        var orig = messages.appendChild;
        messages.appendChild = function (node) { return cardPanelBody.appendChild(node); };
        try {
            renderCard(card);
        } finally {
            messages.appendChild = orig;   // restore the real method no matter what
        }

        panelKind = card.kind;
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
    }

    (function wireCardPanel() {
        if (!cardPanel) return;
        var head   = document.getElementById('cardPanelHead');
        var close  = document.getElementById('cardPanelClose');
        var tgl    = document.getElementById('cardPanelToggle');
        var expand = document.getElementById('cardPanelExpand');
        var workspace = document.getElementById('workspace');
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
        if (head)   head.addEventListener('click', toggleMin);
        if (tgl)    tgl.addEventListener('click', toggleMin);
        if (expand) expand.addEventListener('click', toggleExpand);
        if (close)  close.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
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
    var RAIL_STAPLE_KINDS = RAIL_STAPLES.map(function (s) { return s.kind; });
    var railRecents = [];

    function railInfo(card) {
        return { icon: cardIconFor(card), label: (CARD_TITLES[card.kind] || [])[1] || card.title || card.kind };
    }

    function openBooksFresh() {
        fetch('/api/books.php?granularity=quarter&offset=0', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) presentCard(j.card); })
            .catch(function () {});
    }

    function openMomsFresh() {
        fetch('/api/moms.php?offset=0', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) presentCard(j.card); })
            .catch(function () {});
    }

    function openCashFresh() {
        fetch('/api/cash.php', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) presentCard(j.card); })
            .catch(function () {});
    }

    function openPlFresh() {
        fetch('/api/pl.php?granularity=year&offset=0', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) presentCard(j.card); })
            .catch(function () {});
    }

    function openMileageFresh() {
        fetch('/api/mileage.php?offset=0', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.card) presentCard(j.card); })
            .catch(function () {});
    }

    function recordRailCard(card) {
        if (!card || !card.kind) return;
        if (RAIL_STAPLE_KINDS.indexOf(card.kind) !== -1) return;   // staples are pinned, not recents
        railRecents = railRecents.filter(function (r) { return r.kind !== card.kind; });  // dedupe by kind
        var info = railInfo(card);
        railRecents.unshift({ kind: card.kind, icon: info.icon, label: info.label, card: card });
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
        RAIL_STAPLES.forEach(function (s) {
            rail.appendChild(railBtn(s.icon, s.label, panelKind === s.kind, s.open));
        });
        if (railRecents.length) {
            var sep = document.createElement('div'); sep.className = 'rail-sep'; rail.appendChild(sep);
            railRecents.forEach(function (r) {
                rail.appendChild(railBtn(r.icon, r.label, panelKind === r.kind, function () { presentCard(r.card); }));
            });
        }
    }

    renderRail();   // seed the rail with staples on load

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
        if (card.kind === 'work_log') { renderWorkLog(card); return; }
        if (card.kind === 'notice') { renderNotice(card); return; }
        if (card.kind === 'email_list') { renderEmailList(card); return; }
        if (card.kind === 'email') { renderEmail(card); return; }
        if (card.kind === 'email_draft') { renderEmailDraft(card); return; }
        if (card.kind === 'cycle') { renderCycle(card); return; }
        if (card.kind === 'progression') { renderProgression(card); return; }
        if (card.kind === 'work_chart') { renderWorkChart(card); return; }
        if (card.kind === 'chart') { renderChart(card); return; }
        if (card.kind === 'feedback') { renderFeedback(card); return; }
        if (card.kind === 'personality') { renderPersonality(card); return; }
        if (card.kind === 'appearance') { renderAppearance(card); return; }
        if (card.kind === 'shopping_list') { renderShopping(card); return; }

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
                    const label = document.createElement('label');
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = !!it.done;
                    cb.addEventListener('change', function () { toggleCardItem(cb, it.id, endpoint, doneKey); });
                    const span = document.createElement('span');
                    span.textContent = capFirst(it.label);
                    label.appendChild(cb);
                    label.appendChild(span);
                    li.appendChild(label);
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

        var h = document.createElement('div');
        h.className = 'plan-card-title';
        h.textContent = (card.title || 'Shopping list') + (open.length ? ' · ' + open.length + ' left' : '');
        wrap.appendChild(h);

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
                groups.forEach(function (g) {
                    var gh = document.createElement('div');
                    gh.className = 'shop-group';
                    setIconText(gh, g.icon, daText(g.en, g.da));
                    wrap.appendChild(gh);
                    var gul = document.createElement('ul');
                    gul.className = 'plan-items';
                    open.filter(function (it) { return it.category === g.key; })
                        .forEach(function (it) { gul.appendChild(shoppingLi(it, wrap, card)); });
                    wrap.appendChild(gul);
                });
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
        if (voiceMode) exitVoiceMode();
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

    // Replace the "…" thinking bubble with a row of bobbing sky glyphs.
    function showWeatherWait(row) {
        var bubble = row.querySelector('.msg');
        if (!bubble) return;
        bubble.classList.add('wx-wait');
        bubble.textContent = '';
        [['sun', 'sun'], ['cloud-sun', 'sun'], ['cloud-rain', 'rain'], ['moon', 'night'], ['star', 'sun']].forEach(function (g, i) {
            var s = document.createElement('span');
            s.className = 'wx-wait-glyph wx-tone-' + g[1];
            s.innerHTML = icon(g[0]);
            s.style.animationDelay = (i * 0.16) + 's';
            bubble.appendChild(s);
        });
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

    // Appearance picker card: a grid of theme swatches; tap one to apply it live and
    // save it. Each swatch mimics the theme (bg + a panel chip with accent dot + text bar,
    // and its corner rounding), so you can see the look before committing.
    function renderAppearance(card) {
        clearEmptyHint();
        var cur = card.theme || currentTheme();

        var wrap = document.createElement('div');
        wrap.className = 'plan-card appearance-card';

        var intro = document.createElement('div');
        intro.className = 'persona-intro';
        intro.textContent = daText('Pick a look — tap to apply it instantly.',
            'Vælg et udseende — tryk for at anvende det med det samme.');
        wrap.appendChild(intro);

        var grid = document.createElement('div');
        grid.className = 'theme-grid';
        THEMES.forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'theme-opt' + (t.id === cur ? ' is-on' : '');
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

            b.addEventListener('click', function () {
                applyTheme(t.id, true);
                card.theme = t.id;
                Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('is-on'); });
                b.classList.add('is-on');
                if (cardPanelSub && panelKind === 'appearance') cardPanelSub.textContent = t.label;
            });
            grid.appendChild(b);
        });
        wrap.appendChild(grid);

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

        var items = card.items || [];
        if (!items.length) {
            var empty = document.createElement('div');
            empty.className = 'email-empty';
            empty.textContent = 'Nothing to show.';
            wrap.appendChild(empty);
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
            row.addEventListener('click', function () { openEmail(card.account_id, m); });
            wrap.appendChild(row);
        });

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
        if (voiceMode) exitVoiceMode();
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
                main.textContent = (it.date || '') + '  ' + (it.vendor || '');
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

    // Hand-rolled inline SVG line chart (no chart lib — matches the app's aesthetic).
    function progChartSvg(card) {
        var pts = card.points || [];
        var W = 320, H = 150, padL = 8, padR = 10, padT = 12, padB = 22;
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
        var W = 320, H = 150, padL = 8, padR = 8, padT = 12, padB = 22;
        var innerW = W - padL - padR, innerH = H - padT - padB;
        var n = bars.length || 1;
        var maxMin = Math.max.apply(null, bars.map(function (b) { return b.minutes; }).concat([1]));
        var y0 = padT + innerH;
        var step = innerW / n;
        var barW = Math.min(step * 0.64, 34);
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
        var W = 320, H = 170, padL = 8, padR = 8, padT = 14, padB = 22;
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
            var groupW = Math.min(step * 0.72, stacked ? 34 : 14 * S + 6);
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
            if (res && res.card) buildWorkChart(wrap, res.card);
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
        title.textContent = 'Feedback · ' + (card.status || 'new') + ' (' + n + ')';
        wrap.appendChild(title);

        if (!n) {
            var empty = document.createElement('div');
            empty.className = 'prog-empty';
            empty.textContent = 'No reports.';
            wrap.appendChild(empty);
        } else {
            card.reports.forEach(function (r) { wrap.appendChild(fbReport(r)); });
        }
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function fbReport(r) {
        var box = document.createElement('div');
        box.className = 'fb-report';

        var head = document.createElement('div');
        head.className = 'fb-head';
        head.innerHTML = '<span class="fb-id">#' + r.id + '</span>'
            + '<span class="fb-from">' + progEsc(r.from || '') + '</span>'
            + '<span class="fb-status ' + progEsc(r.status || '') + '">' + progEsc(r.status || '') + '</span>'
            + '<span class="fb-when">' + progEsc(fbDate(r.when)) + '</span>';
        box.appendChild(head);

        if (r.note) {
            var note = document.createElement('div');
            note.className = 'fb-note';
            note.textContent = '“' + r.note + '”';
            box.appendChild(note);
        }

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
            box.appendChild(thread);
        }

        var det = document.createElement('details');
        det.className = 'fb-diag';
        var sum = document.createElement('summary');
        sum.textContent = 'diagnostics';
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
        box.appendChild(det);

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
                        var pill = head.querySelector('.fb-status');
                        if (pill) { pill.className = 'fb-status resolved'; pill.textContent = 'resolved'; }
                        btn.remove();   // keep the download button available after resolving
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
            row.className = 'receipt-field';
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
            row.className = 'receipt-field';
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
                main.textContent = (it.date || '') + '  ' + (it.customer || (it.doc_number || ''));
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
                main.textContent = (it.date || '') + (it.note ? '  ' + it.note : '');
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
            left.textContent = (it.date || '') + '  ' + (it.customer || it.doc_number || '—');
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
            left.textContent = (it.date || '') + '  ' + (it.vendor || '—');
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
            left.textContent = (it.date || '') + (it.note ? '  ' + it.note : '');
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
                left.textContent = (it.date || '') + '  ' + cashCatLabel(it.category) + (it.note ? ' · ' + it.note : '');
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

        // Tax reserve note.
        var tr = card.tax_reserve || {};
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
            noDest.textContent = daText('No destinations yet — add one (e.g. a customer, or DTU) to start logging.',
                                        'Ingen destinationer endnu — tilføj en (fx en kunde eller DTU) for at logge.');
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
                left.textContent = (t.date || '') + '  ' + (t.destination ? t.destination + ' · ' : '') + (t.km || 0) + ' km' + (t.note ? ' · ' + t.note : '') + '  ';
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
            'Business destinations: first 60 days each = business driving (statens takst, in your P&L); day 61+ = commuting. Commute destinations (e.g. DTU) are befordringsfradrag from day 1 — on your personal return, never in the P&L. An estimate — check the year’s rates.',
            'Erhvervsdestinationer: første 60 dage hver = erhvervskørsel (statens takst, i dit resultat); dag 61+ = pendling. Pendlerdestinationer (fx DTU) er befordringsfradrag fra dag 1 — på din personlige selvangivelse, aldrig i resultatet. Et estimat — tjek årets satser.');
        wrap.appendChild(foot);
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
        nameIn.placeholder = daText('Name (e.g. Customer, DTU)', 'Navn (fx Kunde, DTU)');
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
                speak(data.reply || '');
                if (data.card) presentCard(data.card, data.card_mode);
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
    function renderWorkHours(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card work-card';

        var head = document.createElement('div');
        head.className = 'plan-card-title';
        head.textContent = (card.title || 'Work') + (card.range && card.range !== card.title ? ' · ' + card.range : '');
        wrap.appendChild(head);

        var total = document.createElement('div');
        total.className = 'work-total';
        total.textContent = card.total || '0m';
        if (card.ongoing) {
            var live = document.createElement('span');
            live.className = 'work-live';
            live.textContent = 'on the clock';
            total.appendChild(live);
        }
        wrap.appendChild(total);

        // Per-workplace breakdown (only present when >1 labelled place).
        if ((card.places || []).length) {
            var bd = document.createElement('div');
            bd.className = 'work-breakdown';
            card.places.forEach(function (p) {
                var chip = document.createElement('span');
                chip.className = 'work-place-total';
                chip.textContent = (p.place || '—') + ' ' + p.total;
                bd.appendChild(chip);
            });
            wrap.appendChild(bd);
        }

        var sessions = card.sessions || [];
        if (sessions.length) {
            var list = document.createElement('ul');
            list.className = 'work-sessions';
            sessions.forEach(function (s) {
                var li = document.createElement('li');
                var when = document.createElement('span');
                when.className = 'work-when';
                when.textContent = s.day + '  ' + s.in + ' – ' + (s.out || (s.ongoing ? 'now' : '?'));
                if (s.place) {
                    var tag = document.createElement('span');
                    tag.className = 'work-place';
                    tag.textContent = s.place;
                    when.appendChild(document.createTextNode('  '));
                    when.appendChild(tag);
                }
                var dur = document.createElement('span');
                dur.className = 'work-dur';
                dur.textContent = s.duration;
                li.appendChild(when);
                li.appendChild(dur);
                list.appendChild(li);
            });
            wrap.appendChild(list);
        } else {
            var empty = document.createElement('div');
            empty.className = 'plan-empty';
            empty.textContent = 'No time logged yet.';
            wrap.appendChild(empty);
        }

        if ((card.needs_fix || []).length) {
            var warn = document.createElement('div');
            warn.className = 'work-warn';
            var f = card.needs_fix[0];
            warn.textContent = 'No clock-out for ' + f.day + (f.place ? ' @ ' + f.place : '')
                + ' (in at ' + f.in + '). Tell me when you left.';
            warn.insertBefore(iconEl('triangle-alert', 'ic-lead'), warn.firstChild);
            wrap.appendChild(warn);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
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
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }

    // Does this message plausibly need the device's location? (weather, "near me")
    function needsLocation(text) {
        var s = String(text || '');
        return looksLikeWeather(s) || /\bnear(by| me| here)?\b|closest|nearest|around here|where i am|i'm at|næmeste|nærmeste|i nærheden|tæt på/i.test(s);
    }

    // Resolve the device location on demand (cached for the session). Resolves to
    // null if unavailable/denied — the assistant then falls back to named places.
    function getLocation() {
        if (deviceLocation) return Promise.resolve(deviceLocation);
        if (!('geolocation' in navigator)) return Promise.resolve(null);
        return new Promise(function (resolve) {
            navigator.geolocation.getCurrentPosition(
                function (pos) { deviceLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude }; resolve(deviceLocation); },
                function () { resolve(null); },
                { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
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
        // Weather questions can be slow (DMI retries), so show a playful sky
        // animation in the thinking bubble instead of the plain "…".
        if (looksLikeWeather(text)) showWeatherWait(typing);

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

            if (data.conversation_id) {
                conversationId = data.conversation_id;
                localStorage.setItem(CONV_KEY, String(conversationId));
            }
            const replyRow = addMessage(data.reply || '(no reply)', 'assistant', data.reply_html);
            attachMessageMeta(replyRow, { id: data.assistant_message_id, diagnostics: data.diagnostics });
            attachMessageMeta(userRow, { id: data.user_message_id });
            speak(data.reply || '');
            if (data.card) presentCard(data.card, data.card_mode);
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
            if (voiceMode) {
                resumeVoiceWhenReady(); // stay hands-free — re-arm the mic for the next turn
            } else {
                input.focus();
            }
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
        // Real typing = manual switch to text mode. (Mic dictation sets .value
        // programmatically, which does NOT fire 'input', so it won't trip this.)
        if (voiceMode) exitVoiceMode();
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
    function loadConversation(id) {
        return fetch('/api/conversations.php?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('load failed')); })
            .then(function (data) {
                messages.innerHTML = '';
                hidePanel();
                // Cards live in the panel now (the "current view"), not inline in the
                // transcript — so restore just the most recent one for this chat.
                var lastCard = null;
                (data.messages || []).forEach(function (m) {
                    if (m.role === 'assistant') {
                        var row = addMessage(m.content, 'assistant', m.html);
                        attachMessageMeta(row, { id: m.id, diagnostics: m.diagnostics });
                        if (m.card) lastCard = m.card;
                    } else {
                        var urow = addMessage(m.content, 'user');
                        attachMessageMeta(urow, { id: m.id });
                    }
                });
                if (lastCard) presentCard(lastCard);
                conversationId = id;
                localStorage.setItem(CONV_KEY, String(id));
                if (!messages.children.length) showEmptyHint();
                messages.scrollTop = messages.scrollHeight;
                return data;
            });
    }

    // ---------- Voice: text-to-speech (read replies aloud) ----------
    const synth = window.speechSynthesis;
    const ttsBtn = document.getElementById('ttsToggle');
    const TTS_KEY = 'kachow.tts';
    let ttsOn = localStorage.getItem(TTS_KEY) === '1';

    function renderTts() {
        if (!ttsBtn) return;
        // Menu item: icon + label, swapped with the state.
        setIconText(ttsBtn, ttsOn ? 'volume-2' : 'volume-x', ttsOn ? 'Voice on — tap to mute' : 'Read replies aloud');
        ttsBtn.classList.toggle('tm-on', ttsOn);
        ttsBtn.setAttribute('aria-pressed', ttsOn ? 'true' : 'false');
    }

    // `speak` is hoisted, so send() can call it even though it's defined here.
    function speak(text) {
        if (!ttsOn || !synth || !text) return;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = navigator.language || 'en-US';
        synth.speak(u);
    }

    if (synth && ttsBtn) {
        ttsBtn.hidden = false;
        renderTts();
        ttsBtn.addEventListener('click', function () {
            ttsOn = !ttsOn;
            localStorage.setItem(TTS_KEY, ttsOn ? '1' : '0');
            if (ttsOn) {
                // Warm up within this user gesture — iOS won't speak later otherwise.
                synth.speak(new SpeechSynthesisUtterance(' '));
            } else {
                synth.cancel();
            }
            renderTts();
        });
    }

    // ---------- Voice: speech-to-text + hands-free voice mode ----------
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = document.getElementById('mic');
    let recog = null;
    let listening = false;     // a recognition session is currently live
    let stoppedByTap = false;  // this session is ending because the user tapped off
    let lastStart = 0;
    let rapidFails = 0;

    // The red pill tracks voiceMode (the whole hands-free session), not each short
    // recognition session — that's why it now stays lit instead of flickering.
    function paintMic() {
        if (micBtn) micBtn.classList.toggle('listening', voiceMode);
    }

    // Returns true if a session actually started. On iOS, start() outside a user
    // gesture can throw — the caller treats a false as "can't auto-continue".
    function startListening() {
        if (!recog || listening) return false;
        input.value = '';
        lastStart = Date.now();
        try { recog.start(); listening = true; return true; }
        catch (e) { return false; }
    }

    function enterVoiceMode() {
        voiceMode = true;
        rapidFails = 0;
        paintMic();
        startListening();
    }

    function exitVoiceMode() {
        voiceMode = false;
        paintMic();
        if (listening && recog) { stoppedByTap = true; recog.stop(); }
    }

    // Re-arm after the assistant's turn, but only once any spoken reply has
    // finished (so the mic doesn't hear the TTS). Polls speechSynthesis because
    // utterance 'end' events are unreliable in some browsers.
    function resumeVoiceWhenReady() {
        if (!voiceMode) return;
        const go = function () {
            if (voiceMode && !listening && !startListening()) exitVoiceMode();
        };
        if (!synth || !ttsOn) { go(); return; }
        let waited = 0;
        const t = setInterval(function () {
            if ((!synth.speaking && !synth.pending) || waited >= 20000) {
                clearInterval(t);
                go();
            }
            waited += 150;
        }, 150);
    }

    // Keep voice mode alive through silences, but bail if starts keep failing
    // instantly (e.g. iOS wants a fresh tap each turn) so we never busy-loop.
    function keepListeningAlive() {
        const quick = Date.now() - lastStart < 350;
        rapidFails = quick ? rapidFails + 1 : 0;
        if (rapidFails >= 3) { exitVoiceMode(); return; }
        setTimeout(function () {
            if (voiceMode && !busy && !listening && !startListening()) exitVoiceMode();
        }, 400);
    }

    if (SR && micBtn) {
        recog = new SR();
        recog.lang = navigator.language || 'en-US';
        recog.interimResults = true;
        recog.continuous = false;

        recog.addEventListener('result', function (ev) {
            rapidFails = 0;
            let text = '';
            for (let i = 0; i < ev.results.length; i++) {
                text += ev.results[i][0].transcript;
            }
            input.value = text;
            autogrow();
        });
        recog.addEventListener('end', function () {
            listening = false;
            if (stoppedByTap) { stoppedByTap = false; return; }
            if (input.value.trim()) {
                form.requestSubmit();      // natural pause → send; re-arm after the reply
            } else if (voiceMode) {
                keepListeningAlive();      // heard nothing yet → keep waiting
            }
        });
        recog.addEventListener('error', function (ev) {
            listening = false;
            const err = ev && ev.error;
            if (err === 'not-allowed' || err === 'service-not-allowed') {
                exitVoiceMode();           // mic permission denied — stop trying
                stoppedByTap = false;
                return;
            }
            if (voiceMode && !stoppedByTap) keepListeningAlive();
            stoppedByTap = false;
        });

        micBtn.hidden = false;
        micBtn.addEventListener('click', function () {
            if (voiceMode) { exitVoiceMode(); input.focus(); return; }
            enterVoiceMode();
        });
    }

    fetchQuickActions();

    // Deep link from a tapped push notification: open a FRESH chat showing the card
    // that matches the notification (e.g. ?card=cycle). Takes priority over restoring
    // the last conversation.
    var _params = new URLSearchParams(window.location.search);
    var cardParam = _params.get('card');
    if (cardParam) {
        openNotificationCard(cardParam, _params.get('rid'));
    } else {
        decideStartupChat();
    }

    // Resume the last conversation only if it's still "warm" (server says its last
    // message was <1h ago) — a quick refresh lands you back where you were. After a
    // longer gap, start a fresh chat but offer a "pick up where you left off" pill.
    // The idle age is measured server-side, so it's robust across devices/clock skew.
    function decideStartupChat() {
        fetch('/api/conversations.php?recent=1', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                var recent = data && data.recent ? data.recent : null;
                if (recent && recent.age_seconds <= IDLE_RESUME_SECONDS) {
                    loadConversation(recent.id).catch(function () { startFreshChat(recent); });
                } else {
                    startFreshChat(recent);   // idle gap (or no history) → fresh screen
                }
            })
            .catch(function () {
                // Endpoint/network failure → fall back to the old restore behavior.
                if (conversationId) {
                    loadConversation(conversationId).catch(function () { startFreshChat(null); });
                } else {
                    startFreshChat(null);
                }
            });
    }

    function startFreshChat(recent) {
        conversationId = null;
        localStorage.removeItem(CONV_KEY);
        resumeConversation = (recent && recent.id) ? recent : null;
        messages.innerHTML = '';
        showEmptyHint();
    }

    // Short contextual line shown in the fresh chat when a notification card opens, so
    // it isn't just a card over an empty conversation. Language auto-picks from the
    // device (Danish for da-*, English otherwise).
    var CARD_INTRO = {
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

    function openNotificationCard(key, rid) {
        // Start clean: no active conversation, empty transcript.
        conversationId = null;
        localStorage.removeItem(CONV_KEY);
        messages.innerHTML = '';
        hidePanel();
        // Drop the query params so a refresh doesn't re-trigger it.
        try { window.history.replaceState({}, '', window.location.pathname); } catch (e) { /* ignore */ }

        var url = '/api/card.php?for=' + encodeURIComponent(key);
        if (rid) url += '&rid=' + encodeURIComponent(rid);
        fetch(url, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('load failed')); })
            .then(function (data) {
                if (data && data.card) {
                    var intro = cardIntro(key);
                    if (intro) addMessage(intro, 'assistant');
                    presentCard(data.card);
                } else {
                    showEmptyHint();
                }
            })
            .catch(function () { showEmptyHint(); });
    }

    // Location is requested lazily (only when a message actually needs it — see
    // getLocation/needsLocation), not eagerly on load, so we don't prompt or send
    // coordinates unless it matters.

    if ('serviceWorker' in navigator) {
        // When a new service worker (a new deploy) takes control, reload once so the
        // page runs the fresh assets. Crucial for the installed PWA, which can stay
        // open for days. Only for pages that were already controlled (returning
        // users), so a first-time visitor doesn't get a spurious reload.
        var hadController = !!navigator.serviceWorker.controller;
        var refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (refreshing || !hadController) return;
            refreshing = true;
            window.location.reload();
        });

        // A tapped notification on an already-open app: the SW hands us the deep-link
        // URL (since iOS won't navigate it), and we open the matching card in a fresh chat.
        navigator.serviceWorker.addEventListener('message', function (e) {
            var d = e.data || {};
            if (d.type !== 'kachow-open' || !d.url) return;
            try {
                var u = new URL(d.url, location.origin);
                var card = u.searchParams.get('card');
                if (card) openNotificationCard(card, u.searchParams.get('rid'));
            } catch (err) { /* ignore malformed url */ }
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
        applyTheme(currentTheme(), false);
        // Pull the account's saved theme (set on another device) and apply if different.
        fetch('/api/settings.php', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.values && j.values.theme && j.values.theme !== currentTheme()) {
                    applyTheme(j.values.theme, false);
                }
            })
            .catch(function () { /* offline / not logged in — keep the local theme */ });
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
