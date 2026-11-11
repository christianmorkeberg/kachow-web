<?php

declare(strict_types=1);

/**
 * Gemini token usage and its estimated cost, for the developer overview in Insights (ADMIN ONLY: it spans every user's calls — token counts and purposes only, never content).
 *
 *   GET ?days=N                                   → { ok, totals, by_purpose, by_model, by_day, prices }   (omit days = all history)
 *   POST { model, input_per_m, cached_per_m, output_per_m } → set a model's price (USD per million tokens), returns the fresh overview
 *
 * The API reports tokens, never money: the cost is tokens × these prices, worked out here. A model without a price shows its tokens and "no price".
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\UsageLog;
use App\Data\Users;

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

$log  = new UsageLog();
$days = null;
if (isset($_GET['days']) && preg_match('/^\d+$/', (string) $_GET['days'])) {
    $days = max(1, min(400, (int) $_GET['days']));
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true);
    $in = is_array($in) ? $in : [];
    $num = static fn (string $k): float => is_numeric($in[$k] ?? null) ? (float) $in[$k] : -1.0;
    if (!$log->setPrice((string) ($in['model'] ?? ''), $num('input_per_m'), $num('cached_per_m'), $num('output_per_m'))) {
        out(400, ['error' => 'A model name and three prices (USD per million tokens, 0 or more) are required — and the migration must have been run.']);
    }
}

$overview = $log->overview($days);
out(200, $overview);
