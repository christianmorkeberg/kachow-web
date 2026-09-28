<?php

declare(strict_types=1);

/**
 * Rebuilds a work_hours card (authenticated session, JSON) for the exact view it showed —
 * used by the page to refresh an open card once a minute while a session is running, so
 * the clock keeps counting on desktop. Own data only; same shape as get_work_hours' card.
 *
 *   POST { scope?, date?, to?, place? } → { card }   (dates YYYY-MM-DD)
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

$in    = json_decode((string) file_get_contents('php://input'), true);
$in    = is_array($in) ? $in : [];
$scope = isset($in['scope']) && in_array($in['scope'], ['today', 'yesterday', 'week', 'lastweek', 'month', 'lastmonth'], true)
    ? (string) $in['scope'] : 'today';
$date  = static fn (string $k): ?string => isset($in[$k]) && is_string($in[$k])
    && preg_match('/^\d{4}-\d{2}-\d{2}$/', $in[$k]) ? $in[$k] : null;
$place = isset($in['place']) && is_string($in['place']) && trim($in['place']) !== ''
    ? mb_substr(trim($in['place']), 0, 64) : null;

try {
    $summary = (new WorkEvents())->summary($userId, $scope, $date('date'), $place, $date('to'));
    out(200, ['ok' => true, 'card' => $summary['card']]);
} catch (\Throwable $e) {
    error_log('work-hours.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
