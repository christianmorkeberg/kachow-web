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

    async function send(text) {
        if (busy || !text.trim()) return;
        busy = true;
        sendBtn.disabled = true;
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
            if (data.card) renderCard(data.card);
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
})();
