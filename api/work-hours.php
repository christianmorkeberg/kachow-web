<?php

declare(strict_types=1);

/**
 * Rebuilds the work_hours card (authenticated session, JSON) for a view — the once-a-minute refresh of an open
 * card while a session is running, the card's own period toggle, and the lines for a tapped bar. Own data only;
 * the same card get_work_hours / get_work_summary return (WorkEvents::overview).
 *
 *   POST { period?: today|week|4w|12w|year, scope?, date?, to?, place?, bucket? } → { card }   (dates YYYY-MM-DD)
 *   POST { only:'sessions', date, to?, place? }                                   → { sessions, total, total_minutes }
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

$period = isset($in['period']) && in_array($in['period'], WorkEvents::OVERVIEW_PERIODS, true) ? (string) $in['period'] : null;
$bucket = isset($in['bucket']) && in_array($in['bucket'], ['day', 'week', 'month'], true) ? (string) $in['bucket'] : null;

try {
    $events = new WorkEvents();
    // Only the session lines for a stretch of days (a tapped bar whose lines the card does not carry).
    if (($in['only'] ?? '') === 'sessions' && $date('date') !== null) {
        $sum = $events->summary($userId, 'today', $date('date'), $place, $date('to') ?? $date('date'));
        out(200, ['ok' => true, 'sessions' => $sum['card']['sessions'], 'total' => $sum['card']['total'], 'total_minutes' => $sum['card']['total_minutes']]);
    }
    out(200, ['ok' => true, 'card' => $events->overview($userId, [
        'period' => $period, 'scope' => $scope, 'date' => $date('date'), 'to' => $date('to'), 'place' => $place, 'bucket' => $bucket,
    ])]);
} catch (\Throwable $e) {
    error_log('work-hours.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
