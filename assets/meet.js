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
            note: 'You are chatting with <strong>Kachow, an AI assistant</strong> that {owner} built.',
            aboutSummary: 'About this assistant',
            aboutBody: "I'm an AI assistant that {owner} built, and I only know what {owner} has chosen to tell me. When I don't know something I'll say so, and you can leave {owner} a message. I don't discuss salary, availability details or contact information — {owner} will do that personally. Questions I couldn't answer are noted for {owner}. This chat is stored for 14 days.",
            placeholder: 'Ask about {owner}…',
            hello: "Hi there, I'm Kachow, {owner}'s AI assistant.{from} What would you like to know about {owner}? I can tell you about how {owner} built me, {owner}'s experience, or what {owner} is like as a colleague.",
            from: ' You must be from {company}?',
            helloRole: "I can see you're looking at the {role} role — ask me how {owner} fits, and where not.",
            themes: [
                { title: 'How I was built', q: ['How were you built?', 'What can you do?', 'How does the location tracking work?', 'Show me Kachow in action'] },
                { title: 'Experience', q: ['What has {owner} worked on?', "Tell me about {owner}'s research", "What are {owner}'s strongest skills?"] },
                { title: 'As a colleague', q: ['What is {owner} like to work with?', "What are {owner}'s weaknesses?", 'What kind of team does {owner} want?'] },
                { title: 'Fit', q: ['{fit}', 'What is {owner} looking for?'] }
            ],
            fitRole: 'Why could {owner} fit the {role} role?', fitGeneric: 'Why could {owner} be a good fit?', more: 'More questions', demoPrev: 'Previous', demoNext: 'Next', demoNote: 'Fictional demo data',
            leaveChip: 'Leave a message',
            leaveSummary: 'Leave a message for {owner}', leadName: 'Your name', leadContact: 'Email or phone', leadMessage: 'Your message', leadSend: 'Send', leadSending: 'Sending…',
            leadOk: 'Saved and passed on to {owner} — thank you!', leadErr: 'That did not go through. Please check the fields and try again.', leadMany: 'Several messages were already left today — {owner} has them and will be in touch.',
            left: '{n} messages left in this chat', full: 'This chat has reached its limit. Please leave {owner} a message below.',
            errNetwork: 'No connection — please try again.', errBusy: 'You are sending messages quickly — please wait a moment.', errModel: 'Sorry, I could not answer just now. Please try again.',
            goneTitle: 'This link is no longer active', goneText: 'Please contact {owner} directly — they will be glad to hear from you.', invalidTitle: 'This link is not valid', errorTitle: 'Something went wrong'
        },
        da: {
            sub: '{owner}s assistent',
            note: 'Du chatter med <strong>Kachow, en AI-assistent</strong> som {owner} har bygget.',
            aboutSummary: 'Om denne assistent',
            aboutBody: 'Jeg er en AI-assistent, som {owner} har bygget, og jeg ved kun det, {owner} har valgt at fortælle mig. Når jeg ikke ved noget, siger jeg det, og du kan efterlade en besked til {owner}. Jeg diskuterer ikke løn, detaljer om tiltrædelse eller kontaktoplysninger — det gør {owner} personligt. Spørgsmål, jeg ikke kunne svare på, noteres til {owner}. Denne chat gemmes i 14 dage.',
            placeholder: 'Spørg om {owner}…',
            hello: 'Hej, jeg er Kachow, {owner}s AI-assistent.{from} Hvad vil du gerne vide om {owner}? Jeg kan fortælle om, hvordan {owner} har bygget mig, om {owner}s erfaring, eller om, hvordan {owner} er som kollega.',
            from: ' Du er vel fra {company}?',
            helloRole: 'Jeg kan se, at du kigger på stillingen {role} — spørg mig, hvordan {owner} passer, og hvor ikke.',
            themes: [
                { title: 'Hvordan jeg er bygget', q: ['Hvordan er du bygget?', 'Hvad kan du?', 'Hvordan virker lokationssporingen?', 'Vis mig Kachow i aktion'] },
                { title: 'Erfaring', q: ['Hvad har {owner} arbejdet med?', 'Fortæl om {owner}s forskning', 'Hvad er {owner}s stærkeste kompetencer?'] },
                { title: 'Som kollega', q: ['Hvordan er {owner} at arbejde sammen med?', 'Hvad er {owner}s svagheder?', 'Hvilken slags team ønsker {owner}?'] },
                { title: 'Match', q: ['{fit}', 'Hvad leder {owner} efter?'] }
            ],
            fitRole: 'Hvorfor kunne {owner} passe til stillingen {role}?', fitGeneric: 'Hvorfor kunne {owner} være et godt match?', more: 'Flere spørgsmål', demoPrev: 'Forrige', demoNext: 'Næste', demoNote: 'Fiktive demodata',
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
    function t(k) { var v = S[lang][k]; return Array.isArray(v) ? v.map(function (x) { return typeof x === 'string' ? who(x) : x; }) : who(v); }
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
        var as = $('aboutSummary'); if (as) { as.textContent = t('aboutSummary'); $('aboutBody').textContent = t('aboutBody'); }
        if (input) input.placeholder = t('placeholder');
        var ls = $('leaveSummary'); if (ls) ls.textContent = t('leaveSummary');
        if ($('leadName')) { $('leadName').placeholder = t('leadName'); $('leadContact').placeholder = t('leadContact'); $('leadMessage').placeholder = t('leadMessage'); $('leadSend').textContent = t('leadSend'); }
        var gt = $('goneTitle'), gx = $('goneText');
        if (gt) gt.textContent = cfg.state === 'expired' || cfg.state === 'revoked' ? t('goneTitle') : (cfg.state === 'error' ? t('errorTitle') : t('invalidTitle'));
        if (gx) gx.textContent = t('goneText');
        drawChips(); drawLeft();
    }
    // The suggested questions, in four themes (how I was built / experience / as a colleague / fit): one tap asks the question.
    function drawChips() {
        if (!chips) return;
        chips.innerHTML = '';
        var fit = cfg.role ? t('fitRole').replace('{role}', cfg.role) : t('fitGeneric');
        // Few choices first: one question per theme; the rest sit behind "More questions".
        var first = document.createElement('div'); first.className = 'meet-chiprow';
        var rest = document.createElement('div'); rest.className = 'meet-chiprow meet-morerow'; rest.style.display = 'none';
        function chip(q, into) {
            var text = who(q.replace('{fit}', fit));
            var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', function () { ask(text); });
            into.appendChild(b);
        }
        t('themes').forEach(function (th) { th.q.forEach(function (q, i) { chip(q, i === 0 ? first : rest); }); });
        chips.appendChild(first);
        var more = document.createElement('button'); more.type = 'button'; more.className = 'meet-more'; more.textContent = t('more') + ' ▾';
        more.addEventListener('click', function () { var open = rest.style.display === 'none'; rest.style.display = open ? '' : 'none'; more.textContent = t('more') + (open ? ' ▴' : ' ▾'); });
        chips.appendChild(more); chips.appendChild(rest);
        var l = document.createElement('button'); l.type = 'button'; l.className = 'meet-leave'; l.textContent = t('leaveChip');
        l.addEventListener('click', function () { var d = $('leave'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { $('leadName').focus(); }, 300); });
        chips.appendChild(l);
    }
    function drawLeft() {
        if (!left) return;
        left.textContent = remaining > 0 ? t('left').replace('{n}', String(remaining)) : t('full');
        if (input) { input.disabled = remaining <= 0; send.disabled = remaining <= 0 || busy; }
    }
    var asked = false, demoRedraws = [];
    // Switching language redraws the texts around the chat and in the gallery; the conversation itself is never touched once it has started.
    $('lang').addEventListener('click', function () {
        lang = lang === 'en' ? 'da' : 'en';
        try { sessionStorage.setItem('meet-lang', lang); } catch (e) { /* ignore */ }
        applyStrings();
        demoRedraws.forEach(function (f) { f(); });
        if (chat && !asked && !chat.getAttribute('data-has-history')) intro();
    });

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
        var from = cfg.company ? t('from').replace('{company}', cfg.company) : '';
        var hello = t('hello').replace('{from}', from);
        bubble('bot', fmt(hello + (cfg.role ? '\n\n' + t('helloRole').replace('{role}', cfg.role) : '')));
        if (chips) chips.style.display = '';
    }

    // "Kachow in action": the screenshots the assistant chose to show (real cards, fictional data), as a small gallery with previous / next.
    function showDemo(slides) {
        if (!slides || !slides.length) return;
        var box = bubble('bot demo', '');
        var i = 0;
        var fig = document.createElement('figure'); fig.className = 'demo-fig';
        var img = document.createElement('img'); img.loading = 'lazy'; img.className = 'demo-img';
        var title = document.createElement('div'); title.className = 'demo-title';
        var cap = document.createElement('div'); cap.className = 'demo-cap';
        var nav = document.createElement('div'); nav.className = 'demo-nav';
        var prev = document.createElement('button'); prev.type = 'button';
        var next = document.createElement('button'); next.type = 'button';
        var pos = document.createElement('span'); pos.className = 'demo-pos';
        var note = document.createElement('div'); note.className = 'demo-note';
        function draw() {
            var s = slides[i];
            img.src = s.image; img.alt = s.title[lang] || s.title.en;
            title.textContent = s.title[lang] || s.title.en; cap.textContent = s.caption[lang] || s.caption.en;
            pos.textContent = (i + 1) + ' / ' + slides.length; prev.textContent = '‹ ' + t('demoPrev'); next.textContent = t('demoNext') + ' ›';
            prev.disabled = i === 0; next.disabled = i === slides.length - 1; note.textContent = t('demoNote');
        }
        prev.addEventListener('click', function () { if (i > 0) { i--; draw(); } });
        next.addEventListener('click', function () { if (i < slides.length - 1) { i++; draw(); } });
        img.addEventListener('click', function () { window.open(slides[i].image, '_blank', 'noopener'); });
        fig.appendChild(img); fig.appendChild(title); fig.appendChild(cap);
        if (slides.length > 1) { nav.appendChild(prev); nav.appendChild(pos); nav.appendChild(next); fig.appendChild(nav); }
        fig.appendChild(note);
        box.appendChild(fig);
        draw();
        demoRedraws.push(draw);
    }

    function api(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j || {} }; }); });
    }
    function ask(text) {
        text = (text || '').trim();
        if (!text || busy || remaining <= 0) return;
        asked = true;
        busy = true; drawLeft();
        bubble('me', '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>');
        if (chips) chips.style.display = 'none';
        var typing = bubble('bot typing', '<span>•</span><span>•</span><span>•</span>');
        api('/api/meet-chat.php', { token: cfg.token, message: text }).then(function (r) {
            typing.remove();
            if (r.status === 200 && r.j.ok) {
                bubble('bot', fmt(r.j.reply));
                if (r.j.demo) showDemo(r.j.demo);
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
