<?php

declare(strict_types=1);

/**
 * Tool targeting in SHADOW mode, for Insights (ADMIN ONLY — it spans every user's turns; tool names and sizes only, never content).
 *
 *   GET ?days=N → { ok, turns, turns_with_tools, full_chars_avg, sizes: [{ n, missed_turns, miss_rate, chars_avg, saving, missed_tools }] }
 *
 * For each top-N size: how many turns would have MISSED a tool the model then called if only the targeted list had been sent, and how much smaller it is.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Diagnostics\ToolShadow;

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
if (!$users->isAdmin((int) $session->userId())) {
    out(403, ['error' => 'Admin only.']);
}
$days = isset($_GET['days']) && preg_match('/^\d+$/', (string) $_GET['days']) ? max(1, min(400, (int) $_GET['days'])) : null;
out(200, (new ToolShadow())->overview($days));
