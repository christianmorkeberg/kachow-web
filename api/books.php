<?php

declare(strict_types=1);

/**
 * Bookkeeping cockpit data (authenticated session, read-only JSON). Powers the
 * dashboard's own navigation — period switching and overview→detail drill-in — so the
 * cockpit is interactive without a chat turn.
 *
 *   GET /api/books.php?period=this_quarter          → overview payload
 *   GET /api/books.php?action=entry&id=N            → one income entry's detail card
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Books;
use App\Data\Income;
use App\Data\OwnerDraws;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\UserSettings;
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

$books = new Books(new Income(), new Receipts(), new OwnerDraws(), new UserSettings());
$action = (string) ($_GET['action'] ?? 'overview');

try {
    if ($action === 'entry') {
        $id   = (int) ($_GET['id'] ?? 0);
        $card = $id > 0 ? $books->incomeEntry($userId, $id) : null;
        if ($card === null) {
            out(404, ['error' => 'Entry not found.']);
        }
        out(200, ['ok' => true, 'card' => $card]);
    }

    // Default: the overview for a period.
    $period = (string) ($_GET['period'] ?? 'this_quarter');
    $allowed = ['this_month', 'last_month', 'this_quarter', 'this_year', 'all'];
    if (!in_array($period, $allowed, true)) {
        $period = 'this_quarter';
    }
    [$from, $to, $label] = GetExpenses::resolveRange($period, null, null);

    out(200, ['ok' => true, 'card' => $books->overview($userId, $from, $to, $label, $period)]);
} catch (\Throwable $e) {
    error_log('books.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong loading the books.']);
}
