<?php

declare(strict_types=1);

/**
 * Income card actions (authenticated session, JSON) — the income-side sibling of
 * receipt.php.
 *
 *   POST { action:'update',   id, fields… }  → edit fields, returns fresh card
 *   POST { action:'confirm',  id, fields… }  → save edits + book it (status=booked)
 *   POST { action:'mark_paid',id[, date] }   → record the payment date
 *   POST { action:'discard',  id }           → delete the entry (+ its bilag)
 *
 * Every book/paid writes to the append-only bookkeeping_audit trail.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\BookkeepingAudit;
use App\Data\Income;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Receipts\ReceiptStorage;

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

$in     = json_decode((string) file_get_contents('php://input'), true);
$action = is_array($in) ? (string) ($in['action'] ?? '') : '';
$id     = (int) ($in['id'] ?? 0);
if ($id <= 0) {
    out(400, ['error' => 'An income id is required.']);
}

$income = new Income();
$audit  = new BookkeepingAudit();

try {
    if ($action === 'discard') {
        $fileRef = $income->delete($userId, $id);
        if ($fileRef !== null) {
            (new ReceiptStorage())->delete($userId, $fileRef);
        }
        $audit->log($userId, 'income', $id, 'delete');
        out(200, ['ok' => true, 'deleted' => true]);
    }

    if ($action === 'mark_paid') {
        if ($income->get($userId, $id) === null) {
            out(404, ['error' => 'Income entry not found.']);
        }
        $date = array_key_exists('date', (array) $in) ? (string) $in['date'] : null;
        $income->markPaid($userId, $id, $date);
        $audit->log($userId, 'income', $id, 'paid', ['paid_at' => $date ?? Income::today()]);
        $row = $income->get($userId, $id);
        out(200, ['ok' => true, 'card' => $row !== null ? $income->card($row) : null]);
    }

    if ($action === 'update' || $action === 'confirm') {
        if ($income->get($userId, $id) === null) {
            out(404, ['error' => 'Income entry not found.']);
        }
        $fields = [];
        foreach (['customer', 'doc_number', 'kind', 'amount_ex_vat', 'vat', 'total', 'currency', 'category', 'note'] as $f) {
            if (array_key_exists($f, (array) $in)) {
                $fields[$f] = $in[$f];
            }
        }
        if (array_key_exists('date', (array) $in)) {
            $fields['issued_at'] = $in['date'];
        }
        if (array_key_exists('paid_at', (array) $in)) {
            $fields['paid_at'] = $in['paid_at'];  // '' clears it (still outstanding)
        }
        if ($fields !== []) {
            $income->update($userId, $id, $fields);
            $audit->log($userId, 'income', $id, 'update', ['fields' => array_keys($fields)]);
        }
        if ($action === 'confirm') {
            $income->book($userId, $id);
            $audit->log($userId, 'income', $id, 'book');
        }

        $row = $income->get($userId, $id);
        out(200, ['ok' => true, 'card' => $row !== null ? $income->card($row) : null]);
    }

    out(400, ['error' => 'Unknown action.']);
} catch (\Throwable $e) {
    error_log('income.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
