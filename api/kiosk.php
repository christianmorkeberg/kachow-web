<?php

declare(strict_types=1);

/**
 * Data + controls for the kiosk (kiosk.php, the full-screen wall display). Signed in as a user (session) OR as a kiosk device (the cookie that
 * kiosk.php?t=… sets; api_tokens scope 'kiosk') — see App\Auth\KioskAccess. A kiosk device can ONLY use this endpoint, nothing else in the app.
 *
 *   GET  ?part=power[&window=2]   → { ok, card, price_now, window }  electricity price card (all-in kr/kWh per hour, now marker, cheapest N-hour stretch; N 1–6)
 *   GET  ?part=lights             → as api/home.php (rooms, other lights, thermostats_known)
 *   GET  ?part=thermostats        → as api/home.php (each valve's numbers)
 *   POST { action:'light'|'group'|'thermostat', … }  → as api/home.php (Home\HomeEndpoint does the work for both)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\KioskAccess;
use App\Energy\EnergiDataService;
use App\Energy\PowerPrices;
use App\Home\HomeEndpoint;
use App\Tools\GetPowerPrices;

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

$who = KioskAccess::resolve();
if ($who === null) {
    out(401, ['error' => 'Not authenticated.']);
}
$userId = $who['user_id'];
// A slow valve or upstream must not hold up the user's other requests.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

try {
    $isPost = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST';
    $part   = (string) ($_GET['part'] ?? '');

    if (!$isPost && $part === 'power') {
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

    $in = [];
    if ($isPost) {
        $in = json_decode((string) file_get_contents('php://input'), true);
        $in = is_array($in) ? $in : [];
    }
    [$status, $body] = HomeEndpoint::handle($userId, $isPost ? 'POST' : 'GET', $_GET, $in);
    out($status, $body);
} catch (\Throwable $e) {
    error_log('kiosk.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
