/* The recruiter page: the chat, the quick questions and the "leave a message" form. Framework-free; talks to /api/meet-chat.php and /api/meet-lead.php with the link's token. */
(function () {
    'use strict';
    var root = document.getElementById('meet');
    if (!root) return;
    var cfg = {};
    try { cfg = JSON.parse(root.getAttribute('data-config') || '{}'); } catch (e) { cfg = {}; }

    var S = {
        en: {
            sub: "{owner}'s assistant",
            note: 'You are chatting with <strong>Kachow, an AI assistant</strong> that {owner} built. It only knows what {owner} has told it, so it may not have every answer — and it can pass on a message. Conversations are stored for 14 days.',
            placeholder: 'Ask about {owner}…',
            hello: "Hi! I'm Kachow, {owner}'s AI assistant. Ask me about {owner}'s background, projects and research — or how I was built.",
            helloRole: "I can see you're looking at the {role}{at}. Ask me how {owner} fits — and where not.",
            chips: ['Why could {owner} be a good fit?', 'What has {owner} worked on?', "Tell me about {owner}'s research", 'How is Kachow built?'],
            leaveChip: 'Leave a message',
            leaveSummary: 'Leave a message for {owner}', leadName: 'Your name', leadContact: 'Email or phone', leadMessage: 'Your message', leadSend: 'Send', leadSending: 'Sending…',
            leadOk: 'Saved and passed on to {owner} — thank you!', leadErr: 'That did not go through. Please check the fields and try again.', leadMany: 'Several messages were already left today — {owner} has them and will be in touch.',
            left: '{n} messages left in this chat', full: 'This chat has reached its limit. Please leave {owner} a message below.',
            errNetwork: 'No connection — please try again.', errBusy: 'You are sending messages quickly — please wait a moment.', errModel: 'Sorry, I could not answer just now. Please try again.',
            goneTitle: 'This link is no longer active', goneText: 'Please contact {owner} directly — they will be glad to hear from you.', invalidTitle: 'This link is not valid', errorTitle: 'Something went wrong'
        },
        da: {
            sub: '{owner}s assistent',
            note: 'Du chatter med <strong>Kachow, en AI-assistent</strong> som {owner} har bygget. Den kender kun det, {owner} har fortalt den, så den har ikke altid svaret — men den kan give en besked videre. Samtaler gemmes i 14 dage.',
            placeholder: 'Spørg om {owner}…',
            hello: 'Hej! Jeg er Kachow, {owner}s AI-assistent. Spørg mig om {owner}s baggrund, projekter og forskning — eller om hvordan jeg er bygget.',
            helloRole: 'Jeg kan se, at du kigger på stillingen {role}{at}. Spørg mig, hvordan {owner} passer — og hvor ikke.',
            chips: ['Hvorfor kunne {owner} passe til stillingen?', 'Hvad har {owner} arbejdet med?', 'Fortæl om {owner}s forskning', 'Hvordan er Kachow bygget?'],
            leaveChip: 'Skriv en besked',
            leaveSummary: 'Skriv en besked til {owner}', leadName: 'Dit navn', leadContact: 'E-mail eller telefon', leadMessage: 'Din besked', leadSend: 'Send', leadSending: 'Sender…',
            leadOk: 'Gemt og givet videre til {owner} — tak!', leadErr: 'Det lykkedes ikke. Tjek felterne og prøv igen.', leadMany: 'Der er allerede lagt flere beskeder i dag — {owner} har dem og vender tilbage.',
            left: '{n} beskeder tilbage i denne chat', full: 'Denne chat har nået sin grænse. Skriv gerne en besked til {owner} nedenfor.',
            errNetwork: 'Ingen forbindelse — prøv igen.', errBusy: 'Du sender hurtigt — vent et øjeblik.', errModel: 'Beklager, jeg kunne ikke svare lige nu. Prøv igen.',
            goneTitle: 'Dette link er ikke længere aktivt', goneText: 'Kontakt gerne {owner} direkte — de vil gerne høre fra dig.', invalidTitle: 'Dette link er ikke gyldigt', errorTitle: 'Noget gik galt'
        }
    };
    var lang = 'en';
    try { lang = sessionStorage.getItem('meet-lang') || ((navigator.language || '').toLowerCase().indexOf('da') === 0 ? 'da' : 'en'); } catch (e) { /* default */ }
    function who(str) { return String(str).split('{owner}').join(cfg.owner || (lang === 'da' ? 'ejeren' : 'the owner')); }
    function t(k) { var v = S[lang][k]; return Array.isArray(v) ? v.map(who) : who(v); }
    function $(id) { return document.getElementById(id); }

    // ---- text → safe HTML (paragraphs, bullet lists, **bold**); everything is escaped first ----
    function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function fmt(text) {
        var out = [], list = null;
        String(text).split(/\r?\n/).forEach(function (line) {
            var m = /^\s*[-*•]\s+(.*)$/.exec(line);
            if (m) { if (!list) { list = []; out.push(list); } list.push(m[1]); return; }
            list = null;
            out.push(line);
        });
        var html = '', para = [];
        function flush() { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; } }
        out.forEach(function (x) {
            if (Array.isArray(x)) { flush(); html += '<ul>' + x.map(function (li) { return '<li>' + bold(li) + '</li>'; }).join('') + '</ul>'; }
            else if (x.trim() === '') flush();
            else para.push(bold(x));
        });
        flush();
        return html;
    }
    function bold(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }

    var chat = $('chat'), form = $('form'), input = $('input'), send = $('send'), left = $('left'), chips = $('chips'), busy = false, remaining = cfg.remaining || 0;

    function applyStrings() {
        document.documentElement.lang = lang;
        $('sub').textContent = t('sub');
        $('lang').textContent = lang === 'en' ? 'DA' : 'EN';
        var note = $('note'); if (note) note.innerHTML = t('note');
        if (input) input.placeholder = t('placeholder');
        var ls = $('leaveSummary'); if (ls) ls.textContent = t('leaveSummary');
        if ($('leadName')) { $('leadName').placeholder = t('leadName'); $('leadContact').placeholder = t('leadContact'); $('leadMessage').placeholder = t('leadMessage'); $('leadSend').textContent = t('leadSend'); }
        var gt = $('goneTitle'), gx = $('goneText');
        if (gt) gt.textContent = cfg.state === 'expired' || cfg.state === 'revoked' ? t('goneTitle') : (cfg.state === 'error' ? t('errorTitle') : t('invalidTitle'));
        if (gx) gx.textContent = t('goneText');
        drawChips(); drawLeft();
    }
    function drawChips() {
        if (!chips) return;
        chips.innerHTML = '';
        t('chips').forEach(function (q) { var b = document.createElement('button'); b.type = 'button'; b.textContent = q; b.addEventListener('click', function () { ask(q); }); chips.appendChild(b); });
        var l = document.createElement('button'); l.type = 'button'; l.textContent = t('leaveChip');
        l.addEventListener('click', function () { var d = $('leave'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { $('leadName').focus(); }, 300); });
        chips.appendChild(l);
    }
    function drawLeft() {
        if (!left) return;
        left.textContent = remaining > 0 ? t('left').replace('{n}', String(remaining)) : t('full');
        if (input) { input.disabled = remaining <= 0; send.disabled = remaining <= 0 || busy; }
    }
    $('lang').addEventListener('click', function () { lang = lang === 'en' ? 'da' : 'en'; try { sessionStorage.setItem('meet-lang', lang); } catch (e) { /* ignore */ } applyStrings(); if (chat && !chat.getAttribute('data-has-history')) intro(); });

    function bubble(kind, html) {
        var d = document.createElement('div');
        d.className = 'msg ' + kind;
        d.innerHTML = html;
        chat.appendChild(d);
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        return d;
    }
    function intro() {
        if (!chat) return;
        chat.innerHTML = '';
        var hello = t('hello');
        if (cfg.role) hello += ' ' + t('helloRole').replace('{role}', cfg.role).replace('{at}', cfg.company ? (lang === 'da' ? ' hos ' : ' at ') + cfg.company : '');
        bubble('bot', fmt(hello));
    }

    function api(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j || {} }; }); });
    }
    function ask(text) {
        text = (text || '').trim();
        if (!text || busy || remaining <= 0) return;
        busy = true; drawLeft();
        bubble('me', '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>');
        if (chips) chips.style.display = 'none';
        var typing = bubble('bot typing', '<span>•</span><span>•</span><span>•</span>');
        api('/api/meet-chat.php', { token: cfg.token, message: text }).then(function (r) {
            typing.remove();
            if (r.status === 200 && r.j.ok) {
                bubble('bot', fmt(r.j.reply));
                if (typeof r.j.remaining === 'number') remaining = r.j.remaining;
            } else if (r.status === 429 && r.j.error === 'full') { remaining = 0; bubble('err', esc(t('full'))); }
            else if (r.status === 429) { bubble('err', esc(t('errBusy'))); }
            else { bubble('err', esc(t('errModel'))); }
        }).catch(function () { typing.remove(); bubble('err', esc(t('errNetwork'))); }).then(function () { busy = false; drawLeft(); if (input) input.focus(); });
    }

    if (form) {
        form.addEventListener('submit', function (e) { e.preventDefault(); var v = input.value; input.value = ''; autogrow(); ask(v); });
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
        input.addEventListener('input', autogrow);
    }
    function autogrow() { if (!input) return; input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; }

    var lead = $('leaveForm');
    if (lead) {
        lead.addEventListener('submit', function (e) {
            e.preventDefault();
            var st = $('leadStatus'), btn = $('leadSend');
            btn.disabled = true; st.className = ''; st.textContent = t('leadSending');
            api('/api/meet-lead.php', { token: cfg.token, name: $('leadName').value, contact: $('leadContact').value, message: $('leadMessage').value, website: $('leadWebsite').value }).then(function (r) {
                if (r.status === 200 && r.j.ok) { st.className = 'ok'; st.textContent = t('leadOk'); lead.reset(); }
                else if (r.status === 429) { st.className = 'err'; st.textContent = t('leadMany'); }
                else { st.className = 'err'; st.textContent = t('leadErr'); }
            }).catch(function () { st.className = 'err'; st.textContent = t('errNetwork'); }).then(function () { btn.disabled = false; });
        });
    }

    applyStrings();
    if (cfg.token && chat) {
        fetch('/api/meet-chat.php?t=' + encodeURIComponent(cfg.token)).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.ok && j.messages && j.messages.length) {
                chat.setAttribute('data-has-history', '1');
                chat.innerHTML = '';
                j.messages.forEach(function (m) { bubble(m.role === 'user' ? 'me' : 'bot', m.role === 'user' ? '<p>' + esc(m.content).replace(/\n/g, '<br>') + '</p>' : fmt(m.content)); });
                if (chips) chips.style.display = 'none';
                if (typeof j.remaining === 'number') { remaining = j.remaining; drawLeft(); }
            } else intro();
        }).catch(intro);
    }
})();
