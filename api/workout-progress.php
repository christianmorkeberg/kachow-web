<?php

declare(strict_types=1);

/**
 * Workout progression card actions (authenticated session, JSON) — the tap
 * affordances on the progression card (switch exercise / metric / time range).
 * Rebuilds the exact card shape the tool returns.
 *
 *   POST { exercise?, metric?, weeks?, person? } → returns { card }
 *
 * With `person`, charts a CONNECTED person's data: the owner is re-resolved
 * through ConnectionAccess on every request (accepted connection + 'workouts'
 * scope) — the client-supplied person is re-checked, never a trusted owner id.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Connections;
use App\Data\ExerciseAliases;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\Workouts;
use App\Tools\ConnectionAccess;
use App\Tools\GetConnectedWorkoutProgress;
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
$person   = isset($in['person']) && $in['person'] !== '' ? (string) $in['person'] : null;

try {
    // A connection's card: re-resolve the owner through the audited gate every time.
    $ownerId = $userId;
    $access  = null;
    if ($person !== null) {
        $access = ConnectionAccess::resolve(new Connections(), $userId, $person, 'workouts');
        if (isset($access['error'])) {
            out(403, ['error' => $access['error']]);
        }
        $ownerId = (int) $access['owner_id'];
    }

    $card = GetWorkoutProgress::buildCard(
        new Workouts(),
        $ownerId,
        $exercise,
        $metric,
        $weeks,
        new ExerciseAliases(),
    );
    if ($access !== null) {
        $card = GetConnectedWorkoutProgress::tagPerson($card, $access['person']);
    }
    out(200, ['ok' => true, 'card' => $card]);
} catch (\Throwable $e) {
    error_log('workout-progress.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
