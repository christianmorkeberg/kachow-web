<?php

declare(strict_types=1);

/**
 * Cash position card (authenticated session, JSON). Powers the cash card's own
 * interactivity — logging and deleting manual bank movements — without a chat turn.
 *
 *   GET  /api/cash.php                                   → position card
 *   POST { action:'add', direction, amount[, category, note, date] } → log a movement
 *   POST { action:'delete', id }                          → remove a manual movement
 *
 * Only manual cash movements are editable here; invoices/expenses/draws have their own
 * endpoints and flow into the balance automatically.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Cash;
use App\Data\CashEntries;
use App\Data\Income;
use App\Data\OwnerDraws;
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

$entries = new CashEntries();
$cash    = new Cash(new Income(), new Receipts(), new OwnerDraws(), $entries, new UserSettings());

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $action = is_array($in) ? (string) ($in['action'] ?? '') : '';

        if ($action === 'add') {
            $direction = ((string) ($in['direction'] ?? 'out')) === 'in' ? 'in' : 'out';
            $amount    = isset($in['amount']) && $in['amount'] !== '' ? (float) $in['amount'] : 0.0;
            if ($amount <= 0) {
                out(400, ['error' => 'An amount is required.']);
            }
            $entries->add(
                $userId,
                $direction,
                $amount,
                (string) ($in['category'] ?? 'other'),
                isset($in['note']) ? (string) $in['note'] : null,
                isset($in['date']) ? (string) $in['date'] : null
            );
            out(200, ['ok' => true, 'card' => $cash->position($userId)]);
        }

        if ($action === 'delete') {
            $id = (int) ($in['id'] ?? 0);
            if ($id <= 0) {
                out(400, ['error' => 'A movement id is required.']);
            }
            $entries->delete($userId, $id);
            out(200, ['ok' => true, 'card' => $cash->position($userId)]);
        }

        out(400, ['error' => 'Unknown action.']);
    }

    // GET → the current position card.
    out(200, ['ok' => true, 'card' => $cash->position($userId)]);
} catch (\Throwable $e) {
    error_log('cash.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong loading the cash position.']);
}
