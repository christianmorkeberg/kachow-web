<?php

declare(strict_types=1);

/**
 * The Train card (authenticated session, JSON): one programme day, done by one person or two on one phone. Every set ticked is saved at once to that person's own log.
 *
 *   GET  ?date=YYYY-MM-DD (default today)                                    → { ok, card }
 *   POST { action:'start', date }                                            → stamps the start of the day's session
 *   POST { action:'tick', date, person_id, exercise, set_no, weight, reps, planned_percent, planned_weight, note? } → saves (or corrects) one set → { ok, workout_id, card }
 *   POST { action:'untick', date, person_id, workout_id }                    → takes a ticked set out of the log → { ok, card }
 *   POST { action:'comment', date, person_id, exercise, text }               → the comment on that person's ticked sets of the exercise → { ok, card }
 *   POST { action:'max', date, person_id, exercise, max }                    → a person's training max for an exercise (0 clears it) → { ok, card }
 *   POST { action:'audience', program_id, week, year, weekday, audience }    → who a programme day is for: "both" or a person's user id → { ok }
 *
 * The person logged in may log for the other one only through the sharing they already have (the other must have shared "workouts" with them).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Connections;
use App\Data\ExerciseAliases;
use App\Data\RememberTokens;
use App\Data\TrainingPrograms;
use App\Data\Users;
use App\Data\Workouts;
use App\Training\TrainingMax;
use App\Training\TrainSession;

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
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();   // sets are ticked quickly, one request after the other
}

$programs = new TrainingPrograms();
$workouts = new Workouts();
$train    = new TrainSession($programs, new TrainingMax($workouts, new ExerciseAliases()), $workouts, new Connections(), $users);
$num      = static fn (mixed $v): ?float => is_numeric($v) ? (float) $v : null;

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        out(200, ['ok' => true, 'card' => $train->card($userId, (string) ($_GET['date'] ?? ''))]);
    }
    $in     = json_decode((string) file_get_contents('php://input'), true);
    $in     = is_array($in) ? $in : [];
    $action = (string) ($in['action'] ?? '');
    $date   = (string) ($in['date'] ?? TrainSession::today());
    $person = (int) ($in['person_id'] ?? 0);
    $res    = ['ok' => false, 'error' => 'Unknown action.'];

    switch ($action) {
        case 'start':
            $res = $train->start($userId, $date);
            break;
        case 'tick':
            $res = $train->tick($userId, $date, $person, (string) ($in['exercise'] ?? ''), (int) ($in['set_no'] ?? 0), $num($in['weight'] ?? null),
                isset($in['reps']) && is_numeric($in['reps']) ? (int) $in['reps'] : null, $num($in['planned_percent'] ?? null), $num($in['planned_weight'] ?? null),
                isset($in['note']) ? (string) $in['note'] : null);
            break;
        case 'untick':
            $res = $train->untick($userId, $person, (int) ($in['workout_id'] ?? 0));
            break;
        case 'comment':
            $res = $train->comment($userId, $date, $person, (string) ($in['exercise'] ?? ''), (string) ($in['text'] ?? ''));
            break;
        case 'max':
            $res = $train->setMax($userId, $person, (string) ($in['exercise'] ?? ''), $num($in['max'] ?? null));
            break;
        case 'audience':
            $aud = ($in['audience'] ?? 'both') === 'both' ? null : (int) $in['audience'];
            $ok  = $programs->setDayAudience($userId, (int) ($in['program_id'] ?? 0), (int) ($in['week'] ?? 0), (int) ($in['year'] ?? 0), (int) ($in['weekday'] ?? 0), $aud);
            out($ok ? 200 : 400, $ok ? ['ok' => true] : ['ok' => false, 'error' => 'Could not change that day.']);
    }
    if (($res['ok'] ?? false) !== true) {
        out(400, $res);
    }
    $res['card'] = $train->card($userId, $date);
    out(200, $res);
} catch (\RuntimeException $e) {
    out(503, ['ok' => false, 'error' => $e->getMessage()]);
} catch (\Throwable $e) {
    error_log('train.php: ' . $e->getMessage());
    out(500, ['ok' => false, 'error' => 'Something went wrong.']);
}
