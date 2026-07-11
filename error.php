<?php

declare(strict_types=1);

/**
 * Fun, self-contained animated error pages (Ka-Chow racing theme). Each status
 * code gets its own little scene. Pure static HTML/CSS — no app dependencies —
 * so it renders even when the app itself is broken (500).
 *
 * The code comes from Apache's REDIRECT_STATUS on an ErrorDocument include;
 * ?code=NNN can be used to preview a page directly.
 */

$code = (int) ($_SERVER['REDIRECT_STATUS'] ?? 0);
if ($code < 400 && isset($_GET['code'])) {
    $code = (int) $_GET['code'];
}
if ($code < 400 || $code > 599) {
    $code = 500;
}

// code => [scene, title, message]
$pages = [
    400 => ['spun',   'Came In Sideways',  'That request spun out — it didn\'t make sense.'],
    401 => ['gate',   'Pit Pass Required', 'Barrier\'s down — you need to sign in to come through.'],
    403 => ['noentry','Road Closed',       'No entry — this stretch of track is off-limits to you.'],
    404 => ['lost',   'Wrong Turn',        'You\'re off the map — there\'s nothing out here.'],
    429 => ['police', 'Slow Down, Racer!', 'Easy on the gas — you\'re sending requests too fast.'],
    500 => ['broken', 'Engine Trouble',    'Something blew a gasket under the hood. We\'re on it.'],
    503 => ['pit',    'In the Pits',       'Quick pit stop — we\'ll be back on the track shortly.'],
];
$fallback = ['broken', 'Off the Track', 'Something went sideways.'];
[$scene, $title, $msg] = $pages[$code] ?? $fallback;

http_response_code($code);
header('Content-Type: text/html; charset=utf-8');
$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title><?= $code ?> — <?= $e($title) ?> · Kachow</title>
    <meta name="robots" content="noindex">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='88'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E">
    <style>
        :root {
            --bg:#0f172a; --bg2:#0a1122; --ink:#e6edf7; --muted:#93a3bd;
            --accent:#38bdf8; --red:#e01e2b; --red2:#ff3b30;
        }
        * { box-sizing:border-box; margin:0; padding:0; }
        html,body { height:100%; }
        body {
            background: radial-gradient(120% 90% at 50% 0%, #16233f 0%, var(--bg) 55%, var(--bg2) 100%) fixed;
            color:var(--ink); font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
            min-height:100dvh; display:grid; place-items:center; overflow:hidden; text-align:center;
        }
        .wrap { position:relative; width:100%; max-width:640px; padding:24px; z-index:2; }
        .brand { position:fixed; top:16px; left:0; right:0; font-weight:800; color:var(--muted); z-index:2; }

        /* speed streaks */
        .streaks { position:fixed; inset:0; z-index:1; overflow:hidden; pointer-events:none; }
        .streak { position:absolute; height:3px; border-radius:3px;
            background:linear-gradient(90deg,transparent,rgba(56,189,248,.35)); animation:fly linear infinite; }
        @keyframes fly { from{transform:translateX(110vw);} to{transform:translateX(-30vw);} }

        .code { font-size:clamp(5rem,26vw,10rem); font-weight:900; line-height:.9; letter-spacing:-.02em;
            background:linear-gradient(180deg,#fff,var(--accent)); -webkit-background-clip:text; background-clip:text;
            color:transparent; animation:jitter 2.6s ease-in-out infinite; }
        @keyframes jitter { 0%,92%,100%{transform:translate(0,0) rotate(0);}
            94%{transform:translate(-2px,1px) rotate(-.4deg);} 96%{transform:translate(2px,-1px) rotate(.4deg);} }
        h1 { font-size:clamp(1.3rem,5.5vw,2rem); font-weight:800; margin-top:2px; }
        p.msg { color:var(--muted); margin-top:10px; font-size:clamp(1rem,3.6vw,1.12rem); }
        .btn { display:inline-block; margin-top:22px; padding:12px 22px; background:var(--accent); color:#05263a;
            font-weight:700; border-radius:12px; text-decoration:none; box-shadow:0 8px 20px rgba(56,189,248,.25);
            transition:transform .15s ease; }
        .btn:hover { transform:translateY(-2px); }

        /* ---- shared stage + road ---- */
        .stage { position:relative; height:150px; margin:14px auto 4px; width:280px; }
        .road { position:absolute; left:-40vw; right:-40vw; bottom:26px; height:3px;
            background:repeating-linear-gradient(90deg,#24314f 0 26px,transparent 26px 52px); }
        .stage.moving .road { animation:road .5s linear infinite; }
        @keyframes road { to { background-position-x:-52px; } }

        /* ---- car (reused, recolourable) ---- */
        .car { position:absolute; bottom:26px; width:150px; height:66px; filter:drop-shadow(0 10px 12px rgba(0,0,0,.5)); }
        .car .body { position:absolute; bottom:11px; left:0; width:150px; height:30px;
            background:linear-gradient(180deg,var(--red2),var(--red) 70%,#a10e1a);
            border-radius:20px 24px 9px 11px; box-shadow:inset 0 3px 6px rgba(255,255,255,.35),inset 0 -6px 10px rgba(0,0,0,.35); }
        .car .cabin { position:absolute; bottom:30px; left:40px; width:64px; height:25px;
            background:linear-gradient(180deg,var(--red2),var(--red)); border-radius:14px 28px 0 0; }
        .car .glass { position:absolute; bottom:32px; left:48px; width:45px; height:18px;
            background:linear-gradient(180deg,#bfe4ff,#4a86b8); border-radius:9px 18px 0 0; }
        .car .wheel { position:absolute; bottom:0; width:26px; height:26px; background:#0e0e10;
            border:5px solid #2a2a2e; border-radius:50%; box-shadow:inset 0 0 0 3px #17171a; }
        .car .wheel.back{ left:20px; } .car .wheel.front{ right:20px; }
        .car .wheel::after { content:""; position:absolute; inset:3px; border-radius:50%;
            background:conic-gradient(from 0deg,#6b6b70 0 25%,#34343a 0 50%,#6b6b70 0 75%,#34343a 0); }
        .spin .wheel::after { animation:spin .22s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .idle { animation:idle .18s ease-in-out infinite; }
        @keyframes idle { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-1.5px);} }

        /* police livery + light bar (429) */
        .car.cop .body { background:linear-gradient(180deg,#3b82f6,#1e50a0 70%,#143a78); }
        .car.cop .cabin { background:linear-gradient(180deg,#eef3ff,#c7d6f0); }
        .lightbar { position:absolute; bottom:55px; left:52px; width:44px; height:10px; border-radius:3px; overflow:hidden;
            box-shadow:0 0 12px rgba(255,255,255,.4); }
        .lightbar span { position:absolute; top:0; width:50%; height:100%; }
        .lightbar .l { left:0; background:#ff2d2d; animation:flash .6s steps(1) infinite; }
        .lightbar .r { right:0; background:#2d6bff; animation:flash .6s steps(1) infinite; animation-delay:.3s; }
        @keyframes flash { 0%,50%{opacity:1;} 50.01%,100%{opacity:.15;} }
        .ticket { position:absolute; bottom:34px; right:-8px; font-size:28px; animation:wave 1.4s ease-in-out infinite; }
        @keyframes wave { 0%,100%{transform:rotate(-6deg);} 50%{transform:rotate(10deg);} }

        /* smoke (500) */
        .smoke span { position:absolute; bottom:44px; left:46px; width:16px; height:16px; border-radius:50%;
            background:rgba(150,160,180,.55); animation:smoke 1.6s ease-out infinite; }
        .smoke span:nth-child(2){ left:58px; animation-delay:.5s; } .smoke span:nth-child(3){ left:52px; animation-delay:1s; }
        @keyframes smoke { 0%{transform:translate(0,0) scale(.5); opacity:.7;} 100%{transform:translate(-8px,-70px) scale(2.4); opacity:0;} }

        /* boom barrier (401) */
        .barrier { position:absolute; bottom:26px; right:70px; width:10px; height:64px; }
        .barrier .post { position:absolute; bottom:0; left:0; width:10px; height:64px; border-radius:3px;
            background:linear-gradient(#e5eaf2,#aab4c6); }
        .barrier .arm { position:absolute; bottom:52px; left:8px; width:120px; height:11px; border-radius:3px;
            transform-origin:left center; background:repeating-linear-gradient(-45deg,var(--red) 0 13px,#fff 13px 26px);
            box-shadow:0 2px 4px rgba(0,0,0,.4); animation:gate 3s ease-in-out infinite; }
        @keyframes gate { 0%,70%{transform:rotate(0);} 85%,100%{transform:rotate(-12deg);} }
        .barrier .lamp { position:absolute; top:-6px; left:2px; width:8px; height:8px; border-radius:50%;
            background:#ff2d2d; box-shadow:0 0 8px #ff2d2d; animation:flash 1s steps(1) infinite; }

        /* no-entry sign + cones (403) */
        .noentry { position:absolute; bottom:60px; left:50%; transform:translateX(-50%); width:70px; height:70px;
            border-radius:50%; background:var(--red); box-shadow:0 6px 14px rgba(0,0,0,.4), inset 0 0 0 5px #fff;
            animation:idle .4s ease-in-out infinite; }
        .noentry::after { content:""; position:absolute; top:50%; left:16px; right:16px; height:11px; margin-top:-5px;
            background:#fff; border-radius:2px; }
        .props { position:absolute; bottom:20px; left:0; right:0; font-size:30px; letter-spacing:14px; }

        /* signpost + tumbleweed (404) */
        .signpost { position:absolute; bottom:26px; left:50%; transform:translateX(-50%); width:12px; height:96px; }
        .signpost .pole { position:absolute; bottom:0; left:3px; width:6px; height:96px; background:linear-gradient(#7c5c3a,#5b4127); }
        .signpost .sign { position:absolute; padding:5px 12px; background:#e8eefb; color:#213; font-weight:800; font-size:12px;
            border-radius:3px; white-space:nowrap; box-shadow:0 3px 6px rgba(0,0,0,.4); animation:sway 3.5s ease-in-out infinite; }
        .signpost .s1 { top:8px; left:8px; } .signpost .s2 { top:34px; right:8px; animation-delay:.6s; }
        @keyframes sway { 0%,100%{transform:rotate(-2deg);} 50%{transform:rotate(2deg);} }
        .map { position:absolute; bottom:96px; left:50%; transform:translateX(-50%); font-size:34px; animation:idle .6s ease-in-out infinite; }
        .tumble { position:absolute; bottom:22px; left:0; font-size:26px; animation:tumble 4s linear infinite; }
        @keyframes tumble { from{ transform:translateX(-40px) rotate(0);} to{ transform:translateX(300px) rotate(720deg);} }

        /* pit stop (503) */
        .tools { position:absolute; bottom:20px; left:0; right:0; font-size:28px; letter-spacing:10px; animation:idle .5s ease-in-out infinite; }

        @media (prefers-reduced-motion:reduce) {
            .code,.car,.idle,.spin .wheel::after,.smoke span,.barrier .arm,.barrier .lamp,.lightbar span,
            .ticket,.noentry,.signpost .sign,.map,.tumble,.tools,.stage.moving .road { animation:none !important; }
            .streaks { display:none; }
        }
    </style>
</head>
<body>
    <div class="brand">⚡ Kachow</div>
    <div class="streaks" aria-hidden="true">
        <span class="streak" style="top:18%; width:180px; animation-duration:1.4s;"></span>
        <span class="streak" style="top:34%; width:120px; animation-duration:2.1s; animation-delay:.4s; opacity:.6;"></span>
        <span class="streak" style="top:66%; width:220px; animation-duration:1.1s; animation-delay:.8s;"></span>
        <span class="streak" style="top:80%; width:90px;  animation-duration:2.6s; animation-delay:.2s; opacity:.5;"></span>
    </div>

    <main class="wrap">
        <div class="code"><?= $code ?></div>

        <div class="stage <?= in_array($scene, ['broken', 'spun'], true) ? '' : 'moving' ?>" aria-hidden="true">
            <div class="road"></div>
            <?php
            $carRed = '<div class="body"></div><div class="cabin"></div><div class="glass"></div>'
                . '<div class="wheel back"></div><div class="wheel front"></div>';
            switch ($scene):
                case 'gate': // 401 — car stopped at a boom barrier ?>
                    <div class="car idle" style="left:20px;"><?= $carRed ?></div>
                    <div class="barrier"><div class="post"></div><div class="arm"></div><div class="lamp"></div></div>
                    <?php break;
                case 'noentry': // 403 — no-entry sign + cones ?>
                    <div class="noentry"></div>
                    <div class="props">🚧 🚧</div>
                    <?php break;
                case 'lost': // 404 — signpost, map, tumbleweed ?>
                    <div class="map">🗺️</div>
                    <div class="signpost"><div class="pole"></div>
                        <div class="sign s1">◀ NOWHERE</div><div class="sign s2">SOMEWHERE ▶</div></div>
                    <div class="tumble">🌾</div>
                    <?php break;
                case 'police': // 429 — police car, flashing lights, ticket ?>
                    <div class="car cop idle spin" style="left:50%; transform:translateX(-50%);">
                        <?= $carRed ?>
                        <div class="lightbar"><span class="l"></span><span class="r"></span></div>
                        <div class="ticket">🎫</div>
                    </div>
                    <?php break;
                case 'pit': // 503 — car up for a pit stop ?>
                    <div class="car idle" style="left:50%; transform:translateX(-50%);"><?= $carRed ?></div>
                    <div class="tools">🔧 🛞</div>
                    <?php break;
                case 'spun': // 400 — spun-out car ?>
                    <div class="car" style="left:50%; transform:translateX(-50%) rotate(18deg);"><?= $carRed ?></div>
                    <?php break;
                default: // 500 / fallback — broken down with smoke ?>
                    <div class="car" style="left:50%; transform:translateX(-50%);"><?= $carRed ?></div>
                    <div class="smoke"><span></span><span></span><span></span></div>
            <?php endswitch; ?>
        </div>

        <h1><?= $e($title) ?></h1>
        <p class="msg"><?= $e($msg) ?></p>

        <?php if ($code === 401): ?>
            <a class="btn" href="/index.php">Sign in</a>
        <?php else: ?>
            <a class="btn" href="/">⚡ Back to the track</a>
        <?php endif; ?>
    </main>
</body>
</html>
