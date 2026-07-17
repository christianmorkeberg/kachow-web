<?php

declare(strict_types=1);

/**
 * Cycle card actions (authenticated session, JSON) — the tap affordances on the
 * cycle card. Own data only (never a shared/connected view).
 *
 *   POST { action:'log',            start_date?, flow? }  → log a period start, returns card
 *   POST { action:'remove',         id }                  → remove a logged period, returns card
 *   POST { action:'log_day',        mood?, energy?, date? } → log mood/energy, returns card
 *   POST { action:'toggle_fertile' }                      → flip the fertile-window setting, returns card
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\CycleTracker;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\UserSettings;

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
$action = is_array($in) ? (string) ($in['action'] ?? '') : '';
$cycle  = new CycleTracker();

try {
    if ($action === 'log') {
        $cycle->logPeriod(
            $userId,
            isset($in['start_date']) ? (string) $in['start_date'] : '',
            null,
            isset($in['flow']) ? (string) $in['flow'] : null,
        );
        out(200, ['ok' => true, 'card' => $cycle->card($userId)]);
    }

    if ($action === 'remove') {
        $id = (int) ($in['id'] ?? 0);
        if ($id <= 0) {
            out(400, ['error' => 'A period id is required.']);
        }
        $cycle->remove($userId, $id);
        out(200, ['ok' => true, 'card' => $cycle->card($userId)]);
    }

    if ($action === 'log_day') {
        $mood   = isset($in['mood'])   && $in['mood']   !== '' ? (int) $in['mood']   : null;
        $energy = isset($in['energy']) && $in['energy'] !== '' ? (int) $in['energy'] : null;
        $cycle->logDay(
            $userId,
            isset($in['date']) ? (string) $in['date'] : '',
            $mood,
            $energy,
        );
        out(200, ['ok' => true, 'card' => $cycle->card($userId)]);
    }

    if ($action === 'toggle_fertile') {
        $settings = new UserSettings();
        $now = UserSettings::isTruthy($settings->get($userId, 'cycle_show_fertile'));
        $settings->set($userId, 'cycle_show_fertile', $now ? 'off' : 'on');
        out(200, ['ok' => true, 'card' => $cycle->card($userId)]);
    }

    out(400, ['error' => 'Unknown action.']);
} catch (\Throwable $e) {
    error_log('cycle.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
