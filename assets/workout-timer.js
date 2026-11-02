// Workout timer card: EMOM (every minute on the minute / work + rest intervals), a countdown timer and a stopwatch.
// All on the device: no server state. The engine (emomPlan / emomAt / formatMs) is pure, so it is easy to test; the rest
// is the card UI, beeps (Web Audio), vibration and a screen wake lock. One session runs at a time and lives in this module,
// so the timer keeps going when the card is re-rendered or you flip to the chat and back.
//
// Time is always read from the clock (performance.now), never counted in ticks: a phone that throttles a background tab
// catches up the moment it wakes (the sound can't play while the page is asleep, the display is right again at once).
window.WorkoutTimer = (function () {
    'use strict';

    var STORE = 'kachow-workout-timer';
    var EMOM_DEFAULT = { work: 40, rest: 20, by: 'rounds', rounds: 10, total: 10, prep: 5 };
    var PRESETS = [[60, 0], [40, 20], [45, 15], [30, 30]];   // [work, rest]: classic every-minute, then common splits

    function clamp(v, lo, hi) {
        v = Math.round(Number(v));
        if (!isFinite(v)) v = lo;
        return Math.max(lo, Math.min(hi, v));
    }

    // ---------------- pure engine ----------------

    /** The EMOM schedule from a config: seconds of work and rest per round, rounds (given, or total minutes ÷ round length), get-ready seconds. */
    function emomPlan(c) {
        c = c || {};
        var work = clamp(c.work, 5, 900), rest = clamp(c.rest, 0, 900), prep = clamp(c.prep, 0, 30), per = work + rest;
        var rounds = c.by === 'total' ? Math.max(1, Math.floor(clamp(c.total, 1, 240) * 60 / per)) : clamp(c.rounds, 1, 200);
        return { work: work, rest: rest, prep: prep, per: per, rounds: rounds, totalMs: (prep + per * rounds) * 1000 };
    }

    /** Where an EMOM is after elapsedMs: state prep | work | rest | done, round (1-based, 0 while getting ready), ms left in the phase and in total. */
    function emomAt(plan, elapsedMs) {
        var e = Math.max(0, elapsedMs), total = plan.totalMs;
        var base = { elapsedMs: e, totalLeftMs: Math.max(0, total - e), rounds: plan.rounds };
        if (e >= total) return Object.assign(base, { state: 'done', round: plan.rounds, leftMs: 0, phaseMs: 0 });
        var prepMs = plan.prep * 1000;
        if (e < prepMs) return Object.assign(base, { state: 'prep', round: 0, leftMs: prepMs - e, phaseMs: prepMs });
        var t = e - prepMs, perMs = plan.per * 1000, r = Math.floor(t / perMs), into = t - r * perMs, workMs = plan.work * 1000;
        if (into < workMs) return Object.assign(base, { state: 'work', round: r + 1, leftMs: workMs - into, phaseMs: workMs });
        return Object.assign(base, { state: 'rest', round: r + 1, leftMs: perMs - into, phaseMs: perMs - workMs });
    }

    /** m:ss (or h:mm:ss from an hour), rounding UP like a countdown shows it; { tenths:true } → m:ss.t, truncated like a stopwatch. */
    function formatMs(ms, opts) {
        ms = Math.max(0, ms);
        var tenths = opts && opts.tenths;
        var s = tenths ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        var out = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
        return tenths ? out + '.' + Math.floor((ms % 1000) / 100) : out;
    }

    /** What to sound between two readings of the same session: a start tone when a phase changes, short ticks for the last 3 seconds. */
    function cues(prev, cur) {
        if (!cur) return [];
        if (!prev || prev.key !== cur.key) return cur.start ? [cur.start] : [];
        if (cur.sec !== prev.sec && cur.sec >= 1 && cur.sec <= 3 && cur.tickable) return ['tick'];
        return [];
    }

    // ---------------- device bits ----------------

    var audio = null;
    function ensureAudio() {
        try {
            if (!audio) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); }
            if (audio && audio.state === 'suspended') audio.resume();
        } catch (e) { audio = null; }
    }
    function tone(freq, ms, gain) {
        if (!audio) return;
        try {
            var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
            o.type = 'sine'; o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(gain || 0.4, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
            o.connect(g); g.connect(audio.destination);
            o.start(t); o.stop(t + ms / 1000 + 0.02);
        } catch (e) { /* no sound */ }
    }
    function play(name) {
        var buzz = function (p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* unsupported */ } };
        if (name === 'tick')   { tone(660, 90, 0.3); buzz(30); }
        else if (name === 'work') { tone(988, 450, 0.5); buzz([120, 60, 120]); }
        else if (name === 'rest') { tone(523, 350, 0.4); buzz(200); }
        else if (name === 'done') { [0, 220, 440].forEach(function (d) { setTimeout(function () { tone(784, 180, 0.5); }, d); }); buzz([200, 100, 200, 100, 400]); }
    }

    // Keep the screen on while a session exists (running or paused; released when it is done or reset). The Screen Wake Lock API
    // does it where the browser has it; iPhones' Home Screen apps have been unreliable about it, so there a tiny silent looping
    // video is played as well (the well-known "NoSleep" trick). Both are harmless to run together.
    var wake = null, vid = null;
    var SILENT_MP4 = 'data:video/mp4;base64,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';
    function isIosHomeScreenApp() {
        var ua = navigator.userAgent || '', ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
        return ios && (navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
    }
    function fallbackOn() {
        try {
            if (!vid) {
                vid = document.createElement('video');
                vid.setAttribute('playsinline', ''); vid.setAttribute('muted', ''); vid.muted = true; vid.loop = true;
                vid.src = SILENT_MP4;
                vid.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
                document.body.appendChild(vid);
            }
            var p = vid.play();
            if (p && p.catch) p.catch(function () { /* needs a tap first; the next Start/Resume tap retries */ });
        } catch (e) { /* unsupported */ }
    }
    function wakeOn() {
        var lockOk = false;
        try {
            if (navigator.wakeLock && !wake) {
                lockOk = true;
                navigator.wakeLock.request('screen').then(function (l) { wake = l; l.addEventListener('release', function () { wake = null; }); })
                    .catch(function () { fallbackOn(); });
            } else if (navigator.wakeLock) lockOk = true;
        } catch (e) { lockOk = false; }
        if (!lockOk || isIosHomeScreenApp()) fallbackOn();
    }
    function wakeOff() {
        try { if (wake) wake.release(); } catch (e) { /* ignore */ }
        wake = null;
        try { if (vid) vid.pause(); } catch (e) { /* ignore */ }
    }

    function loadCfg() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
    function saveCfg(part) { try { localStorage.setItem(STORE, JSON.stringify(Object.assign(loadCfg(), part))); } catch (e) { /* private mode */ } }

    // ---------------- the running session (module-level: survives re-renders) ----------------

    var S = null;   // { mode, cfg, plan, base, t0, state: 'running'|'paused'|'done', laps, last, timer, paint }

    function elapsed() { return S.base + (S.t0 == null ? 0 : performance.now() - S.t0); }

    /** The reading of the session now: display fields plus the sound key. */
    function read() {
        var ms = elapsed();
        if (S.mode === 'emom') {
            var v = emomAt(S.plan, ms), sec = Math.ceil(v.leftMs / 1000);
            return { v: v, ms: ms, key: v.state + ':' + v.round, sec: sec, tickable: v.state !== 'done' && v.phaseMs > 3000,
                start: v.state === 'work' ? 'work' : (v.state === 'rest' ? 'rest' : (v.state === 'done' ? 'done' : null)) };
        }
        if (S.mode === 'timer') {
            var left = Math.max(0, S.total - ms), done = left <= 0;
            return { v: { state: done ? 'done' : 'work', leftMs: left, phaseMs: S.total }, ms: ms, key: done ? 'done' : 'run', sec: Math.ceil(left / 1000),
                tickable: S.total > 3000 && !done, start: done ? 'done' : null };
        }
        return { v: { state: 'work', leftMs: ms }, ms: ms, key: 'run', sec: 0, tickable: false, start: null };
    }

    function tick() {
        if (!S || S.state !== 'running') return;
        var r = read();
        cues(S.last, r).forEach(play);
        S.last = r;
        var finished = (S.mode === 'emom' && r.v.state === 'done') || (S.mode === 'timer' && r.v.state === 'done');
        if (finished) { S.base = elapsed(); S.t0 = null; S.state = 'done'; clearInterval(S.timer); wakeOff(); }
        if (S.paint) S.paint(r);
    }

    function begin(mode, cfg) {
        ensureAudio();
        end();
        S = { mode: mode, cfg: cfg, base: 0, t0: performance.now(), state: 'running', laps: [], last: null, paint: null };
        if (mode === 'emom') S.plan = emomPlan(cfg);
        if (mode === 'timer') S.total = (clamp(cfg.minutes, 0, 600) * 60 + clamp(cfg.seconds, 0, 59)) * 1000;
        S.timer = setInterval(tick, 100);
        wakeOn();
        tick();
    }
    function pause() {
        if (!S || S.state !== 'running') return;
        S.base = elapsed(); S.t0 = null; S.state = 'paused';   // the screen stays on while paused (mid-workout)
        if (S.paint) S.paint(read());
    }
    function resume() {
        if (!S || S.state !== 'paused') return;
        ensureAudio();
        S.t0 = performance.now(); S.state = 'running'; wakeOn();
        tick();
    }
    function end() {
        if (S) clearInterval(S.timer);
        S = null;
        wakeOff();
    }
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && S) {
            if (S.state === 'running' || S.state === 'paused') wakeOn();   // the browser drops the lock when the page was hidden
            if (S.state === 'running') tick();
        }
    });

    // ---------------- UI ----------------

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /** Draws the card into root. hooks: { icon(name, cls), daText(en, da) }. card: { mode: 'emom'|'timer'|'stopwatch', work, rest, rounds, total_minutes, minutes, seconds }. */
    function render(root, card, hooks) {
        var icon = hooks.icon, T = hooks.daText;
        var saved = loadCfg();
        var mode = S ? S.mode : (['emom', 'timer', 'stopwatch'].indexOf(card.mode) !== -1 ? card.mode : (saved.mode || 'emom'));

        var emom = Object.assign({}, EMOM_DEFAULT, saved.emom || {});
        if (card.work != null) emom.work = card.work;
        if (card.rest != null) emom.rest = card.rest;
        if (card.rounds != null) { emom.rounds = card.rounds; emom.by = 'rounds'; }
        if (card.total_minutes != null) { emom.total = card.total_minutes; emom.by = 'total'; }
        var cd = Object.assign({ minutes: 5, seconds: 0 }, saved.timer || {});
        if (card.minutes != null) cd.minutes = card.minutes;
        if (card.seconds != null) cd.seconds = card.seconds;

        root.innerHTML = '';
        var wrap = el('div', 'wt-card');
        root.appendChild(wrap);

        function btn(cls, html, label, fn) {
            var b = el('button', cls);
            b.type = 'button';
            b.innerHTML = html;
            if (label) { b.setAttribute('aria-label', label); }
            b.addEventListener('click', fn);
            return b;
        }
        function again() { render(root, card, hooks); }

        // Tabs (locked while a session is on, so a running timer is never lost by a stray tap).
        var tabs = el('div', 'wt-tabs');
        [['emom', 'EMOM'], ['timer', T('Timer', 'Timer')], ['stopwatch', T('Stopwatch', 'Stopur')]].forEach(function (t) {
            var b = btn('wt-tab' + (t[0] === mode ? ' on' : ''), t[1], null, function () { saveCfg({ mode: t[0] }); card = Object.assign({}, card, { mode: t[0] }); again(); });
            if (S) b.disabled = true;
            tabs.appendChild(b);
        });
        wrap.appendChild(tabs);
        var body = el('div', 'wt-body');
        wrap.appendChild(body);

        function stepper(label, get, set, lo, hi, step, unit) {
            var row = el('div', 'wt-row');
            row.appendChild(el('div', 'wt-lab', label));
            var ctl = el('div', 'wt-step');
            var inp = el('input', 'wt-num');
            inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = lo; inp.max = hi; inp.value = get();
            function commit(v) { set(clamp(v, lo, hi)); inp.value = get(); sum(); }
            ctl.appendChild(btn('wt-pm', icon('minus'), T('Less', 'Mindre'), function () { commit(get() - step); }));
            inp.addEventListener('change', function () { commit(inp.value); });
            ctl.appendChild(inp);
            if (unit) ctl.appendChild(el('span', 'wt-unit', unit));
            ctl.appendChild(btn('wt-pm', icon('plus'), T('More', 'Mere'), function () { commit(get() + step); }));
            row.appendChild(ctl);
            return row;
        }
        var sum = function () { /* set by the emom setup */ };

        // ----- setup views -----
        function setupEmom() {
            var presets = el('div', 'wt-presets');
            PRESETS.forEach(function (p) {
                presets.appendChild(btn('wt-chip', p[1] ? p[0] + ' / ' + p[1] : T('Every minute', 'Hvert minut'), null, function () {
                    emom.work = p[0]; emom.rest = p[1]; saveCfg({ emom: emom }); again();
                }));
            });
            body.appendChild(presets);
            body.appendChild(stepper(T('Work', 'Arbejde'), function () { return emom.work; }, function (v) { emom.work = v; }, 5, 900, 5, 's'));
            body.appendChild(stepper(T('Rest', 'Pause'), function () { return emom.rest; }, function (v) { emom.rest = v; }, 0, 900, 5, 's'));
            var by = el('div', 'wt-seg');
            [['rounds', T('Rounds', 'Runder')], ['total', T('Total time', 'Samlet tid')]].forEach(function (o) {
                by.appendChild(btn('wt-segb' + (emom.by === o[0] ? ' on' : ''), o[1], null, function () { emom.by = o[0]; saveCfg({ emom: emom }); again(); }));
            });
            body.appendChild(by);
            body.appendChild(emom.by === 'total'
                ? stepper(T('Total', 'Samlet'), function () { return emom.total; }, function (v) { emom.total = v; }, 1, 240, 1, 'min')
                : stepper(T('Rounds', 'Runder'), function () { return emom.rounds; }, function (v) { emom.rounds = v; }, 1, 200, 1, ''));
            body.appendChild(stepper(T('Get ready', 'Gør klar'), function () { return emom.prep; }, function (v) { emom.prep = v; }, 0, 30, 5, 's'));
            var s = el('div', 'wt-sum');
            body.appendChild(s);
            sum = function () {
                var p = emomPlan(emom);
                s.textContent = p.rounds + ' × (' + p.work + ' s ' + T('work', 'arbejde') + (p.rest ? ' + ' + p.rest + ' s ' + T('rest', 'pause') : '') + ') = '
                    + formatMs((p.per * p.rounds) * 1000) + (p.prep ? ' + ' + p.prep + ' s ' + T('to get ready', 'til at gøre klar') : '');
            };
            sum();
            body.appendChild(btn('wt-go', icon('play') + ' ' + T('Start', 'Start'), null, function () { saveCfg({ mode: 'emom', emom: emom }); begin('emom', emom); again(); }));
        }
        function setupTimer() {
            var presets = el('div', 'wt-presets');
            [1, 3, 5, 10, 15].forEach(function (m) {
                presets.appendChild(btn('wt-chip', m + ' min', null, function () { cd.minutes = m; cd.seconds = 0; saveCfg({ timer: cd }); again(); }));
            });
            body.appendChild(presets);
            body.appendChild(stepper(T('Minutes', 'Minutter'), function () { return cd.minutes; }, function (v) { cd.minutes = v; }, 0, 600, 1, 'min'));
            body.appendChild(stepper(T('Seconds', 'Sekunder'), function () { return cd.seconds; }, function (v) { cd.seconds = v; }, 0, 59, 5, 's'));
            body.appendChild(btn('wt-go', icon('play') + ' ' + T('Start', 'Start'), null, function () {
                if (!clamp(cd.minutes, 0, 600) && !clamp(cd.seconds, 0, 59)) return;
                saveCfg({ mode: 'timer', timer: cd }); begin('timer', cd); again();
            }));
        }
        function setupStopwatch() {
            var big = el('div', 'wt-big', formatMs(0, { tenths: true }));
            body.appendChild(big);
            body.appendChild(btn('wt-go', icon('play') + ' ' + T('Start', 'Start'), null, function () { saveCfg({ mode: 'stopwatch' }); begin('stopwatch', {}); again(); }));
        }

        // ----- run view (shared by the three modes) -----
        function runView() {
            var box = el('div', 'wt-run');
            var phase = el('div', 'wt-phase'), big = el('div', 'wt-big'), bar = el('div', 'wt-bar'), fill = el('i'), meta = el('div', 'wt-meta');
            bar.appendChild(fill);
            box.appendChild(phase); box.appendChild(big);
            if (S.mode !== 'stopwatch') box.appendChild(bar);
            box.appendChild(meta);
            var actions = el('div', 'wt-actions');
            var main = btn('wt-go', '', null, function () { if (S.state === 'running') pause(); else if (S.state === 'paused') resume(); else { var m = S.mode, c = S.cfg; begin(m, c); again(); } });
            var lap = btn('wt-sec', icon('flag') + ' ' + T('Lap', 'Omgang'), null, function () {
                var ms = elapsed(), prev = S.laps.length ? S.laps[S.laps.length - 1].at : 0;
                S.laps.push({ at: ms, split: ms - prev });
                paint(read());
            });
            var reset = btn('wt-sec', icon('rotate-ccw') + ' ' + T('Reset', 'Nulstil'), null, function () { end(); again(); });
            if (S.mode === 'stopwatch') actions.appendChild(lap);
            actions.appendChild(main); actions.appendChild(reset);
            box.appendChild(actions);
            var laps = el('ol', 'wt-laps');
            if (S.mode === 'stopwatch') box.appendChild(laps);
            body.appendChild(box);

            function paint(r) {
                if (!box.isConnected) return;
                var v = r.v, st = S.state === 'done' ? 'done' : (S.state === 'paused' ? 'paused' : v.state);
                box.className = 'wt-run wt-' + st;
                if (S.mode === 'emom') {
                    phase.textContent = st === 'done' ? T('Done!', 'Færdig!') : (st === 'paused' ? T('Paused', 'Pause') : (v.state === 'prep' ? T('Get ready', 'Gør klar') : (v.state === 'work' ? T('WORK', 'ARBEJD') : T('REST', 'HVIL'))));
                    big.textContent = st === 'done' ? formatMs(S.plan.totalMs) : formatMs(v.leftMs);
                    fill.style.width = (v.phaseMs ? 100 - v.leftMs / v.phaseMs * 100 : 100).toFixed(1) + '%';
                    meta.textContent = v.state === 'prep' ? '' : T('Round ', 'Runde ') + v.round + ' / ' + v.rounds + ' · ' + T('left ', 'tilbage ') + formatMs(v.totalLeftMs);
                    if (st === 'done') meta.textContent = S.plan.rounds + ' ' + T('rounds', 'runder');
                } else if (S.mode === 'timer') {
                    phase.textContent = st === 'done' ? T('Time!', 'Tid!') : (st === 'paused' ? T('Paused', 'Pause') : T('Timer', 'Timer'));
                    big.textContent = formatMs(v.leftMs);
                    fill.style.width = (S.total ? 100 - v.leftMs / S.total * 100 : 100).toFixed(1) + '%';
                    meta.textContent = '';
                } else {
                    phase.textContent = st === 'paused' ? T('Paused', 'Pause') : T('Stopwatch', 'Stopur');
                    big.textContent = formatMs(r.ms, { tenths: true });
                    meta.textContent = '';
                    laps.innerHTML = '';
                    S.laps.slice().reverse().forEach(function (l, i) {
                        var li = el('li');
                        li.appendChild(el('span', 'wt-lapn', '#' + (S.laps.length - i)));
                        li.appendChild(el('span', 'wt-lapt', formatMs(l.split, { tenths: true })));
                        li.appendChild(el('span', 'wt-lapa', formatMs(l.at, { tenths: true })));
                        laps.appendChild(li);
                    });
                }
                main.innerHTML = S.state === 'running' ? icon('pause') + ' ' + T('Pause', 'Pause')
                    : (S.state === 'paused' ? icon('play') + ' ' + T('Resume', 'Fortsæt') : icon('rotate-ccw') + ' ' + T('Again', 'Igen'));
                lap.hidden = S.state !== 'running';
            }
            S.paint = paint;
            paint(read());
        }

        if (S) runView();
        else if (mode === 'emom') setupEmom();
        else if (mode === 'timer') setupTimer();
        else setupStopwatch();
    }

    return { emomPlan: emomPlan, emomAt: emomAt, formatMs: formatMs, cues: cues, render: render, stop: end };
})();
