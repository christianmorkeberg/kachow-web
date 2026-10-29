<?php

declare(strict_types=1);

/**
 * Data for the kiosk view (authenticated session, JSON). One part per tile, so each tile refreshes on its own schedule:
 *
 *   GET ?part=power[&window=2]   → { ok, card, price_now, window }  — the electricity price card (all-in kr/kWh per hour, now marker,
 *                                  cheapest N-hour stretch from now on; N = 1–6, default 2)
 *
 * Lights and thermostats are read from api/home.php (?part=lights / ?part=thermostats) — the same endpoints the Home card uses.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Energy\EnergiDataService;
use App\Energy\PowerPrices;
use App\Tools\GetPowerPrices;

header('Content-Type: application/json');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

$users   = new Users();
$session = new Session($users);
$session->boot();
if (!$session->isLoggedIn()) {
    $rememberedId = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($rememberedId !== null) {
        $session->establish($rememberedId);
    }
}
if (!$session->isLoggedIn()) {
    out(401, ['error' => 'Not authenticated.']);
}
$userId = (int) $session->userId();
// A slow upstream must not hold up the user's other requests.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

try {
    $part = (string) ($_GET['part'] ?? '');
    if ($part === 'power') {
        $window = max(1, min(6, (int) ($_GET['window'] ?? 2)));
        $res    = (new GetPowerPrices(new PowerPrices(new EnergiDataService())))->execute(['window_hours' => $window], $userId);
        if (isset($res['error'])) {
            out(502, ['error' => (string) $res['error']]);
        }
        out(200, [
            'ok'        => true,
            'card'      => $res['_render'],
            'price_now' => $res['price_now'] ?? null,
            'window'    => is_array($res['cheapest_window'] ?? null) ? $res['cheapest_window'] : null,
        ]);
    }
    out(400, ['error' => 'Use ?part=power.']);
} catch (\Throwable $e) {
    error_log('kiosk.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
