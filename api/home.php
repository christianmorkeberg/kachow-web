<?php

declare(strict_types=1);

/**
 * The Home card (authenticated session, JSON): lights, rooms and radiator thermostats, read and controlled through the home agent.
 *
 *   GET  ?part=lights                                        → { ok, rooms:[…], other:[…], thermostats_known }  (the bridge's lists, live; the saved thermostat names + rooms)
 *   GET  ?part=thermostats                                   → { ok, thermostats:[…] }            (each valve's numbers, with its Hue room)
 *   POST { action:'light', id, on?, brightness?, color? }    → one light (color: a hex like #ff8800, a word, a white)
 *   POST { action:'group', id, on?, brightness? }            → a whole room (its grouped_light id)
 *   POST { action:'thermostat', id, target }                 → a valve's target in °C (a slow valve answers "sent")
 *
 * The two reads are separate so the card can show the lights while the (slower) valves are still answering.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Home\HomeEndpoint;

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
// Release the session lock: a slow valve must not hold up the user's other requests.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

$in = [];
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true);
    $in = is_array($in) ? $in : [];
}
[$status, $body] = HomeEndpoint::handle($userId, ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? 'POST' : 'GET', $_GET, $in);
out($status, $body);
