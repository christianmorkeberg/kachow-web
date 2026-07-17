<?php

declare(strict_types=1);

/**
 * Workout progression card actions (authenticated session, JSON) — the tap
 * affordances on the progression card (switch exercise / metric / time range).
 * Own data only. Rebuilds the exact card shape the tool returns.
 *
 *   POST { exercise?, metric?, weeks? } → returns { card }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\Workouts;
use App\Tools\GetWorkoutProgress;

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

$in = json_decode((string) file_get_contents('php://input'), true);
$in = is_array($in) ? $in : [];

$exercise = isset($in['exercise']) && $in['exercise'] !== '' ? (string) $in['exercise'] : null;
$metric   = isset($in['metric']) ? (string) $in['metric'] : GetWorkoutProgress::DEFAULT_METRIC;
$weeks    = isset($in['weeks']) && $in['weeks'] !== '' ? (int) $in['weeks'] : GetWorkoutProgress::DEFAULT_WEEKS;

try {
    $card = GetWorkoutProgress::buildCard(new Workouts(), $userId, $exercise, $metric, $weeks);
    out(200, ['ok' => true, 'card' => $card]);
} catch (\Throwable $e) {
    error_log('workout-progress.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
