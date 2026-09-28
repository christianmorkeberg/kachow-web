<?php

declare(strict_types=1);

/**
 * OwnTracks ingest (HTTP mode) — location tracking phase 1. NO login session: the phone
 * authenticates with a per-user token (api_tokens scope 'location') that maps to a user id
 * server-side, either in the URL or as the HTTP Basic-auth password:
 *
 *   POST /api/owntracks.php?t=<token>        body: one OwnTracks JSON message
 *
 * Only `_type: location` messages are stored (raw points); every other type — transition,
 * waypoint, lwt, status… — is acknowledged and ignored, because Kachow derives places and
 * events itself. OwnTracks expects a 200 with a JSON array (friends / commands), so every
 * accepted request answers `[]`. Re-sent fixes are de-duplicated by (device, timestamp).
 */

require __DIR__ . '/../bootstrap.php';

use App\Data\ApiTokens;
use App\Data\LocationPoints;
use App\Tools\GetLocationTrackingSetup;

header('Content-Type: application/json; charset=utf-8');

function reply(int $status, mixed $body = []): never
{
    http_response_code($status);
    echo json_encode($body);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    reply(405, ['error' => 'POST only']);
}

// Token: ?t=… (simplest to paste into the app), else the Basic-auth password.
$token = (string) ($_GET['t'] ?? '');
if ($token === '') {
    $token = (string) ($_SERVER['PHP_AUTH_PW'] ?? '');
}
if ($token === '') {
    $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (stripos($auth, 'basic ') === 0) {
        $pair  = (string) base64_decode(substr($auth, 6), true);
        $token = str_contains($pair, ':') ? substr($pair, strpos($pair, ':') + 1) : '';
    }
}

$raw = (string) file_get_contents('php://input', false, null, 0, 65536);

try {
    $userId = (new ApiTokens())->userForToken($token, GetLocationTrackingSetup::SCOPE);
    if ($userId === null) {
        reply(401, ['error' => 'Invalid token']);
    }

    $msg = json_decode($raw, true);
    if (!is_array($msg)) {
        reply(400, ['error' => 'Body must be an OwnTracks JSON message']);
    }
    // One message per request is the norm; accept a JSON array of messages too.
    $messages = array_is_list($msg) ? $msg : [$msg];

    $points = new LocationPoints();
    foreach ($messages as $m) {
        if (!is_array($m)) {
            continue;
        }
        if (($m['_type'] ?? '') === 'encrypted') {
            error_log('owntracks: encrypted payload received but encryption is not enabled — turn it off in the app');
            continue;
        }
        $p = LocationPoints::fromOwnTracks($m);
        if ($p === null) {
            continue; // not a usable location (other _type, bad/old fix) — acknowledged, not stored
        }
        // Device label: OwnTracks' X-Limit-D header, else the topic's last segment, else tid.
        $device = (string) ($_SERVER['HTTP_X_LIMIT_D'] ?? '');
        if ($device === '' && is_string($m['topic'] ?? null)) {
            $parts  = explode('/', $m['topic']);
            $device = (string) end($parts);
        }
        if ($device === '' && is_string($m['tid'] ?? null)) {
            $device = $m['tid'];
        }
        $points->add($userId, $device, $p);
    }

    // Retention: roughly one request in a hundred sweeps this user's points past 60 days
    // (a phone posts hundreds a day, so this runs a few times daily with no extra cron job).
    if (random_int(1, 100) === 1) {
        $points->purgeOld($userId);
    }

    reply(200, []);
} catch (\Throwable $e) {
    error_log('owntracks.php: ' . $e->getMessage());
    reply(500, ['error' => 'Server error']);
}
