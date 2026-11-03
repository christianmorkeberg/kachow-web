<?php

declare(strict_types=1);

/**
 * The Udlæg card (authenticated session, JSON): expenses paid with private money, owed or paid back.
 *
 *   GET                                         → { ok, card }
 *   POST { action:'reimburse', id[, date] }      → mark one paid back (default today)   → { ok, card }
 *   POST { action:'undo', id }                   → it was marked by mistake: owed again → { ok, card }
 *
 * Every change is written to the audit trail like the chat tool does.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\BookkeepingAudit;
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
session_write_close();

$receipts = new Receipts();

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $in     = is_array($in) ? $in : [];
        $id     = (int) ($in['id'] ?? 0);
        $action = (string) ($in['action'] ?? '');
        $row    = $id > 0 ? $receipts->get($userId, $id) : null;
        if ($row === null) {
            out(404, ['error' => 'Expense not found.']);
        }
        $audit = new BookkeepingAudit();
        if ($action === 'reimburse') {
            $date = isset($in['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $in['date']) === 1 ? (string) $in['date'] : date('Y-m-d');
            $receipts->markReimbursed($userId, $id, $date);
            $audit->log($userId, 'expense', $id, 'reimburse', ['reimbursed_at' => $date]);
        } elseif ($action === 'undo') {
            $receipts->unreimburse($userId, $id);
            $audit->log($userId, 'expense', $id, 'update', ['reimbursed_at' => null, 'note' => 'reimbursement undone']);
        } else {
            out(400, ['error' => 'action must be reimburse or undo.']);
        }
    }

    out(200, ['ok' => true, 'card' => $receipts->udlaegCard($userId)]);
} catch (\Throwable $e) {
    error_log('udlaeg.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not load the udlæg.']);
}
