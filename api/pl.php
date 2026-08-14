<?php

declare(strict_types=1);

/**
 * Profit & loss (resultatopgørelse) card data (authenticated session, read-only JSON).
 * Powers the P&L card's own period navigation without a chat turn.
 *
 *   GET /api/pl.php?granularity=year&offset=0   → statement card
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Income;
use App\Data\ProfitLoss;
use App\Data\Receipts;
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

$gran = (string) ($_GET['granularity'] ?? 'year');
if (!in_array($gran, ['month', 'quarter', 'year', 'all'], true)) {
    $gran = 'year';
}
$offset = max(-600, min(0, (int) ($_GET['offset'] ?? 0)));

try {
    $pl = new ProfitLoss(new Income(), new Receipts(), new UserSettings());
    out(200, ['ok' => true, 'card' => $pl->statement($userId, $gran, $offset)]);
} catch (\Throwable $e) {
    error_log('pl.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong loading the profit & loss.']);
}
