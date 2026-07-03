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

    showEmptyHint();

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
        });
    }
})();
