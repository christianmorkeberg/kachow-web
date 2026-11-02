<?php

declare(strict_types=1);

/**
 * The Reminders card (authenticated session, JSON): what fired and awaits approval, and what is still to come.
 *
 *   GET                                              → { ok, card, badge }
 *   POST { id:int, action:approve }                  → { ok, card, badge }   tick it: done
 *   POST { id:int, action:nudge, minutes:int }       → push it again in N minutes (it stays open until approved)
 *   POST { id:int, action:nudge, at:"YYYY-MM-DD HH:MM" } → ... at that local time
 *   POST { id:int, action:cancel }                   → drop it without approving
 *
 * `badge` is the number for the app icon (reminders awaiting approval). All rules live in App\Data\Reminders.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Reminders;
use App\Data\Users;

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
session_write_close();

$reminders = new Reminders();

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $in     = is_array($in) ? $in : [];
        $id     = (int) ($in['id'] ?? 0);
        $action = (string) ($in['action'] ?? '');
        if ($id <= 0) {
            out(400, ['error' => 'id is required.']);
        }
        if ($action === 'approve') {
            $ok = $reminders->approve($userId, $id);
        } elseif ($action === 'cancel') {
            $ok = $reminders->cancel($userId, $id);
        } elseif ($action === 'nudge') {
            $utc = Reminders::futureUtc((string) ($in['at'] ?? ''), (int) ($in['minutes'] ?? 0));
            if ($utc === null) {
                out(400, ['error' => 'Give a future time: minutes from now, or a local "YYYY-MM-DD HH:MM".']);
            }
            $ok = $reminders->nudge($userId, $id, $utc);
        } else {
            out(400, ['error' => 'action must be approve, nudge or cancel.']);
        }
        if (!$ok) {
            // Already handled on another device: just show the current state.
            $card = $reminders->card($userId);
            out(200, ['ok' => true, 'stale' => true, 'card' => $card, 'badge' => $card['badge']]);
        }
    }

    $card = $reminders->card($userId);
    out(200, ['ok' => true, 'card' => $card, 'badge' => $card['badge']]);
} catch (\Throwable $e) {
    error_log('reminders.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not load the reminders.']);
}
