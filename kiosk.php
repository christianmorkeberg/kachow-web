<?php

declare(strict_types=1);

/**
 * The kiosk: a full-screen wall display (electricity price, lights, thermostats). Open by a logged-in user (menu → Kiosk) or by a device that has
 * the kiosk link: kiosk.php?t=<token> remembers the token in a cookie and redirects to the plain address. The page itself is static; all data
 * comes from api/kiosk.php (same sign-in). Tiles live in assets/kiosk.js.
 */

require __DIR__ . '/bootstrap.php';

use App\Auth\KioskAccess;

header('Cache-Control: no-cache, no-store, must-revalidate');
header('Referrer-Policy: no-referrer');

// First visit from the setup link: keep the token on this device, then drop it from the address bar (history, screenshots, referrers).
$t = (string) ($_GET['t'] ?? '');
if ($t !== '') {
    if (KioskAccess::adopt($t)) {
        header('Location: kiosk.php');
        exit;
    }
    http_response_code(403);
    $who = null;
} else {
    $who = KioskAccess::resolve();
}
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

// The user's saved look (Appearance setting, kept on the server) — so a kiosk device that never ran the app still shows it. 'auto' follows the device's light/dark.
$theme = 'aurora';
$dark  = 'aurora';
$light = 'paper';
if ($who !== null) {
    try {
        $settings = new \App\Data\UserSettings();
        $valid    = static fn (mixed $v, string $fallback): string => in_array($v, \App\Data\UserSettings::THEMES, true) ? (string) $v : $fallback;
        $saved    = (string) ($settings->get($who['user_id'], 'theme') ?? 'aurora');
        $theme    = $saved === 'auto' ? 'auto' : $valid($saved, 'aurora');
        $dark     = $valid($settings->get($who['user_id'], 'theme_dark'), 'aurora');
        $light    = $valid($settings->get($who['user_id'], 'theme_light'), 'paper');
    } catch (\Throwable $e) {
        // keep the defaults: the look is cosmetic, never worth failing the page
    }
}

function asset(string $path): string
{
    $path = '/assets/' . ltrim($path, '/');

    return $path . '?v=' . (@filemtime(__DIR__ . $path) ?: time());
}
?>
<!DOCTYPE html>
<html lang="da">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#0f172a">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <script>(function(){var T=<?= json_encode($theme) ?>,D=<?= json_encode($dark) ?>,L=<?= json_encode($light) ?>,mq=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)');function apply(){document.documentElement.setAttribute('data-theme',T==='auto'?(mq&&mq.matches?D:L):T);}apply();if(T==='auto'&&mq&&mq.addEventListener)mq.addEventListener('change',apply);})();</script>
    <title>Kachow Kiosk</title>
    <link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/assets/icon-192.png">
    <link rel="stylesheet" href="<?= asset('styles.css') ?>">
    <link rel="stylesheet" href="<?= asset('kiosk.css') ?>">
</head>
<body class="kiosk-on">
<?php if ($who === null): ?>
    <main class="kiosk-denied">
        <h1>Kachow Kiosk</h1>
        <p>This display is not signed in. Ask Kachow for the kiosk link (&ldquo;kiosk link&rdquo;) and open it on this device, or <a href="index.php">log in</a> to the app.</p>
    </main>
<?php else: ?>
    <div id="kiosk" class="kiosk" data-via="<?= htmlspecialchars($who['via'], ENT_QUOTES) ?>" data-light="<?= htmlspecialchars($light, ENT_QUOTES) ?>" data-dark="<?= htmlspecialchars($dark, ENT_QUOTES) ?>">
        <header class="kiosk-head">
            <div class="kiosk-clock" id="kioskClock"></div>
            <div class="kiosk-date" id="kioskDate"></div>
            <?php if ($who['via'] === 'session'): ?>
                <a href="index.php" class="kiosk-close" id="kioskClose" aria-label="Back to Kachow" title="Back to Kachow"><span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></span></a>
            <?php endif; ?>
        </header>
        <main class="kiosk-tiles" id="kioskTiles"></main>
    </div>
    <script src="<?= asset('power-chart.js') ?>"></script>
    <script src="<?= asset('kiosk.js') ?>"></script>
<?php endif; ?>
</body>
</html>
