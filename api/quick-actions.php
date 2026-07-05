<?php

declare(strict_types=1);

/**
 * Returns the current user's quick-action chips for the empty chat screen.
 *
 * GET → { "actions": string[] }  (frequent-first, blended with defaults)
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

try {
    $actions = (new QuickActions())->suggestions((int) $session->userId());
} catch (\Throwable $e) {
    error_log('quick-actions.php: ' . $e->getMessage());
    // Never fail the screen over suggestions — fall back to the seed set.
    $actions = QuickActions::DEFAULTS;
}

echo json_encode(['actions' => array_values($actions)], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
