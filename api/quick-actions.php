<?php

declare(strict_types=1);

/**
 * Returns the current user's quick-action chips for the empty chat screen.
 *
 * GET → { "actions": string[], "pinned": string[] }  (pinned first, then frequent-first blended with defaults)
 * POST { action: 'pin' | 'unpin', text } → the same shape (the pinned suggestion stays on the start screen)
 * Requires an authenticated session (or a valid remember-me cookie).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\QuickActions;
use App\Data\RememberTokens;
use App\Data\Users;

header('Content-Type: application/json');

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
    http_response_code(401);
    echo json_encode(['error' => 'Not authenticated.']);
    exit;
}

$userId = (int) $session->userId();
$qa     = new QuickActions();
try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in   = json_decode((string) file_get_contents('php://input'), true);
        $text = is_array($in) ? (string) ($in['text'] ?? '') : '';
        if (is_array($in) && ($in['action'] ?? '') === 'pin') {
            $qa->pin($userId, $text);
        } elseif (is_array($in) && ($in['action'] ?? '') === 'unpin') {
            $qa->unpin($userId, $text);
        }
    }
    $actions = $qa->suggestions($userId);
    $pinned  = $qa->pinned($userId);
} catch (\Throwable $e) {
    error_log('quick-actions.php: ' . $e->getMessage());
    // Never fail the screen over suggestions — fall back to the seed set.
    $actions = QuickActions::DEFAULTS;
    $pinned  = [];
}

echo json_encode(['actions' => array_values($actions), 'pinned' => array_values($pinned)], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
