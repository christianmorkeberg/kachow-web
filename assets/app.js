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

    const CONV_KEY = 'kachow.conversation_id';
    let conversationId = Number(localStorage.getItem(CONV_KEY)) || null;
    let busy = false;
    let sendController = null;  // AbortController for the in-flight chat request (Stop button)
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
        if (card.kind === 'work_log') { renderWorkLog(card); return; }
        if (card.kind === 'notice') { renderNotice(card); return; }
        if (card.kind === 'email_list') { renderEmailList(card); return; }
        if (card.kind === 'email') { renderEmail(card); return; }
        if (card.kind === 'email_draft') { renderEmailDraft(card); return; }
        if (card.kind === 'cycle') { renderCycle(card); return; }
        if (card.kind === 'progression') { renderProgression(card); return; }

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
        } else if (card.kind === 'shopping_list') {
            endpoint = '/api/shopping-list.php';
            doneKey = 'checked';
            sections = [{ head: null, items: card.items || [] }];
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
                    span.textContent = it.label;
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
        return /(weather|forecast|temperature|rain|snow|sunny|sun\b|windy|cloud|storm|degrees|umbrella|vejr|regn|sne|solen|solskin|temperatur|vind|blæs|skyet|grader|paraply|byge)/i.test(String(text || ''));
    }

    // Replace the "…" thinking bubble with a row of bobbing sky glyphs.
    function showWeatherWait(row) {
        var bubble = row.querySelector('.msg');
        if (!bubble) return;
        bubble.classList.add('wx-wait');
        bubble.textContent = '';
        ['☀️', '⛅', '🌧️', '🌙', '⭐'].forEach(function (g, i) {
            var s = document.createElement('span');
            s.className = 'wx-wait-glyph';
            s.textContent = g;
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
    function renderEmailList(card) {
        clearEmptyHint();
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
        var loading = addMessage('Opening…', 'assistant');
        loading.classList.add('typing');
        fetch('/api/email-read.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ account_id: accountId != null ? accountId : undefined, id: m.id }),
        })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
            .then(function (r) {
                loading.remove();
                if (r.ok && r.d && r.d.card) {
                    renderCard(r.d.card);
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
        reply.textContent = '↩ Reply';
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
                var h = (j.hours != null && j.hours > 0) ? (' · ' + (+j.hours) + 'h') : '';
                chip.textContent = j.job + h + ' (' + j.entries + ')';
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
            meta.textContent = dateLabel + ' · ' + it.job + (it.hours != null && it.hours > 0 ? ' · ' + (+it.hours) + 'h' : '');
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
        close.textContent = '✕';
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
        winter: { emoji: '❄️', label: 'Winter', cls: 'cyc-winter', clinical: 'menstrual' },
        spring: { emoji: '🌱', label: 'Spring', cls: 'cyc-spring', clinical: 'follicular' },
        summer: { emoji: '☀️', label: 'Summer', cls: 'cyc-summer', clinical: 'ovulation' },
        autumn: { emoji: '🍂', label: 'Autumn', cls: 'cyc-autumn', clinical: 'luteal' }
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

        var arcs = arc(1, pLen, 'cyc-winter')
            + arc(pLen + 1, fStart - 1, 'cyc-spring')
            + arc(fStart, fEnd, 'cyc-summer')
            + arc(fEnd + 1, L, 'cyc-autumn');

        var day = Math.min(Math.max(card.cycle_day || 1, 1), L);
        var markAngle = ((day - 0.5) / L) * 360;
        var marker = '<g transform="rotate(' + markAngle.toFixed(2) + ' ' + cx + ' ' + cx + ')">'
            + '<circle class="cyc-marker" cx="' + cx + '" cy="' + (cx - r) + '" r="9"/></g>';

        var center = '<text class="cyc-emoji" x="90" y="82" text-anchor="middle">' + (card.season_emoji || '🌸') + '</text>'
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
        seasonName.textContent = (card.season_emoji ? card.season_emoji + ' ' : '') + (card.season_label || '');
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
            txt.textContent = meta.emoji + ' ' + meta.label + clin;
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
            fert.innerHTML = '☀️ Fertile window (est.): ' + cycShortDate(card.fertile_from) + ' – ' + cycShortDate(card.fertile_to)
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
                dots += '<path class="' + cls + '" d="' + d + '"><title>' + progEsc(title) + '</title></path>';
            } else {
                dots += '<circle class="' + cls + '" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1)
                    + '" r="' + (last ? 4.5 : 3) + '"><title>' + progEsc(title) + '</title></circle>';
            }
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
            + grid + area + line + dots + lastLbl + xlab + '</svg>';
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
                progPost({ exercise: sel.value, metric: card.metric, weeks: card.weeks }, wrap);
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

        // Summary line with trend direction/colour.
        var s = card.summary;
        var summary = document.createElement('div');
        summary.className = 'prog-summary ' + (s.delta > 0 ? 'up' : (s.delta < 0 ? 'down' : 'flat'));
        var arrow = s.delta > 0 ? '▲' : (s.delta < 0 ? '▼' : '■');
        var deltaTxt = (s.delta > 0 ? '+' : '') + progFmt(s.delta) + ' ' + card.unit
            + (s.pct ? ' (' + (s.pct > 0 ? '+' : '') + s.pct + '%)' : '');
        summary.innerHTML = '<span class="prog-metric">' + (PROG_METRIC_SHORT[card.metric] || card.metric) + '</span>'
            + '<span class="prog-delta">' + arrow + ' ' + progEsc(deltaTxt) + '</span>'
            + '<span class="prog-sessions">' + s.sessions + ' session' + (s.sessions === 1 ? '' : 's') + '</span>';
        wrap.appendChild(summary);

        var chart = document.createElement('div');
        chart.className = 'prog-chart';
        chart.innerHTML = progChartSvg(card);
        wrap.appendChild(chart);

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
        var best = document.createElement('div');
        best.className = 'prog-hint';
        best.textContent = 'Best: ' + progFmt(s.best) + ' ' + card.unit
            + ' · latest ' + progFmt(s.last) + ' ' + card.unit;
        wrap.appendChild(best);

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
                progPost({ exercise: card.exercise, metric: m.key, weeks: card.weeks }, wrap);
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
                progPost({ exercise: card.exercise, metric: card.metric, weeks: w }, wrap);
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

    // Expense/receipt card: editable draft with a single Confirm, or a saved view.
    function renderReceipt(card) {
        clearEmptyHint();
        var wrap = document.createElement('div');
        wrap.className = 'plan-card receipt-card';
        buildReceipt(wrap, card);
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    function buildReceipt(wrap, card) {
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
            dup.textContent = '⚠ Possible duplicate — you already logged '
                + (card.duplicate.vendor || 'this') + ' on ' + (card.duplicate.date || '')
                + (card.duplicate.confirmed ? '' : ' (a draft)') + '.';
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
                vatHint.textContent = '⚠ VAT isn\'t 25% — 25% of this total would be '
                    + fmtMoney(expected, cur) + '.';
            } else {
                vatHint.hidden = true;
            }
        }
        checkVat();

        if (confirmed) return;

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
                if (res && res.card) buildReceipt(wrap, res.card);
                else { confirmBtn.disabled = false; discardBtn.disabled = false; }
            }).catch(function () { confirmBtn.disabled = false; discardBtn.disabled = false; });
        });
        discardBtn.addEventListener('click', function () {
            if (!window.confirm('Discard this expense?')) return;
            receiptAction({ action: 'discard', id: card.id }).then(function (res) {
                if (res && res.deleted) wrap.remove();
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
            ph.textContent = '🧾';
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
            warn.textContent = '⚠ No clock-out for ' + f.day + (f.place ? ' @ ' + f.place : '')
                + ' (in at ' + f.in + '). Tell me when you left.';
            wrap.appendChild(warn);
        }

        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    }

    // Pick a weather glyph + animation class from cloud cover, rain, and day/night.
    // Returns { glyph, anim } where anim drives a small CSS animation.
    function wxSymbol(cloudPct, precipMm, isNight) {
        var p = (precipMm == null) ? 0 : precipMm;
        if (p >= 2)   return { glyph: '🌧️', anim: 'rain' };
        if (p >= 0.2) return { glyph: isNight ? '🌧️' : '🌦️', anim: 'rain' };
        if (cloudPct == null) return isNight ? { glyph: '🌙', anim: 'glow' } : { glyph: '☀️', anim: 'spin' };
        if (cloudPct >= 85) return { glyph: '☁️', anim: 'drift' };
        if (cloudPct >= 45) return isNight ? { glyph: '☁️', anim: 'drift' } : { glyph: '⛅', anim: 'drift' };
        return isNight ? { glyph: '🌙', anim: 'glow' } : { glyph: '☀️', anim: 'spin' };
    }

    function wxSymbolEl(cloudPct, precipMm, isNight, cls) {
        var s = wxSymbol(cloudPct, precipMm, isNight);
        var el = document.createElement('span');
        el.className = (cls || 'wx-sym') + ' wx-' + s.anim;
        el.textContent = s.glyph;
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
            if (c.wind_ms != null) bits.push('💨 ' + Math.round(c.wind_ms) + ' m/s' + (c.wind_from ? ' ' + c.wind_from : ''));
            if (c.humidity_pct != null) bits.push('💧 ' + Math.round(c.humidity_pct) + '%');
            if (c.precip_mm != null && c.precip_mm > 0) bits.push('🌧️ ' + c.precip_mm + ' mm');
            if (bits.length) {
                var stats = document.createElement('div');
                stats.className = 'wx-now-stats';
                stats.textContent = bits.join('   ');
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
                if (d.precip_mm != null && d.precip_mm > 0) ex.push('🌧️ ' + d.precip_mm + ' mm');
                if (d.wind_max_ms != null) ex.push('💨 ' + Math.round(d.wind_max_ms));
                extra.textContent = ex.join('  ');
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
        clearSuggestions();                 // any pending quick-reply chips are now moot
        // Keep the button enabled but turn it into a Stop control.
        sendController = new AbortController();
        setSendStopMode(true);
        const wasNewConversation = !conversationId;
        addMessage(text, 'user');

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

        try {
            const res = await fetch('/api/chat.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    message: text,
                    conversation_id: conversationId || undefined,
                    location: location || undefined,
                }),
                signal: sendController ? sendController.signal : undefined,
            });

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
            addMessage(data.reply || '(no reply)', 'assistant', data.reply_html);
            speak(data.reply || '');
            if (data.card) renderCard(data.card);
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
                (data.messages || []).forEach(function (m) {
                    if (m.role === 'assistant') {
                        addMessage(m.content, 'assistant', m.html);
                        if (m.card) renderCard(m.card); // re-show the interactive widget
                    } else {
                        addMessage(m.content, 'user');
                    }
                });
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
        // Menu item: glyph + label (iOS ignores CSS color on emoji, so swap the glyph).
        ttsBtn.textContent = ttsOn ? '🔊 Voice on — tap to mute' : '🔇 Read replies aloud';
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
    // Restore the last conversation's messages on load (they persist server-side),
    // so a reload lands you back where you left off. Falls back to a fresh screen.
    if (conversationId) {
        loadConversation(conversationId).catch(function () {
            conversationId = null;
            localStorage.removeItem(CONV_KEY);
            showEmptyHint();
        });
    } else {
        showEmptyHint();
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

            function refreshMaster() {
                currentSubscription().then(function (sub) {
                    masterSwitch.checkbox.checked = !!sub;
                    testBtn.disabled = !sub;
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
