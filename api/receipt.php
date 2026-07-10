<?php

declare(strict_types=1);

/**
 * Receipt card actions (authenticated session, JSON).
 *
 *   POST { action:'update',  id, fields… }  → edit fields, returns fresh card
 *   POST { action:'confirm', id, fields… }  → save edits + mark confirmed
 *   POST { action:'discard', id }           → delete draft/receipt and its image
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Receipts;
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
    out(400, ['error' => 'A receipt id is required.']);
}

$receipts = new Receipts();

try {
    if ($action === 'discard') {
        $fileRef = $receipts->delete($userId, $id);
        if ($fileRef !== null) {
            (new ReceiptStorage())->delete($userId, $fileRef);
        }
        out(200, ['ok' => true, 'deleted' => true]);
    }

    if ($action === 'update' || $action === 'confirm') {
        if ($receipts->get($userId, $id) === null) {
            out(404, ['error' => 'Receipt not found.']);
        }
        $fields = [];
        foreach (['vendor', 'total', 'vat', 'currency', 'category', 'note'] as $f) {
            if (array_key_exists($f, (array) $in)) {
                $fields[$f] = $in[$f];
            }
        }
        if (array_key_exists('date', (array) $in)) {
            $fields['purchased_at'] = $in['date'];
        }
        if ($fields !== []) {
            $receipts->update($userId, $id, $fields);
        }
        if ($action === 'confirm') {
            $receipts->confirm($userId, $id);
        }

        $row = $receipts->get($userId, $id);
        out(200, ['ok' => true, 'card' => $row !== null ? $receipts->card($row) : null]);
    }

    out(400, ['error' => 'Unknown action.']);
} catch (\Throwable $e) {
    error_log('receipt.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
