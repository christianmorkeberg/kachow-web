/*
 * Kachow live voice (Gemini Live) — developer spike.
 *
 * The browser talks to Gemini Live directly over a WebSocket with a short-lived token minted by api/live-token.php
 * (the API key never reaches the page). Tool calls the model makes are forwarded to api/live-tool.php (our own tool
 * registry, allow-listed), and the answer goes back to the model; cards go to the app's panel. What was said is saved
 * into the session's conversation, and events/latencies go to the voice log (api/live-log.php).
 *
 * Wire format (BidiGenerateContent): first message {setup}, then {realtimeInput:{audio|text}}, {toolResponse}; server
 * sends {setupComplete}, {serverContent}, {toolCall}, {toolCallCancellation}, {goAway}, {sessionResumptionUpdate}.
 * Audio in: PCM16 mono 16 kHz. Audio out: PCM16 mono 24 kHz.
 */
(function () {
    'use strict';

    var IN_RATE = 16000;
    var EARCON_AFTER_MS = 800;          // a tool call this slow gets a soft sound, so there is no dead air

    var WORKLET_SRC = [
        'class KachowCap extends AudioWorkletProcessor {',
        '  constructor() { super(); this.ratio = sampleRate / ' + IN_RATE + '; this.t = 0; this.sum = 0; this.n = 0; this.out = new Int16Array(800); this.k = 0; this.energy = 0; this.cnt = 0; }',
        '  process(inputs) {',
        '    var x = inputs[0] && inputs[0][0]; if (!x) return true;',
        '    for (var i = 0; i < x.length; i++) {',
        '      this.sum += x[i]; this.n++; this.t += 1;',
        '      if (this.t >= this.ratio) {',
        '        this.t -= this.ratio; var v = this.sum / this.n; this.sum = 0; this.n = 0;',
        '        this.energy += v * v; this.cnt++;',
        '        v = Math.max(-1, Math.min(1, v)); this.out[this.k++] = v < 0 ? v * 32768 : v * 32767;',
        '        if (this.k === this.out.length) { var rms = Math.sqrt(this.energy / this.cnt); this.port.postMessage({ pcm: this.out.buffer, rms: rms }, [this.out.buffer]); this.out = new Int16Array(800); this.k = 0; this.energy = 0; this.cnt = 0; }',
        '      }',
        '    }',
        '    return true;',
        '  }',
        '}',
        'registerProcessor("kachow-cap", KachowCap);'
    ].join('\n');

    var S = null;   // the live session state, null when no session

    function b64FromBytes(bytes) {
        var s = '', CH = 0x8000;
        for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return btoa(s);
    }
    function bytesFromB64(b64) {
        var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
        for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function post(url, body, signal) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body), signal: signal })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
    }

    // ---------- the dock (state, live lines, mute / end, type-to-test) ----------
    function buildDock() {
        var d = document.createElement('div');
        d.id = 'voiceDock';
        d.className = 'voice-dock';
        d.innerHTML =
            '<div class="vd-row">' +
            '<span class="vd-orb" data-state="connecting"></span>' +
            '<span class="vd-status">Connecting…</span>' +
            '<span class="vd-time"></span>' +
            '<button type="button" class="vd-btn vd-mute" aria-pressed="false">Mute</button>' +
            '<button type="button" class="vd-btn vd-end">End</button>' +
            '</div>' +
            '<div class="vd-line vd-you"></div><div class="vd-line vd-ai"></div>' +
            '<form class="vd-type"><input type="text" placeholder="Type to the voice assistant (testing)…" autocomplete="off"><button type="submit" class="vd-btn">Send</button></form>' +
            '<div class="vd-error" hidden></div>';
        var composer = document.getElementById('composer');
        if (composer && composer.parentNode) composer.parentNode.insertBefore(d, composer); else document.body.appendChild(d);
        return d;
    }

    function ui() { return S && S.dock; }
    function setState(state, text) {
        if (!S) return;
        S.state = state;
        var d = S.dock;
        d.querySelector('.vd-orb').setAttribute('data-state', state);
        d.querySelector('.vd-status').textContent = text || ({
            connecting: 'Connecting…', listening: 'Listening', thinking: 'Working on it…', speaking: 'Speaking', muted: 'Muted — tap Unmute to talk', ended: 'Ended'
        }[state] || state);
    }
    function showError(msg) {
        if (!S) return;
        var e = S.dock.querySelector('.vd-error');
        e.textContent = msg; e.hidden = !msg;
    }
    function tickClock() {
        if (!S) return;
        var left = Math.max(0, S.remaining - Math.round((Date.now() - S.startedAt) / 1000));
        S.dock.querySelector('.vd-time').textContent = Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2) + ' left today';
        return left;
    }

    // ---------- logging to the server ----------
    function logEvent(kind, extra) {
        if (!S) return;
        var e = { kind: kind };
        if (extra) for (var k in extra) e[k] = extra[k];
        S.events.push(e);
        scheduleFlush();
    }
    function scheduleFlush() {
        if (!S || S.flushTimer) return;
        S.flushTimer = setTimeout(function () { S && (S.flushTimer = null); flush(false); }, 1500);
    }
    function flush(beacon) {
        if (!S) return;
        var payload = { session_id: S.sessionId, events: S.events.splice(0), transcript: S.transcript.splice(0) };
        if (!payload.events.length && !payload.transcript.length) return;
        if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon('/api/live-log.php', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        } else {
            post('/api/live-log.php', payload).catch(function () { /* the log is best-effort */ });
        }
    }

    // ---------- audio out ----------
    function playPcm(b64, rate) {
        if (!S || !S.ctx) return;
        var bytes = bytesFromB64(b64);
        var n = bytes.length >> 1;
        if (!n) return;
        var i16 = new Int16Array(bytes.buffer, bytes.byteOffset, n);
        var buf = S.ctx.createBuffer(1, n, rate || 24000);
        var ch = buf.getChannelData(0);
        for (var i = 0; i < n; i++) ch[i] = i16[i] / 32768;
        var src = S.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(S.ctx.destination);
        var startAt = Math.max(S.ctx.currentTime + 0.02, S.nextPlay);
        src.start(startAt);
        S.nextPlay = startAt + buf.duration;
        S.sources.push(src);
        src.onended = function () {
            if (!S) return;
            var ix = S.sources.indexOf(src);
            if (ix >= 0) S.sources.splice(ix, 1);
            if (!S.sources.length) { S.speaking = false; refreshState(); }
        };
        S.speaking = true;
        S.lastActivity = Date.now();
        refreshState();
    }
    function flushPlayback() {
        if (!S) return;
        S.sources.splice(0).forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) { /* already stopped */ } });
        S.nextPlay = 0;
        S.speaking = false;
        refreshState();
    }
    function refreshState() {
        if (!S || S.state === 'connecting' || S.state === 'ended') return;
        if (S.muted) return setState('muted');
        if (S.speaking) return setState('speaking');
        if (Object.keys(S.pending).length) return setState('thinking');
        setState('listening');
    }

    // soft "working on it" sound while a slow call is outstanding
    function earconStart() {
        if (!S || !S.ctx || S.earcon) return;
        var o = S.ctx.createOscillator(), g = S.ctx.createGain();
        o.type = 'sine'; o.frequency.value = 392;
        g.gain.value = 0;
        o.connect(g); g.connect(S.ctx.destination); o.start();
        var t = S.ctx.currentTime;
        var iv = setInterval(function () {
            if (!S || !S.ctx) return;
            var now = S.ctx.currentTime;
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(0.04, now + 0.08);
            g.gain.linearRampToValueAtTime(0, now + 0.4);
        }, 1400);
        S.earcon = { o: o, g: g, iv: iv };
    }
    function earconStop() {
        if (!S || !S.earcon) return;
        clearInterval(S.earcon.iv);
        try { S.earcon.o.stop(); } catch (e) { /* ignore */ }
        S.earcon = null;
    }
    function updateEarcon() {
        if (!S) return;
        var slow = false, now = Date.now();
        Object.keys(S.pending).forEach(function (id) { if (now - S.pending[id].started >= EARCON_AFTER_MS) slow = true; });
        if (slow && !S.speaking) earconStart(); else earconStop();
    }

    // ---------- the Live connection ----------
    function send(obj) {
        if (S && S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
    }

    function onMessage(msg) {
        if (!S) return;
        if (msg.setupComplete !== undefined) {
            S.ready = true;
            logEvent('setup_complete', { ms: Date.now() - S.startedAt });
            setState('listening');
            startMic();
            return;
        }
        if (msg.serverContent) handleContent(msg.serverContent);
        if (msg.toolCall) handleToolCalls(msg.toolCall.functionCalls || []);
        if (msg.toolCallCancellation) handleCancel(msg.toolCallCancellation.ids || []);
        if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) S.resumeHandle = msg.sessionResumptionUpdate.newHandle;
        if (msg.usageMetadata) S.usage = msg.usageMetadata;
        if (msg.goAway) {
            logEvent('goaway', { detail: msg.goAway });
            showError('Google is ending this connection soon — tap the mic to start again.');
            finish('goaway');
        }
        if (msg.error) {
            logEvent('client_error', { detail: { message: JSON.stringify(msg.error).slice(0, 400) } });
            showError('Voice error: ' + JSON.stringify(msg.error).slice(0, 200));
        }
    }

    function handleContent(sc) {
        if (sc.interrupted) {
            flushPlayback();
            logEvent('interrupted');
            // what the assistant had said before it was cut off still happened: keep it
            var cut = S.modelBuf.trim();
            S.modelBuf = '';
            if (cut) { S.transcript.push({ role: 'assistant', text: cut + ' …' }); S.hooks.addMessage && S.hooks.addMessage(cut + ' …', 'assistant'); scheduleFlush(); }
            S.dock.querySelector('.vd-ai').textContent = '';
        }
        if (sc.inputTranscription && sc.inputTranscription.text) {
            S.userBuf += sc.inputTranscription.text;
            S.lastUserAt = Date.now();
            S.lastActivity = Date.now();
            S.firstAudioPending = true;
            S.dock.querySelector('.vd-you').textContent = 'You: ' + S.userBuf.trim();
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
            S.modelBuf += sc.outputTranscription.text;
            S.dock.querySelector('.vd-ai').textContent = 'Kachow: ' + S.modelBuf.trim();
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
            sc.modelTurn.parts.forEach(function (p) {
                if (p.inlineData && p.inlineData.data) {
                    var m = /rate=(\d+)/.exec(p.inlineData.mimeType || '');
                    if (S.firstAudioPending && S.lastUserAt && S.firstAudios < 5) {
                        S.firstAudios++;
                        logEvent('first_audio', { ms: Date.now() - S.lastUserAt });
                    }
                    S.firstAudioPending = false;
                    updateEarcon();
                    playPcm(p.inlineData.data, m ? parseInt(m[1], 10) : 24000);
                }
            });
        }
        if (sc.turnComplete) endTurn();
    }

    // A finished turn: put what was said in the chat and queue it for the conversation.
    function endTurn() {
        var u = S.userBuf.trim(), a = S.modelBuf.trim();
        S.userBuf = ''; S.modelBuf = '';
        if (u) { S.transcript.push({ role: 'user', text: u }); S.hooks.addMessage && S.hooks.addMessage(u, 'user'); }
        if (a) { S.transcript.push({ role: 'assistant', text: a }); S.hooks.addMessage && S.hooks.addMessage(a, 'assistant'); }
        if (u || a) scheduleFlush();
        S.dock.querySelector('.vd-you').textContent = '';
        S.dock.querySelector('.vd-ai').textContent = '';
    }

    function handleToolCalls(calls) {
        calls.forEach(function (c) {
            var id = c.id, name = c.name, slow = S.slowTools.indexOf(name) >= 0;
            var ac = new AbortController();
            S.pending[id] = { name: name, started: Date.now(), abort: ac, slow: slow };
            S.lastActivity = Date.now();
            refreshState();
            setTimeout(updateEarcon, EARCON_AFTER_MS + 20);
            post('/api/live-tool.php', { session_id: S.sessionId, name: name, args: c.args || {} }, ac.signal).then(function (r) {
                if (!S || !S.pending[id]) return;               // cancelled (barge-in) or the session is over
                delete S.pending[id];
                var b = r.body || {};
                var result = b.result && typeof b.result === 'object' && !Array.isArray(b.result) ? b.result : { output: b.result || b.error || 'No result.' };
                if (r.status >= 400 && !b.result) result = { error: b.error || 'The tool failed.' };
                if (b.card && S.hooks.presentCard) S.hooks.presentCard(b.card, 'open');
                var fr = { id: id, name: name, response: result };
                if (slow) fr.scheduling = 'WHEN_IDLE';
                send({ toolResponse: { functionResponses: [fr] } });
                S.lastActivity = Date.now();
                updateEarcon(); refreshState();
            }).catch(function (e) {
                if (!S || !S.pending[id]) return;
                delete S.pending[id];
                if (e && e.name === 'AbortError') return;
                logEvent('client_error', { name: name, detail: { message: 'tool request failed: ' + (e && e.message) } });
                send({ toolResponse: { functionResponses: [{ id: id, name: name, response: { error: 'The tool could not be reached.' } }] } });
                updateEarcon(); refreshState();
            });
        });
    }

    function handleCancel(ids) {
        ids.forEach(function (id) {
            var p = S.pending[id];
            if (!p) return;
            delete S.pending[id];
            try { p.abort.abort(); } catch (e) { /* ignore */ }
            logEvent('cancelled', { name: p.name });
        });
        updateEarcon(); refreshState();
    }

    // ---------- the microphone ----------
    function startMic() {
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then(function (stream) {
            if (!S) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            S.stream = stream;
            var blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
            var url = URL.createObjectURL(blob);
            return S.ctx.audioWorklet.addModule(url).then(function () {
                URL.revokeObjectURL(url);
                if (!S) return;
                S.src = S.ctx.createMediaStreamSource(stream);
                S.node = new AudioWorkletNode(S.ctx, 'kachow-cap');
                S.node.port.onmessage = function (ev) {
                    if (!S || S.muted || !S.ready) return;
                    send({ realtimeInput: { audio: { data: b64FromBytes(new Uint8Array(ev.data.pcm)), mimeType: 'audio/pcm;rate=' + IN_RATE } } });
                };
                S.src.connect(S.node);       // not connected to the speakers: nothing to echo
            });
        }).catch(function (e) {
            logEvent('client_error', { detail: { message: 'microphone: ' + (e && e.message) } });
            showError('Could not use the microphone: ' + (e && e.message ? e.message : e) + ' (you can still type below).');
        });
    }

    // ---------- start / stop ----------
    function start(hooks) {
        if (S) return Promise.resolve(false);
        hooks = hooks || {};
        var dock = document.getElementById('voiceDock') || buildDock();
        dock.hidden = false;
        S = {
            hooks: hooks, dock: dock, state: 'connecting', ws: null, ctx: null, stream: null, node: null, src: null,
            sources: [], nextPlay: 0, speaking: false, muted: false, ready: false, pending: {}, earcon: null,
            userBuf: '', modelBuf: '', events: [], transcript: [], flushTimer: null, startedAt: Date.now(), lastActivity: Date.now(),
            lastUserAt: 0, firstAudioPending: false, firstAudios: 0, slowTools: [], resumeHandle: null, usage: null, sessionId: '', remaining: 0, idle: 45, timer: null
        };
        setState('connecting');
        showError('');
        // The audio context must be created in this tap (browsers/iOS only allow audio after a gesture).
        var AC = window.AudioContext || window.webkitAudioContext;
        S.ctx = new AC();
        if (S.ctx.resume) S.ctx.resume();
        var toolMode = (window.localStorage && localStorage.getItem('kachow.voice.toolmode')) || 'auto';

        return post('/api/live-token.php', { tool_mode: toolMode }).then(function (r) {
            if (!S) return false;
            var b = r.body || {};
            if (r.status >= 400 || !b.token) throw new Error(b.error || ('Could not start voice (HTTP ' + r.status + ').'));
            S.sessionId = b.session_id; S.remaining = b.remaining_seconds; S.idle = b.idle_seconds; S.slowTools = b.slow_tools || [];
            S.startedAt = Date.now();
            if (hooks.begin) hooks.begin(b.conversation_id);
            if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (w) { if (S) S.wake = w; else w.release(); }).catch(function () { /* optional */ });
            return openSocket(b);
        }).then(function () { return true; }).catch(function (e) {
            showError(e && e.message ? e.message : String(e));
            teardown(true);
            return false;
        });
    }

    function openSocket(b) {
        return new Promise(function (resolve, reject) {
            var ws = new WebSocket(b.ws_url + '?access_token=' + encodeURIComponent(b.token));
            S.ws = ws;
            var opened = false;
            var timeout = setTimeout(function () { if (!S || !S.ready) { reject(new Error('Gemini Live did not answer the setup in 10 s.')); try { ws.close(); } catch (e) { /* ignore */ } } }, 10000);
            ws.onopen = function () { opened = true; ws.send(JSON.stringify({ setup: b.setup })); };
            ws.onmessage = function (ev) {
                var handle = function (text) {
                    var msg; try { msg = JSON.parse(text); } catch (e) { return; }
                    if (msg.setupComplete !== undefined) { clearTimeout(timeout); resolve(); }
                    onMessage(msg);
                };
                if (typeof ev.data === 'string') handle(ev.data);
                else if (ev.data && ev.data.text) ev.data.text().then(handle);
            };
            ws.onerror = function () { if (!opened) { clearTimeout(timeout); reject(new Error('Could not open the Gemini Live connection.')); } };
            ws.onclose = function (ev) {
                clearTimeout(timeout);
                if (!S) return;
                if (!S.ready) { reject(new Error('Gemini Live closed the connection (' + ev.code + (ev.reason ? ': ' + ev.reason : '') + ').')); return; }
                if (S.state !== 'ended') {
                    logEvent('client_error', { detail: { message: 'socket closed ' + ev.code + ' ' + (ev.reason || '') } });
                    showError('The connection closed (' + ev.code + (ev.reason ? ': ' + ev.reason : '') + '). Tap the mic to start again.');
                    finish('closed');
                }
            };
            S.timer = setInterval(tick, 1000);
        });
    }

    // once a second: the clock, the idle timeout, the daily limit. Idle counts silence since the last RECOGNISED speech
    // (or the assistant talking / a tool running) — never raw microphone level, so a noisy room cannot keep a session open.
    function tick() {
        if (!S) return;
        var left = tickClock();
        if (left <= 0) { logEvent('limit_close'); showError('Today\'s voice time is used up.'); return finish('limit'); }
        var busy = Object.keys(S.pending).length > 0 || S.speaking;
        if (!busy && Date.now() - S.lastActivity > S.idle * 1000) { logEvent('idle_close', { ms: Date.now() - S.startedAt }); return finish('idle'); }
    }

    function finish(why) {
        if (!S) return;
        logEvent('session_end', { ms: Date.now() - S.startedAt, detail: { why: why, usage: S.usage } });
        endTurn();
        setState('ended', why === 'idle' ? 'Stopped after silence — tap the mic to start again' : (why === 'limit' ? 'Daily limit reached' : 'Ended'));
        teardown(false);
    }

    function teardown(failed) {
        if (!S) return;
        var s = S;
        flush(true);
        if (s.timer) clearInterval(s.timer);
        earconStop();
        flushPlayback();
        Object.keys(s.pending).forEach(function (id) { try { s.pending[id].abort.abort(); } catch (e) { /* ignore */ } });
        s.pending = {};
        try { s.node && s.node.disconnect(); s.src && s.src.disconnect(); } catch (e) { /* ignore */ }
        try { s.stream && s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        try { s.ws && s.ws.readyState < 2 && s.ws.close(); } catch (e) { /* ignore */ }
        try { s.ctx && s.ctx.close(); } catch (e) { /* ignore */ }
        if (s.wake) { try { s.wake.release(); } catch (e) { /* ignore */ } }
        if (s.hooks && s.hooks.end) s.hooks.end();
        s.state = 'ended';
        var dock = s.dock;
        S = null;
        // leave the dock up a moment so the reason can be read, unless it never got started
        setTimeout(function () { if (!S && dock) dock.hidden = true; }, failed ? 6000 : 4000);
    }

    function stop() { if (S) { logEvent('session_end', { ms: Date.now() - S.startedAt, detail: { why: 'manual', usage: S.usage } }); endTurn(); teardown(false); } }

    function toggleMute() {
        if (!S) return;
        S.muted = !S.muted;
        var b = S.dock.querySelector('.vd-mute');
        b.textContent = S.muted ? 'Unmute' : 'Mute';
        b.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
        if (S.stream) S.stream.getAudioTracks().forEach(function (t) { t.enabled = !S.muted; });
        S.lastActivity = Date.now();
        refreshState();
    }

    function sendText(text) {
        text = (text || '').trim();
        if (!S || !S.ready || !text) return;
        send({ realtimeInput: { text: text } });
        S.lastActivity = Date.now();
        S.lastUserAt = Date.now();
        S.firstAudioPending = true;
        S.userBuf += (S.userBuf ? ' ' : '') + text;
        S.dock.querySelector('.vd-you').textContent = 'You: ' + S.userBuf;
    }

    // dock buttons (delegated, so a rebuilt dock still works)
    document.addEventListener('click', function (e) {
        if (!e.target || !e.target.closest) return;
        if (e.target.closest('#voiceDock .vd-end')) stop();
        else if (e.target.closest('#voiceDock .vd-mute')) toggleMute();
    });
    document.addEventListener('submit', function (e) {
        var f = e.target && e.target.closest && e.target.closest('#voiceDock .vd-type');
        if (!f) return;
        e.preventDefault();
        var i = f.querySelector('input');
        sendText(i.value);
        i.value = '';
    });
    window.addEventListener('pagehide', function () { if (S) { logEvent('session_end', { ms: Date.now() - S.startedAt, detail: { why: 'pagehide' } }); flush(true); } });

    window.KachowVoice = {
        start: start,
        stop: stop,
        isActive: function () { return !!S; },
        sendText: sendText,
        _state: function () { return S; }
    };
})();
