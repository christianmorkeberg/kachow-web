<?php

declare(strict_types=1);

/**
 * Fun, self-contained animated error page (Ka-Chow racing theme). Wired via
 * .htaccess ErrorDocument for 400/401/403/404/500/503. Pure static HTML/CSS —
 * no app dependencies — so it renders even when the app itself is broken (500).
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

// Per-code copy. "smoke" swaps the exhaust for engine smoke (server faults).
$pages = [
    400 => ['title' => 'Bad Request',        'msg' => 'That one came in sideways — the request didn\'t make sense.', 'smoke' => false],
    401 => ['title' => 'Pit Pass Required',   'msg' => 'You need to sign in before you can come through here.',        'smoke' => false],
    403 => ['title' => 'Track Closed',        'msg' => 'This stretch of road is off-limits to you.',                   'smoke' => false],
    404 => ['title' => 'Wrong Turn',          'msg' => 'Nothing out here — this page took a wrong turn.',              'smoke' => false],
    500 => ['title' => 'Engine Trouble',      'msg' => 'Something blew a gasket under the hood. We\'re on it.',        'smoke' => true],
    503 => ['title' => 'In the Pits',         'msg' => 'Quick pit stop — back on the track in a moment.',              'smoke' => true],
];
$p     = $pages[$code] ?? ['title' => 'Off the Track', 'msg' => 'Something went sideways.', 'smoke' => $code >= 500];
$smoke = $p['smoke'];
$isAuth = $code === 401 || $code === 403;

http_response_code($code);
header('Content-Type: text/html; charset=utf-8');
$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title><?= $code ?> — <?= $e($p['title']) ?> · Kachow</title>
    <meta name="robots" content="noindex">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='88'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E">
    <style>
        :root {
            --bg: #0f172a; --bg2: #0a1122; --ink: #e6edf7; --muted: #93a3bd;
            --accent: #38bdf8; --red: #e01e2b; --red2: #ff3b30;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; }
        body {
            background: radial-gradient(120% 90% at 50% 0%, #16233f 0%, var(--bg) 55%, var(--bg2) 100%) fixed;
            color: var(--ink);
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            min-height: 100dvh;
            display: grid; place-items: center;
            overflow: hidden; text-align: center;
        }
        .wrap { position: relative; width: 100%; max-width: 640px; padding: 24px; z-index: 2; }

        /* Speed streaks flying across the background */
        .streaks { position: fixed; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; }
        .streak {
            position: absolute; height: 3px; border-radius: 3px;
            background: linear-gradient(90deg, transparent, rgba(56,189,248,.35));
            animation: fly linear infinite;
        }
        @keyframes fly { from { transform: translateX(110vw); } to { transform: translateX(-30vw); } }

        .code {
            font-size: clamp(5rem, 26vw, 11rem);
            font-weight: 900; line-height: .9; letter-spacing: -.02em;
            background: linear-gradient(180deg, #fff, var(--accent));
            -webkit-background-clip: text; background-clip: text; color: transparent;
            animation: jitter 2.6s ease-in-out infinite;
        }
        @keyframes jitter {
            0%,100% { transform: translate(0,0) rotate(0); }
            92% { transform: translate(0,0); }
            94% { transform: translate(-2px,1px) rotate(-.4deg); }
            96% { transform: translate(2px,-1px) rotate(.4deg); }
            98% { transform: translate(-1px,0) rotate(0); }
        }
        h1 { font-size: clamp(1.3rem, 5.5vw, 2rem); font-weight: 800; margin-top: 4px; }
        p.msg { color: var(--muted); margin-top: 10px; font-size: clamp(1rem, 3.6vw, 1.12rem); }

        /* ---- The car ---- */
        .stage { position: relative; height: 120px; margin: 18px auto 6px; width: 210px; }
        .road {
            position: absolute; left: -40vw; right: -40vw; bottom: 22px; height: 3px;
            background: repeating-linear-gradient(90deg, #24314f 0 26px, transparent 26px 52px);
            animation: road .5s linear infinite;
        }
        @keyframes road { to { background-position-x: -52px; } }
        .car {
            position: absolute; left: 50%; bottom: 22px; width: 168px; height: 74px;
            transform: translateX(-50%);
            animation: idle .18s ease-in-out infinite;
            filter: drop-shadow(0 10px 12px rgba(0,0,0,.5));
        }
        @keyframes idle { 0%,100% { transform: translate(-50%,0); } 50% { transform: translate(-50%,-1.5px); } }
        .body {
            position: absolute; bottom: 12px; left: 0; width: 168px; height: 34px;
            background: linear-gradient(180deg, var(--red2), var(--red) 70%, #a10e1a);
            border-radius: 22px 26px 10px 12px;
            box-shadow: inset 0 3px 6px rgba(255,255,255,.35), inset 0 -6px 10px rgba(0,0,0,.35);
        }
        .cabin {
            position: absolute; bottom: 34px; left: 44px; width: 72px; height: 28px;
            background: linear-gradient(180deg, var(--red2), var(--red));
            border-radius: 16px 32px 0 0; box-shadow: inset 0 3px 5px rgba(255,255,255,.3);
        }
        .glass {
            position: absolute; bottom: 36px; left: 53px; width: 50px; height: 20px;
            background: linear-gradient(180deg, #bfe4ff, #4a86b8);
            border-radius: 10px 20px 0 0; box-shadow: inset 0 2px 4px rgba(255,255,255,.6);
        }
        .wheel {
            position: absolute; bottom: 0; width: 28px; height: 28px; background: #0e0e10;
            border: 5px solid #2a2a2e; border-radius: 50%; box-shadow: inset 0 0 0 3px #17171a;
        }
        .wheel.back { left: 22px; } .wheel.front { right: 22px; }
        .wheel::after {
            content: ""; position: absolute; inset: 3px; border-radius: 50%;
            background: conic-gradient(from 0deg, #6b6b70 0 25%, #34343a 0 50%, #6b6b70 0 75%, #34343a 0);
            animation: spin .22s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Exhaust puff (normal) OR rising smoke (server errors) */
        .puff {
            position: absolute; border-radius: 50%; background: rgba(200,210,230,.5);
        }
        .exhaust .puff { bottom: 20px; right: 158px; width: 12px; height: 12px; animation: puff 1.1s ease-out infinite; }
        .exhaust .puff:nth-child(2) { animation-delay: .55s; }
        @keyframes puff {
            0% { transform: translate(0,0) scale(.5); opacity: .6; }
            100% { transform: translate(-40px,-6px) scale(1.8); opacity: 0; }
        }
        .smoke .puff { bottom: 44px; left: 48px; width: 16px; height: 16px; background: rgba(120,130,150,.55); animation: smoke 1.6s ease-out infinite; }
        .smoke .puff:nth-child(2) { left: 60px; animation-delay: .5s; }
        .smoke .puff:nth-child(3) { left: 54px; animation-delay: 1s; }
        @keyframes smoke {
            0% { transform: translate(0,0) scale(.5); opacity: .7; }
            100% { transform: translate(-8px,-70px) scale(2.4); opacity: 0; }
        }

        .btn {
            display: inline-block; margin-top: 22px; padding: 12px 22px;
            background: var(--accent); color: #05263a; font-weight: 700; font-size: 1rem;
            border-radius: 12px; text-decoration: none;
            box-shadow: 0 8px 20px rgba(56,189,248,.25); transition: transform .15s ease;
        }
        .btn:hover { transform: translateY(-2px); }
        .brand { position: fixed; top: 16px; left: 0; right: 0; font-weight: 800; letter-spacing: .02em; color: var(--muted); z-index: 2; }

        @media (prefers-reduced-motion: reduce) {
            .code, .car, .wheel::after, .puff, .road, .streak { animation: none !important; }
            .streaks { display: none; }
        }
    </style>
</head>
<body>
    <div class="brand">⚡ Kachow</div>
    <div class="streaks" aria-hidden="true">
        <span class="streak" style="top:18%; width:180px; animation-duration:1.4s;"></span>
        <span class="streak" style="top:32%; width:120px; animation-duration:2.1s; animation-delay:.4s; opacity:.6;"></span>
        <span class="streak" style="top:64%; width:220px; animation-duration:1.1s; animation-delay:.8s;"></span>
        <span class="streak" style="top:78%; width:90px;  animation-duration:2.6s; animation-delay:.2s; opacity:.5;"></span>
    </div>

    <main class="wrap">
        <div class="code"><?= $code ?></div>

        <div class="stage" aria-hidden="true">
            <div class="road"></div>
            <div class="car <?= $smoke ? 'smoke' : 'exhaust' ?>">
                <div class="body"></div>
                <div class="cabin"></div>
                <div class="glass"></div>
                <div class="wheel back"></div>
                <div class="wheel front"></div>
                <span class="puff"></span><span class="puff"></span><?php if ($smoke): ?><span class="puff"></span><?php endif; ?>
            </div>
        </div>

        <h1><?= $e($p['title']) ?></h1>
        <p class="msg"><?= $e($p['msg']) ?></p>

        <?php if ($isAuth): ?>
            <a class="btn" href="/index.php">Sign in</a>
        <?php else: ?>
            <a class="btn" href="/">⚡ Back to the track</a>
        <?php endif; ?>
    </main>
</body>
</html>
