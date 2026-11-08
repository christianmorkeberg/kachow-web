// "Kachow in action" for the recruiter page: the REAL app.js renders the REAL cards here, but every /api/ call is answered from this file with FICTIONAL data
// (nothing of anyone's real data, no server, no database). Loaded by demo.php before app.js. Taps work; changes are not saved anywhere.
(function () {
    'use strict';
    var J = function (o) { return Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } })); };

    var lights = [
        { name: 'Living room', on: true, group_id: 'g1', brightness: 60, lights: [{ id: 'a1', name: 'Reading lamp', on: true, brightness: 70, color: null }, { id: 'a2', name: 'Floor lamp', on: true, brightness: 55 }, { id: 'a3', name: 'Window lamp', on: false }] },
        { name: 'Bedroom', on: false, group_id: 'g2', brightness: 30, lights: [{ id: 'b1', name: 'Bedside lamp', on: false }, { id: 'b2', name: 'Ceiling light', on: false }] }
    ];
    var valves = [
        { id: 200, name: 'Living room', room: 'Living room', current_c: 21.0, target_c: 20.5, valve_open_pct: 0, last_heard_minutes_ago: 2, set_state: 'confirmed', set_target: 20.5 },
        { id: 201, name: 'Bedroom', room: 'Bedroom', current_c: 18.5, target_c: 17, valve_open_pct: 35, last_heard_minutes_ago: 1, set_state: 'confirmed', set_target: 17 }
    ];

    var CARDS = {
        home: { kind: 'home', title: 'Home' },
        routines: { kind: 'scheduled_tasks', places: [], requests: [], system: [], items: [
            { id: 1, label: 'Turn off lights when leaving home', status: 'active', schedule: 'Leaving Home', tell_always: true, routine: true, run_mode: 'auto', instruction: 'Check if any lights are on. If so, notify me and offer to turn them off.' },
            { id: 2, label: 'Weekday morning: invoices in my mail', status: 'active', schedule: 'Every weekday at 08:00', next_run: 'Mon 9 Nov, 08:00', tell_always: false, run_mode: 'auto', instruction: 'Check my mail for new invoices and tell me what is new.' },
            { id: 3, label: 'Water the plants', status: 'paused', schedule: 'Every Sunday at 10:00', run_mode: 'auto', instruction: 'Remind me to water the plants.' }] },
        shopping: { kind: 'shopping_list', title: 'Groceries', list_id: 3, grouping: 'auto', groups: [{ key: 'dairy', icon: 'cup-soda', en: 'Dairy', da: 'Mejeri' }, { key: 'produce', icon: 'apple', en: 'Fruit & veg', da: 'Frugt og grønt' }, { key: 'pantry', icon: 'package', en: 'Pantry', da: 'Kolonial' }], items: [
            { id: 1, label: 'Milk', done: false, category: 'dairy' }, { id: 2, label: 'Greek yoghurt', done: false, category: 'dairy' }, { id: 3, label: 'Tomatoes', done: false, category: 'produce' },
            { id: 4, label: 'Spinach', done: false, category: 'produce' }, { id: 5, label: 'Rice', done: false, category: 'pantry' }, { id: 6, label: 'Olive oil', done: true, category: 'pantry' }] },
        books: { kind: 'cash', currency: 'DKK', expected: 84250, free_to_spend: 52100, reserve: { total: 32150, moms: 14000, tax: 18150, pct: 38 }, money_in: { invoices_paid: 140000, other: 0, total: 140000 }, money_out: { expenses: 30000, draws: 25750, other: 0, total: 55750 }, refund_expected: 0, opening: 0 },
        mileage: { kind: 'mileage', currency: 'DKK', period_label: '2026', offset: 0, can_next: false, business: { amount: 6840, days: 21 }, commuter: { amount: 9120, days: 96 },
            suggestions: [{ date: '2026-11-06', route: 'Home → Client site', km: 42, gps_km: 41.6, label: 'Fri 6 Nov', destination_id: 1, place_id: 1, type: 'business', needs_link: false },
                          { date: '2026-11-05', route: 'Home → Campus', km: 36, gps_km: 35.8, label: 'Thu 5 Nov', destination_id: 2, place_id: 2, type: 'commute', needs_link: false }],
            destinations: [{ id: 1, name: 'Client site', type: 'business', round_trip: 42, counter: { business_used: 21, limit: 60, remaining: 39, commuting_now: false } }, { id: 2, name: 'Campus', type: 'commute', round_trip: 36 }], trips: [] }
    };
    window.KACHOW_DEMO_CARDS = CARDS;

    var real = window.fetch.bind(window);
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/') === -1) return real(input, init);
        var post = init && init.method && init.method.toUpperCase() === 'POST';
        if (url.indexOf('home.php') !== -1) {
            if (url.indexOf('part=lights') !== -1) return J({ ok: true, rooms: lights, other: [], thermostats_known: [] });
            if (url.indexOf('part=thermostats') !== -1) return J({ ok: true, thermostats: valves, cached_at: 1 });
            if (url.indexOf('part=valvestatus') !== -1) return J({ ok: true, sets: {} });
            if (post && init.body) {                     // a tap on a radiator: pretend it is sent, then confirmed
                try { var b = JSON.parse(init.body); if (b && b.id != null && b.target_c != null) valves.forEach(function (v) { if (v.id === b.id) { v.target_c = v.set_target = b.target_c; } }); } catch (e) { /* ignore */ }
            }
            return J({ ok: true });
        }
        if (url.indexOf('settings.php') !== -1) return J({ ok: true, settings: {} });
        if (url.indexOf('scheduled-tasks.php') !== -1 && !post) return J({ ok: true, card: CARDS.routines });
        if (url.indexOf('mileage.php') !== -1 && !post) return J({ ok: true, card: CARDS.mileage });
        if (url.indexOf('cash.php') !== -1 || url.indexOf('card.php?for=cash') !== -1) return J({ ok: true, card: CARDS.books });
        return J({ ok: true, cards: [], items: [] });
    };
})();
