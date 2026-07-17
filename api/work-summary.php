<?php

declare(strict_types=1);

/**
 * Work-hours bar-chart actions (authenticated session, JSON) — the period toggle on
 * the work_chart card (week / 4w / 12w / year). Own data only. Rebuilds the exact
 * card shape the tool returns.
 *
 *   POST { period? } → returns { card }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\WorkEvents;

header('Content-Type: application/json');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
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

$in     = json_decode((string) file_get_contents('php://input'), true);
$period = is_array($in) && isset($in['period']) && $in['period'] !== '' ? (string) $in['period'] : 'week';

try {
    $card = (new WorkEvents())->breakdown($userId, $period);
    out(200, ['ok' => true, 'card' => $card]);
} catch (\Throwable $e) {
    error_log('work-summary.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
