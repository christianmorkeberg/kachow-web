<?php

declare(strict_types=1);

/**
 * Builds a location_day map card (authenticated session, JSON) — used by the card's
 * previous/next-day buttons. Own data only; same shape as get_location_day's card.
 *
 *   POST { date: "YYYY-MM-DD" } → { card }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\LocationPoints;
use App\Data\Places;
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

$in   = json_decode((string) file_get_contents('php://input'), true);
$date = is_array($in) && isset($in['date']) && is_string($in['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $in['date'])
    ? $in['date']
    : (new DateTimeImmutable('now', new DateTimeZone(WorkEvents::LOCAL_TZ)))->format('Y-m-d');

try {
    out(200, ['ok' => true, 'card' => (new LocationPoints())->day($userId, $date, (new Places())->list($userId))['card']]);
} catch (\Throwable $e) {
    error_log('location.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
