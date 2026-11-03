<?php

declare(strict_types=1);

/**
 * The Expenses card (authenticated session, JSON), for a period / category / private-money filter — the same card the chat opens.
 *
 *   GET ?period=this_month|last_month|this_quarter|this_year|all  [&from=&to=] [&category=] [&paid_privately=any|owed|repaid]  → { ok, card }
 *
 * Paying an expense back (or undoing it) is POST api/udlaeg.php.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Tools\GetExpenses;

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

try {
    [$from, $to, $label] = GetExpenses::resolveRange(
        (string) ($_GET['period'] ?? 'this_month'),
        isset($_GET['from']) ? (string) $_GET['from'] : null,
        isset($_GET['to']) ? (string) $_GET['to'] : null
    );
    $category = isset($_GET['category']) && $_GET['category'] !== '' ? Receipts::normalizeCategory((string) $_GET['category']) : null;
    $private  = in_array($_GET['paid_privately'] ?? '', ['any', 'owed', 'repaid'], true) ? (string) $_GET['paid_privately'] : '';
    out(200, ['ok' => true, 'card' => (new Receipts())->expensesCard($userId, $from, $to, $label, $category, $private)]);
} catch (\Throwable $e) {
    error_log('expenses.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not load the expenses.']);
}
