<?php

declare(strict_types=1);

/**
 * Quarterly moms settlement card (authenticated session, read-only JSON). Powers the
 * moms card's own quarter navigation so it's interactive without a chat turn.
 *
 *   GET /api/moms.php?offset=0   → current quarter's momsafregning card
 *   GET /api/moms.php?offset=-1  → the previous quarter, etc. (never into the future)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Income;
use App\Data\Moms;
use App\Data\Receipts;
use App\Data\RememberTokens;
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

$offset = (int) ($_GET['offset'] ?? 0);
$offset = max(-400, min(0, $offset));   // clamp; never navigate into the future

try {
    $card = (new Moms(new Income(), new Receipts()))->card($userId, $offset);
    out(200, ['ok' => true, 'card' => $card]);
} catch (\Throwable $e) {
    error_log('moms.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong loading the moms figures.']);
}
