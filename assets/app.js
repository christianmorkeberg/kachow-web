'use strict';

// Chat frontend: talks only to /api/chat.php. Keeps the current conversation id
// in localStorage so a reload continues the same thread.

(function () {
    const messages = document.getElementById('messages');
    const form = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const newChatBtn = document.getElementById('newChat');

    const CONV_KEY = 'kachow.conversation_id';
    let conversationId = Number(localStorage.getItem(CONV_KEY)) || null;
    let busy = false;

    function showEmptyHint() {
        if (!messages.children.length) {
            const hint = document.createElement('div');
            hint.className = 'empty';
            hint.textContent = 'Ask about your workouts, wishlist, or calendar.';
            messages.appendChild(hint);
        }
    }

    function clearEmptyHint() {
        const hint = messages.querySelector('.empty');
        if (hint) hint.remove();
    }

    function addMessage(text, role, html) {
        clearEmptyHint();
        const el = document.createElement('div');
        el.className = 'msg ' + role;
        if (role === 'assistant' && typeof html === 'string' && html) {
            // Server-rendered, HTML-escaped markdown (see Support\Markdown).
            el.innerHTML = html;
        } else {
            el.textContent = text;
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
            input.focus();
        }
    }

    form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const text = input.value;
        input.value = '';
        autogrow();
        send(text);
    });

    input.addEventListener('input', autogrow);
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

    // ---------- Voice: speech-to-text (dictate a message) ----------
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = document.getElementById('mic');
    let listening = false;

    if (SR && micBtn) {
        const recog = new SR();
        recog.lang = navigator.language || 'en-US';
        recog.interimResults = true;
        recog.continuous = false;
        let stoppedByTap = false;

        recog.addEventListener('result', function (ev) {
            let text = '';
            for (let i = 0; i < ev.results.length; i++) {
                text += ev.results[i][0].transcript;
            }
            input.value = text;
            autogrow();
        });
        recog.addEventListener('end', function () {
            listening = false;
            micBtn.classList.remove('listening');
            // Ended on its own (natural pause) → auto-send. Tapped to stop → leave
            // the text in the box so you can review/edit before sending.
            if (!stoppedByTap && input.value.trim()) form.requestSubmit();
            stoppedByTap = false;
        });
        recog.addEventListener('error', function () {
            listening = false;
            micBtn.classList.remove('listening');
        });

        micBtn.hidden = false;
        micBtn.addEventListener('click', function () {
            if (listening) { stoppedByTap = true; recog.stop(); input.focus(); return; }
            input.value = '';
            try {
                recog.start();
                listening = true;
                micBtn.classList.add('listening');
            } catch (e) { /* start() throws if already running — ignore */ }
        });
    }

    showEmptyHint();

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
        });
    }
})();
