'use strict';

// Chat frontend: talks only to /api/chat.php. Keeps the current conversation id
// in localStorage so a reload continues the same thread.

(function () {
    const messages = document.getElementById('messages');
    const form = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const newChatBtn = document.getElementById('newChat');
    const AVATAR_SRC = '/assets/hummingbird_no_background.gif';

    const CONV_KEY = 'kachow.conversation_id';
    let conversationId = Number(localStorage.getItem(CONV_KEY)) || null;
    let busy = false;
    // Hands-free voice mode: once on, the mic stays armed across turns until the
    // user manually switches back to text (by typing) or taps the mic off.
    let voiceMode = false;
    let quickActions = null;   // cached suggestions for the empty-screen chips
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

    // Quick-action chips: frequent-first suggestions from the server.
    function renderChips(container) {
        if (!quickActions || !quickActions.length) return;
        container.innerHTML = '';
        quickActions.forEach(function (text) {
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
            avatar.src = AVATAR_SRC;
            avatar.alt = '';
            avatar.setAttribute('aria-hidden', 'true');
            el.appendChild(avatar);
            el.appendChild(bubble);
        }

        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;
        return el;
    }

    function autogrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }

    async function send(text) {
        if (busy || !text.trim()) return;
        busy = true;
        sendBtn.disabled = true;
        addMessage(text, 'user');

        const typing = addMessage('…', 'assistant');
        typing.classList.add('typing');

        try {
            const res = await fetch('/api/chat.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    message: text,
                    conversation_id: conversationId || undefined,
                    location: deviceLocation || undefined,
                }),
            });

            if (res.status === 401) {
                window.location.href = '/index.php';
                return;
            }

            const data = await res.json().catch(() => ({}));
            typing.remove();

            if (!res.ok) {
                addMessage(data.error || 'Something went wrong.', 'error');
                return;
            }

            if (data.conversation_id) {
                conversationId = data.conversation_id;
                localStorage.setItem(CONV_KEY, String(conversationId));
            }
            addMessage(data.reply || '(no reply)', 'assistant', data.reply_html);
            speak(data.reply || '');
        } catch (err) {
            typing.remove();
            addMessage('Network error. Please try again.', 'error');
        } finally {
            busy = false;
            sendBtn.disabled = false;
            if (voiceMode) {
                resumeVoiceWhenReady(); // stay hands-free — re-arm the mic for the next turn
            } else {
                input.focus();
            }
        }
    }

    form.addEventListener('submit', function (ev) {
        ev.preventDefault();
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
        showEmptyHint();
        input.focus();
    });

    // ---------- Voice: text-to-speech (read replies aloud) ----------
    const synth = window.speechSynthesis;
    const ttsBtn = document.getElementById('ttsToggle');
    const TTS_KEY = 'kachow.tts';
    let ttsOn = localStorage.getItem(TTS_KEY) === '1';

    function renderTts() {
        if (!ttsBtn) return;
        // Swap the glyph, not just the color — iOS ignores CSS color on emoji.
        ttsBtn.textContent = ttsOn ? '🔊' : '🔇';
        ttsBtn.classList.toggle('on', ttsOn);
        ttsBtn.setAttribute('aria-pressed', ttsOn ? 'true' : 'false');
        ttsBtn.title = ttsOn ? 'Voice replies on — tap to mute' : 'Read replies aloud';
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

    showEmptyHint();
    fetchQuickActions();

    // Ask for location once (browser remembers the choice); used for weather etc.
    // Silent if denied/unavailable — the assistant just falls back to named places.
    if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
            function (pos) { deviceLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude }; },
            function () { /* denied or unavailable — fine */ },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
        );
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
        });
    }
})();
