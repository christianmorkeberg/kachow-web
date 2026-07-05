<?php

declare(strict_types=1);

/**
 * Workout-plan widget backend.
 *
 *   GET  ?date=YYYY-MM-DD          → card for that day (default today)
 *   GET  ?week=YYYY-MM-DD|1        → card for that week (Mon–Sun)
 *   POST { item_id, done }         → tick/untick an item (may log), returns fresh card
 *
 * Requires an authenticated session (or remember-me cookie).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\WorkoutPlans;
use App\Data\Workouts;

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

$plans  = new WorkoutPlans(null, new Workouts());
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

$validDate = static fn (string $s): bool => preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) === 1;

try {
    if ($method === 'POST') {
        $in = json_decode((string) file_get_contents('php://input'), true);
        if (!is_array($in) || !isset($in['item_id'])) {
            out(400, ['error' => 'item_id is required.']);
        }
        $itemId = (int) $in['item_id'];
        $done   = !empty($in['done']);

        $item = $plans->findItem($userId, $itemId);
        if ($item === null) {
            out(404, ['error' => 'No such planned exercise.']);
        }
        $res = $plans->check($userId, $itemId, $done);

        out(200, [
            'ok'          => true,
            'item_id'     => $itemId,
            'done'        => $done,
            'also_logged' => $res['logged'] ?? false,
            'card'        => $plans->cardForDate($userId, (string) $item['plan_date']),
        ]);
    }

    // GET
    $week = (string) ($_GET['week'] ?? '');
    if ($week !== '') {
        $ref = $validDate($week) ? $week : date('Y-m-d');
        out(200, ['card' => $plans->cardForWeek($userId, $ref)]);
    }
    $date = (string) ($_GET['date'] ?? '');
    $date = $validDate($date) ? $date : date('Y-m-d');
    out(200, ['card' => $plans->cardForDate($userId, $date)]);
} catch (\Throwable $e) {
    error_log('workout-plan.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
