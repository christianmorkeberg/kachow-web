<?php

declare(strict_types=1);

/**
 * "Kachow in action" for the recruiter page: the REAL app.js and styles.css render one real card, with fictional data from assets/demo-live.js standing in for
 * every /api/ call. No session, no database, nothing of anyone's data. Shown in an iframe by meet.js: /demo.php?card=home|routines|mileage|shopping|books
 */

$cards = ['home', 'routines', 'mileage', 'shopping', 'books'];
$card  = in_array($_GET['card'] ?? '', $cards, true) ? (string) $_GET['card'] : 'home';

function asset(string $path): string
{
    $path = '/assets/' . ltrim($path, '/');

    return $path . '?v=' . (@filemtime(__DIR__ . $path) ?: time());
}

header('Cache-Control: no-cache');

// app.js looks up ~65 elements of the full app shell by id; the ones this page does not draw get a hidden stand-in, so the real script starts unchanged.
$have = ['messages', 'workspace', 'cardPanel', 'cardPanelHead', 'cardPanelTitle', 'cardPanelSub', 'cardPanelRefresh', 'cardPanelExpand', 'cardPanelToggle', 'cardPanelClose', 'cardPanelBody', 'cardRail', 'composer', 'input', 'send'];
preg_match_all("/getElementById\\('([A-Za-z0-9_-]+)'\\)/", (string) file_get_contents(__DIR__ . '/assets/app.js'), $m);
$stubs = array_values(array_diff(array_unique($m[1]), $have));
?>
<!DOCTYPE html>
<html lang="en" data-demo>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Kachow demo</title>
    <link rel="stylesheet" href="<?= asset('styles.css') ?>">
    <style>
        html, body { height: auto; min-height: 0; overflow: visible; background: transparent; }
        .app, .workspace { display: block; height: auto; min-height: 0; }
        .topbar, .composer, .card-rail, .ws-divider, .modal, .banner { display: none !important; }
        #messages { padding: 0; overflow: visible; height: auto; }
        #cardPanel { display: none !important; }
    </style>
    <script src="<?= asset('demo-live.js') ?>"></script>
</head>
<body>
    <div class="app">
        <div class="workspace" id="workspace">
            <main id="messages" class="messages"></main>
            <section id="cardPanel" class="card-panel" data-state="hidden" hidden>
                <div class="card-panel-head" id="cardPanelHead"><span class="cp-title" id="cardPanelTitle"></span><span class="cp-sub" id="cardPanelSub"></span>
                    <button type="button" id="cardPanelRefresh"></button><button type="button" id="cardPanelExpand"></button><button type="button" id="cardPanelToggle"></button><button type="button" id="cardPanelClose"></button></div>
                <div class="card-panel-body" id="cardPanelBody"></div>
            </section>
            <nav class="card-rail" id="cardRail"></nav>
            <form id="composer" class="composer"><textarea id="input"></textarea><button type="submit" id="send"></button></form>
        </div>
    </div>
    <div hidden><?php foreach ($stubs as $id) { echo '<div id="' . htmlspecialchars($id, ENT_QUOTES) . '"></div>'; } ?></div>
    <script src="<?= asset('icons.js') ?>"></script>
    <script src="<?= asset('power-chart.js') ?>"></script>
    <script src="<?= asset('workout-timer.js') ?>"></script>
    <script src="<?= asset('app.js') ?>"></script>
    <script>
        window.addEventListener('load', function () {
            var card = window.KACHOW_DEMO_CARDS[<?= json_encode($card) ?>];
            setTimeout(function () { if (window.kachowDemo && card) window.kachowDemo.renderCard(JSON.parse(JSON.stringify(card))); }, 900);   // after the app's own start-up has drawn (and cleared) its empty hint
            function size() { try { parent.postMessage({ kachowDemoHeight: document.documentElement.scrollHeight, card: <?= json_encode($card) ?> }, location.origin); } catch (e) { /* not framed */ } }
            setTimeout(size, 1500); setTimeout(size, 2600);
            new MutationObserver(size).observe(document.body, { childList: true, subtree: true, attributes: true });
        });
    </script>
</body>
</html>
