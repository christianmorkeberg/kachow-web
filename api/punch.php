<?php

declare(strict_types=1);

/**
 * Work clock punch endpoint for URL-triggered automations (iOS Shortcut on
 * arrive/leave). NO login session — authenticated by a per-user token that maps
 * to a user id server-side.
 *
 *   GET/POST /api/punch.php?t=<token>&e=in    → clock in
 *   GET/POST /api/punch.php?t=<token>&e=out   → clock out
 *
 * Returns a short text/plain line (so the Shortcut can show it as a notification).
 */

require __DIR__ . '/../bootstrap.php';

use App\Data\ApiTokens;
use App\Data\WorkEvents;

header('Content-Type: text/plain; charset=utf-8');

function line(int $status, string $text): never
{
    http_response_code($status);
    echo $text . "\n";
    exit;
}

$token = (string) ($_GET['t'] ?? $_POST['t'] ?? '');
$raw   = strtolower(trim((string) ($_GET['e'] ?? $_POST['e'] ?? '')));

$kind = match ($raw) {
    'in', 'arrive', 'arrived', 'clockin', 'clock_in' => 'in',
    'out', 'leave', 'left', 'clockout', 'clock_out'  => 'out',
    default                                           => '',
};
if ($kind === '') {
    line(400, 'Missing or invalid "e" (use e=in or e=out).');
}

try {
    $userId = (new ApiTokens())->userForToken($token, 'work_punch');
    if ($userId === null) {
        line(403, 'Invalid token.');
    }

    $res = (new WorkEvents())->add($userId, $kind, null, 'ios_geofence');

    $verb = $kind === 'in' ? 'Clocked in' : 'Clocked out';
    if ($res['status'] === 'duplicate') {
        line(200, 'Already ' . ($kind === 'in' ? 'clocked in' : 'clocked out') . ' — ignored duplicate.');
    }

    line(200, $verb . ' · ' . $res['local']);
} catch (\Throwable $e) {
    error_log('punch.php: ' . $e->getMessage());
    line(500, 'Something went wrong.');
}
