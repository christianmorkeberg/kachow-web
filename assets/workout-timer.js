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
    /** Sound that ignores the phone's silent switch, where the browser lets a page ask for it (the Audio Session API: iPhone Safari / Home Screen apps).
     *  'playback' = heard even on silent (and other apps' music pauses); 'auto' = the browser's default (muted by the switch). */
    function silentOk() { return loadCfg().silentPlay === true; }   // off unless chosen: it pauses other apps' music (the old 'silent' key is ignored on purpose)
    function soundOn() { return soundMode() !== 'off'; }   // with sound off the timer never touches the phone's audio: other apps' music keeps playing
    function applyAudioSession() {
        if (!soundOn()) return;
        try {
            var as = navigator.audioSession;
            if (!as || as.type === 'play-and-record') return;   // a voice session is using the mic: leave its audio session alone
            // "Play on silent" ON: 'playback' — the only session iOS lets past the silent switch (other apps' music pauses while the timer sounds).
            // OFF: 'ambient' — mixed over music, but muted by the silent switch.
            as.type = silentOk() ? 'playback' : 'ambient';
        } catch (e) { /* unsupported */ }
    }
    /** Give the audio session back when the timer is not sounding any more ('playback' blocks the microphone: voice mode could not start). */
    function releaseAudioSession() {
        try { var as = navigator.audioSession; if (as && as.type !== 'play-and-record') as.type = 'auto'; } catch (e) { /* unsupported */ }
    }
    function ensureAudio() {
        if (!soundOn()) return;
        applyAudioSession();
        try {
            if (!audio) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); }
            if (audio && audio.state === 'suspended') audio.resume();
        } catch (e) { audio = null; }
    }
    // iPhone: the silent switch mutes Web Audio (the beeps) — but not an HTML audio element that is playing. Looping a silent one while the
    // timer runs switches the page's audio to "playback", so the beeps are heard on silent too (the usual "unmute iOS audio" trick).
    // Only on iOS (elsewhere it would just show a media notification); needs the tap on Start/Resume to be allowed to play.
    var keep = null, keepUrl = null;
    function silentWavUrl() {
        if (keepUrl) return keepUrl;
        var n = 800, rate = 8000, b = new Uint8Array(44 + n), dv = new DataView(b.buffer);
        var str = function (o, t) { for (var i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
        str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
        dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, 'data'); dv.setUint32(40, n, true);
        for (var i = 0; i < n; i++) b[44 + i] = 128;   // 8-bit silence
        keepUrl = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
        return keepUrl;
    }
    function keepOn() {
        if (!isIos() || !silentOk() || !soundOn()) return;   // the loop is what lets the beeps through on silent; it pauses other apps' music
        try {
            if (!keep) { keep = new Audio(); keep.loop = true; keep.setAttribute('playsinline', ''); keep.src = silentWavUrl(); }
            var p = keep.play();
            if (p && p.catch) p.catch(function () { /* needs a tap; the next Start/Resume tap retries */ });
        } catch (e) { /* unsupported */ }
    }
    function keepOff() { try { if (keep) keep.pause(); } catch (e) { /* ignore */ } releaseAudioSession(); }

    // On iPhone the silent switch mutes Web Audio but not an HTML <audio> element (it counts as media, like the voice does), so there the beeps are tiny
    // generated WAV files played through <audio>, one per pitch, cached. Elsewhere Web Audio as before.
    var toneUrls = {};
    function toneWavUrl(freq, ms, gain) {
        var key = freq + '/' + ms + '/' + gain;
        if (toneUrls[key]) return toneUrls[key];
        var rate = 22050, n = Math.floor(rate * ms / 1000), b = new Uint8Array(44 + n * 2), dv = new DataView(b.buffer);
        var str = function (o, t) { for (var i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
        str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
        dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
        for (var i = 0; i < n; i++) {
            var t = i / rate, env = Math.min(1, t / 0.01) * Math.min(1, (ms / 1000 - t) / 0.03);   // short fade in and out: no clicks
            dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * t) * Math.max(0, env) * (gain || 0.4) * 32767), true);
        }
        return (toneUrls[key] = URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
    }
    function tone(freq, ms, gain) {
        if (false && beepEl && beepReady) {   // the <audio> beeps were no better on silent than Web Audio (report); kept for reference
            try {
                beepEl.src = toneWavUrl(freq, ms, gain);
                var p = beepEl.play();
                if (p && p.catch) p.catch(function () { webTone(freq, ms, gain); });   // refused: the Web Audio beep instead, so one always sounds
                return;
            } catch (e) { /* fall through to Web Audio */ }
        }
        webTone(freq, ms, gain);
    }
    // One <audio> element, started inside the Start / Resume tap (iOS only lets an element play later if a tap started it), then reused for every beep.
    var beepEl = null, beepReady = false;
    function unlockBeep() {
        if (!isIos() || !soundOn()) return;
        try {
            if (!beepEl) { beepEl = new Audio(); beepEl.setAttribute('playsinline', ''); }
            beepEl.src = toneWavUrl(440, 30, 0.0001);
            var p = beepEl.play();
            if (p && p.then) p.then(function () { beepReady = true; }).catch(function () { beepReady = false; }); else beepReady = true;
        } catch (e) { beepReady = false; }
    }
    function webTone(freq, ms, gain) {
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
    // Sound setting: beep | voice | both | off (remembered). Voice uses the browser's speech synthesis (Danish or English like the app).
    var SOUNDS = ['both', 'beep', 'voice', 'off'];
    function soundMode() { var m = loadCfg().sound; return SOUNDS.indexOf(m) !== -1 ? m : 'voice'; }
    function langTag() { return (navigator.language || '').toLowerCase().indexOf('da') === 0 ? 'da-DK' : 'en-GB'; }
    var talk = null;   // the app's daText, set by render() — the spoken words are translated like the screen
    var voiceCache = null;
    function pickVoice(tag) {
        try {
            var list = window.speechSynthesis.getVoices() || [], pre = tag.slice(0, 2);
            voiceCache = list.filter(function (v) { return v.lang === tag; })[0] || list.filter(function (v) { return (v.lang || '').slice(0, 2) === pre; })[0] || null;
        } catch (e) { voiceCache = null; }
        return voiceCache;
    }
    function speak(text) {
        try {
            var ss = window.speechSynthesis;
            if (!ss || !text) return;
            ss.cancel();   // never queue behind a slow earlier phrase
            var u = new SpeechSynthesisUtterance(text);
            u.lang = langTag(); u.rate = 1.05;
            var v = voiceCache || pickVoice(u.lang);
            if (v) u.voice = v;
            ss.speak(u);
        } catch (e) { /* no voice */ }
    }
    /** iOS only lets a page speak after a tap has spoken once: an empty phrase on Start/Resume unlocks it. */
    function unlockVoice() {
        try { if (window.speechSynthesis && soundMode() !== 'beep' && soundMode() !== 'off') window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* ignore */ }
    }
    /** The words for a cue, from the reading r (round, rounds). */
    function words(name, r) {
        var T = talk || function (en) { return en; }, v = r && r.v ? r.v : {};
        if (name === 'prep') return T('Get ready', 'Gør klar');
        if (name === 'work') return v.round && v.rounds > 1 && v.round === v.rounds ? T('Last round. Work!', 'Sidste runde. Arbejd!') : (v.round ? T('Work! Round ', 'Arbejd! Runde ') + v.round : T('Go!', 'Kør!'));
        if (name === 'rest') return T('Rest', 'Hvil');
        if (name === 'done') return T('Done. Well done!', 'Færdig. Flot arbejde!');
        if (name === 'tick' && r && r.sec >= 1 && r.sec <= 3) return String(r.sec);
        return '';
    }
    function play(name, r) {
        var mode = soundMode();
        if (mode === 'off') return;
        var beeps = mode === 'beep' || mode === 'both', voice = mode === 'voice' || mode === 'both';
        ensureAudio();   // every cue: the audio session is asked for again (a 'transient' one is let go of after its sound) and a suspended context wakes
        var buzz = function (p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* unsupported */ } };
        if (name === 'tick') {
            // The last 3 seconds: beeps (also with "both" — a spoken count would talk over the next phrase); voice alone counts out loud.
            if (beeps) { tone(660, 90, 0.3); buzz(30); } else speak(words('tick', r));
            return;
        }
        if (voice) speak(words(name, r));
        if (name === 'work')      { if (beeps) tone(988, 450, 0.5); buzz([120, 60, 120]); }
        else if (name === 'rest') { if (beeps) tone(523, 350, 0.4); buzz(200); }
        else if (name === 'done') { if (beeps) [0, 220, 440].forEach(function (d) { setTimeout(function () { tone(784, 180, 0.5); }, d); }); buzz([200, 100, 200, 100, 400]); }
    }

    // Keep the screen on while a session exists (running or paused; released when it is done or reset). The Screen Wake Lock API
    // does it where the browser has it; iPhones' Home Screen apps have been unreliable about it, so there a tiny silent looping
    // video is played as well (the well-known "NoSleep" trick). Both are harmless to run together.
    var wake = null, vid = null;
    var SILENT_MP4 = 'data:video/mp4;base64,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';
    function isIos() {
        var ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    }
    function isIosHomeScreenApp() {
        return isIos() && (navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
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
                start: v.state === 'prep' ? 'prep' : (v.state === 'work' ? 'work' : (v.state === 'rest' ? 'rest' : (v.state === 'done' ? 'done' : null))) };
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
        cues(S.last, r).forEach(function (c) { play(c, r); });
        S.last = r;
        var finished = (S.mode === 'emom' && r.v.state === 'done') || (S.mode === 'timer' && r.v.state === 'done');
        if (finished) { S.base = elapsed(); S.t0 = null; S.state = 'done'; clearInterval(S.timer); wakeOff(); setTimeout(keepOff, 2500); }
        if (S.paint) S.paint(r);
    }

    function begin(mode, cfg) {
        end();   // first: it gives the audio session back, which the lines below then claim again
        ensureAudio();
        unlockBeep();
        unlockVoice();
        S = { mode: mode, cfg: cfg, base: 0, t0: performance.now(), state: 'running', laps: [], last: null, paint: null };
        if (mode === 'emom') S.plan = emomPlan(cfg);
        if (mode === 'timer') S.total = (clamp(cfg.minutes, 0, 600) * 60 + clamp(cfg.seconds, 0, 59)) * 1000;
        S.timer = setInterval(tick, 100);
        wakeOn();
        keepOn();   // after end() above, which stops the loop of a previous session
        tick();
    }
    function pause() {
        if (!S || S.state !== 'running') return;
        S.base = elapsed(); S.t0 = null; S.state = 'paused'; keepOff();   // the screen stays on while paused (mid-workout)
        if (S.paint) S.paint(read());
    }
    function resume() {
        if (!S || S.state !== 'paused') return;
        ensureAudio();
        unlockBeep();
        keepOn();
        unlockVoice();
        S.t0 = performance.now(); S.state = 'running'; wakeOn();
        tick();
    }
    function end() {
        if (S) clearInterval(S.timer);
        S = null;
        wakeOff();
        keepOff();
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

    var RING_C = 2 * Math.PI * 90;
    /** A progress ring (SVG) around a big number; .set(fraction 0..1) moves it. */
    function ringOf(big) {
        var box = el('div', 'wt-ring');
        box.innerHTML = '<svg viewBox="0 0 200 200" aria-hidden="true"><circle class="wt-ring-bg" cx="100" cy="100" r="90"/>'
            + '<circle class="wt-ring-fg" cx="100" cy="100" r="90" transform="rotate(-90 100 100)"/></svg>';
        box.appendChild(big);
        var fg = box.querySelector('.wt-ring-fg');
        fg.style.strokeDasharray = RING_C.toFixed(1);
        var set = function (f) { fg.style.strokeDashoffset = (RING_C * (1 - Math.max(0, Math.min(1, f)))).toFixed(1); };
        set(0);
        return { box: box, set: set };
    }

    /** Draws the card into root. hooks: { icon(name, cls), daText(en, da) }. card: { mode: 'emom'|'timer'|'stopwatch', work, rest, rounds, total_minutes, minutes, seconds }. */
    function render(root, card, hooks) {
        var icon = hooks.icon, T = hooks.daText;
        talk = T;
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
            tabs.appendChild(b);
        });
        if (!S) wrap.appendChild(tabs);   // while a session runs the tabs would only be in the way
        var body = el('div', 'wt-body');
        wrap.appendChild(body);

        // A number you can nudge with − / + or type. With a tone (work / rest / accent) it is a big coloured tile, without one a plain row.
        function stepper(label, get, set, lo, hi, step, unit, tone, big) {
            var row = el('div', tone ? 'wt-tile wt-tone-' + tone : 'wt-row');
            row.appendChild(el('div', 'wt-lab', label));
            var ctl = el('div', 'wt-step');
            var inp = el('input', 'wt-num');
            inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = lo; inp.max = hi; inp.value = get();
            var hint = el('div', 'wt-hint');
            function showHint() { hint.textContent = unit === 's' && get() >= 60 ? '= ' + formatMs(get() * 1000) : ''; }
            function commit(v) { set(clamp(v, lo, hi)); inp.value = get(); showHint(); sum(); saveCfg({ emom: emom, timer: cd }); }   // every change is remembered, not only the ones that get started
            ctl.appendChild(btn('wt-pm', icon('minus'), T('Less', 'Mindre'), function () { commit(get() - step); }));
            inp.addEventListener('change', function () { commit(inp.value); });
            var mid = el('div', 'wt-mid');
            mid.appendChild(inp);
            if (unit) mid.appendChild(el('span', 'wt-unit', unit));
            ctl.appendChild(mid);
            ctl.appendChild(btn('wt-pm', icon('plus'), T('More', 'Mere'), function () { commit(get() + step); }));
            row.appendChild(ctl);
            if (tone) { showHint(); row.appendChild(hint); }
            if (big && tone) {   // a bigger jump under the number: "−1 min / +1 min" (a whole minute of work or rest in one tap)
                var jump = el('div', 'wt-jump');
                jump.appendChild(btn('wt-pm2', '−' + big.label, T('Less by ', 'Mindre med ') + big.label, function () { commit(get() - big.step); }));
                jump.appendChild(btn('wt-pm2', '+' + big.label, T('More by ', 'Mere med ') + big.label, function () { commit(get() + big.step); }));
                row.appendChild(jump);
            }
            return row;
        }
        var sum = function () { /* set by the emom setup */ };

        function soundRow() {
            var row = el('div', 'wt-row');
            row.appendChild(el('div', 'wt-lab', T('Sound', 'Lyd')));
            var seg = el('div', 'wt-seg wt-sound'), cur = soundMode();
            [['both', T('Both', 'Begge')], ['beep', T('Beeps', 'Bip')], ['voice', T('Voice', 'Stemme')], ['off', T('Off', 'Fra')]].forEach(function (o) {
                seg.appendChild(btn('wt-segb' + (cur === o[0] ? ' on' : ''), o[1], null, function () {
                    saveCfg({ sound: o[0] });
                    seg.querySelectorAll('.wt-segb').forEach(function (b) { b.classList.remove('on'); });
                    this.classList.add('on');
                    if (o[0] === 'off') keepOff();   // let go of the phone's audio at once: other apps' music can carry on
                    else if (S && S.state === 'running') { ensureAudio(); keepOn(); }
                    if (o[0] === 'voice' || o[0] === 'both') { unlockVoice(); speak(T('Rest', 'Hvil')); }   // a sample, and the unlock iOS needs
                    else if (o[0] === 'beep') { ensureAudio(); unlockBeep(); tone(988, 200, 0.4); }
                }));
            });
            row.appendChild(seg);
            return row;
        }

        // "Play even when the phone is on silent": offered on iPhone/iPad (and anywhere the browser has the Audio Session API).
        function silentRow() {
            if (!navigator.audioSession && !isIos()) return null;
            var row = el('div', 'wt-row');
            row.appendChild(el('div', 'wt-lab', T('Beeps on silent (pauses music)', 'Bip på lydløs (pauser musik)')));
            var seg = el('div', 'wt-seg'), cur = silentOk();
            [[true, T('On', 'Til')], [false, T('Off', 'Fra')]].forEach(function (o) {
                seg.appendChild(btn('wt-segb' + (cur === o[0] ? ' on' : ''), o[1], null, function () {
                    saveCfg({ silentPlay: o[0] });
                    seg.querySelectorAll('.wt-segb').forEach(function (b) { b.classList.remove('on'); });
                    this.classList.add('on');
                    ensureAudio(); keepOn(); tone(988, 200, 0.4);   // a sample, so you can hear whether it gets through
                    if (!S) setTimeout(keepOff, 1500);
                }));
            });
            row.appendChild(seg);
            return row;
        }

        // ----- setup views -----
        function setupEmom() {
            var presets = el('div', 'wt-presets');
            PRESETS.forEach(function (p) {
                presets.appendChild(btn('wt-chip', p[1] ? p[0] + ' / ' + p[1] : T('Every minute', 'Hvert minut'), null, function () {
                    emom.work = p[0]; emom.rest = p[1]; saveCfg({ emom: emom }); again();
                }));
            });
            body.appendChild(presets);
            var grid = el('div', 'wt-grid');
            grid.appendChild(stepper(T('Work', 'Arbejde'), function () { return emom.work; }, function (v) { emom.work = v; }, 5, 900, 5, 's', 'work', { step: 60, label: '1 min' }));
            grid.appendChild(stepper(T('Rest', 'Pause'), function () { return emom.rest; }, function (v) { emom.rest = v; }, 0, 900, 5, 's', 'rest', { step: 60, label: '1 min' }));
            body.appendChild(grid);
            var by = el('div', 'wt-seg');
            [['rounds', T('Rounds', 'Runder')], ['total', T('Total time', 'Samlet tid')]].forEach(function (o) {
                by.appendChild(btn('wt-segb' + (emom.by === o[0] ? ' on' : ''), o[1], null, function () { emom.by = o[0]; saveCfg({ emom: emom }); again(); }));
            });
            body.appendChild(by);
            body.appendChild(emom.by === 'total'
                ? stepper(T('Total time', 'Samlet tid'), function () { return emom.total; }, function (v) { emom.total = v; }, 1, 240, 1, 'min', 'accent', { step: 10, label: '10 min' })
                : stepper(T('Rounds', 'Runder'), function () { return emom.rounds; }, function (v) { emom.rounds = v; }, 1, 200, 1, '', 'accent', { step: 5, label: '5' }));
            body.appendChild(stepper(T('Get ready', 'Gør klar'), function () { return emom.prep; }, function (v) { emom.prep = v; }, 0, 30, 5, 's'));
            // The pattern at a glance: get-ready, then each round's work (green) and rest (yellow), widths in proportion.
            var pat = el('div', 'wt-pattern');
            body.appendChild(pat);
            var s = el('div', 'wt-sum');
            body.appendChild(s);
            sum = function () {
                var p = emomPlan(emom);
                pat.innerHTML = '';
                if (p.prep) { var pp = el('i', 'p'); pp.style.flexGrow = p.prep; pat.appendChild(pp); }
                for (var k = 0; k < Math.min(p.rounds, 30); k++) {
                    var r = el('span', 'r'); r.style.flexGrow = p.per;
                    var w = el('i', 'w'); w.style.flexGrow = p.work; r.appendChild(w);
                    if (p.rest) { var q = el('i', 'q'); q.style.flexGrow = p.rest; r.appendChild(q); }
                    pat.appendChild(r);
                }
                s.textContent = p.rounds + ' × (' + p.work + ' s ' + T('work', 'arbejde') + (p.rest ? ' + ' + p.rest + ' s ' + T('rest', 'pause') : '') + ') = '
                    + formatMs((p.per * p.rounds) * 1000) + (p.prep ? ' + ' + p.prep + ' s ' + T('to get ready', 'til at gøre klar') : '')
                    + (p.rounds > 30 ? ' · ' + T('first 30 rounds shown', 'de første 30 runder vist') : '');
            };
            sum();
            body.appendChild(soundRow());
            var sr = silentRow(); if (sr) body.appendChild(sr);
            body.appendChild(btn('wt-go', icon('play') + ' ' + T('Start', 'Start'), null, function () { saveCfg({ mode: 'emom', emom: emom }); begin('emom', emom); again(); }));
        }
        function setupTimer() {
            var presets = el('div', 'wt-presets');
            [1, 3, 5, 10, 15].forEach(function (m) {
                presets.appendChild(btn('wt-chip', m + ' min', null, function () { cd.minutes = m; cd.seconds = 0; saveCfg({ timer: cd }); again(); }));
            });
            body.appendChild(presets);
            var tg = el('div', 'wt-grid');
            tg.appendChild(stepper(T('Minutes', 'Minutter'), function () { return cd.minutes; }, function (v) { cd.minutes = v; }, 0, 600, 1, 'min', 'accent', { step: 10, label: '10 min' }));
            tg.appendChild(stepper(T('Seconds', 'Sekunder'), function () { return cd.seconds; }, function (v) { cd.seconds = v; }, 0, 59, 5, 's', 'accent', { step: 30, label: '30 s' }));
            body.appendChild(tg);
            body.appendChild(soundRow());
            var sr = silentRow(); if (sr) body.appendChild(sr);
            body.appendChild(btn('wt-go', icon('play') + ' ' + T('Start', 'Start'), null, function () {
                if (!clamp(cd.minutes, 0, 600) && !clamp(cd.seconds, 0, 59)) return;
                saveCfg({ mode: 'timer', timer: cd }); begin('timer', cd); again();
            }));
        }
        function setupStopwatch() {
            var big = el('div', 'wt-big', formatMs(0, { tenths: true }));
            body.appendChild(ringOf(big).box);
            body.appendChild(btn('wt-go', icon('play') + ' ' + T('Start', 'Start'), null, function () { saveCfg({ mode: 'stopwatch' }); begin('stopwatch', {}); again(); }));
        }

        // ----- run view (shared by the three modes) -----
        function runView() {
            var box = el('div', 'wt-run');
            var phase = el('div', 'wt-phase'), big = el('div', 'wt-big'), meta = el('div', 'wt-meta');
            var ring = ringOf(big);
            box.appendChild(phase); box.appendChild(ring.box); box.appendChild(meta);
            // One square per round (EMOM, up to 30): done = filled, now = outlined, to come = faint.
            var dots = [];
            if (S.mode === 'emom' && S.plan.rounds <= 30) {
                var dr = el('div', 'wt-dots');
                for (var d = 0; d < S.plan.rounds; d++) { var dd = el('i'); dots.push(dd); dr.appendChild(dd); }
                box.appendChild(dr);
            }
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
                    ring.set(st === 'done' ? 1 : (v.phaseMs ? 1 - v.leftMs / v.phaseMs : 0));
                    dots.forEach(function (dd, k) { dd.className = st === 'done' || k + 1 < v.round ? 'done' : (k + 1 === v.round && v.state !== 'prep' ? 'now' : ''); });
                    meta.textContent = v.state === 'prep' ? '' : T('Round ', 'Runde ') + v.round + ' / ' + v.rounds + ' · ' + T('left ', 'tilbage ') + formatMs(v.totalLeftMs);
                    if (st === 'done') meta.textContent = S.plan.rounds + ' ' + T('rounds', 'runder');
                } else if (S.mode === 'timer') {
                    phase.textContent = st === 'done' ? T('Time!', 'Tid!') : (st === 'paused' ? T('Paused', 'Pause') : T('Timer', 'Timer'));
                    big.textContent = formatMs(v.leftMs);
                    ring.set(S.total ? 1 - v.leftMs / S.total : 1);
                    meta.textContent = '';
                } else {
                    phase.textContent = st === 'paused' ? T('Paused', 'Pause') : T('Stopwatch', 'Stopur');
                    big.textContent = formatMs(r.ms, { tenths: true });
                    ring.set((r.ms % 60000) / 60000);   // one lap of the ring per minute
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
