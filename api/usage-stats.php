<?php

declare(strict_types=1);

/**
 * Usage & performance stats for the in-app Insights dashboard (Developer mode).
 *
 *   GET ?days=N   → aggregated diagnostics rollup as JSON (omit days = all history)
 *
 * ADMIN-ONLY: this aggregates across ALL users' turns, so it is gated on the
 * developer (role = 'admin'). It exposes only tool names, routing groups, counts
 * and timings — never call args or message content — but it still spans both
 * users, so a non-admin must never reach it.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Diagnostics\UsageStats;

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

if (!$users->isAdmin($userId)) {
    out(403, ['error' => 'Admin only.']);
}

$days = null;
if (isset($_GET['days']) && preg_match('/^\d+$/', (string) $_GET['days'])) {
    $days = max(1, min(365, (int) $_GET['days']));
}

$stats = (new UsageStats())->compute($days);
out(200, ['ok' => true, 'stats' => $stats]);
