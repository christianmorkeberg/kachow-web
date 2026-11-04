<?php

declare(strict_types=1);

/**
 * Extra files on an income or expense entry (authenticated session): a timesheet behind an invoice, a contract, a spreadsheet …
 *
 *   GET  ?kind=income|expense&entry_id=N            → { ok, items:[{id,name,mime,size}] }
 *   GET  ?id=N                                       → the file (PDF/images open in the tab, other types download)
 *   POST multipart: kind, entry_id, file             → store it           → { ok, items }
 *   POST json { action:'delete', id }                → remove it          → { ok, items }
 *
 * Files live outside the webroot (ReceiptStorage); only listed document types are accepted (PDF, images, CSV, Excel, Word, text).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\EntryAttachments;
use App\Data\Income;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Receipts\ReceiptStorage;

function out(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json');
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

$att     = new EntryAttachments();
$storage = new ReceiptStorage();

/** The entry must exist and be the user's. */
$ownsEntry = static function (string $kind, int $id) use ($userId): bool {
    if ($id <= 0) {
        return false;
    }

    return $kind === 'income' ? (new Income())->get($userId, $id) !== null : (new Receipts())->get($userId, $id) !== null;
};

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // Download one file.
    if ($method === 'GET' && isset($_GET['id'])) {
        $row  = $att->get($userId, (int) $_GET['id']);
        $path = $row !== null ? $storage->pathFor($userId, $row['file_ref']) : null;
        if ($row === null || $path === null) {
            http_response_code(404);
            exit;
        }
        $inline = $row['mime'] === 'application/pdf' || str_starts_with($row['mime'], 'image/');
        header('Content-Type: ' . $row['mime']);
        header('X-Content-Type-Options: nosniff');
        header('Content-Length: ' . (string) filesize($path));
        header('Cache-Control: private, max-age=3600');
        header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . "; filename*=UTF-8''" . rawurlencode($row['name']));
        readfile($path);
        exit;
    }

    if ($method === 'POST') {
        $json = str_contains((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json');
        if ($json) {
            $in = json_decode((string) file_get_contents('php://input'), true);
            $in = is_array($in) ? $in : [];
            if ((string) ($in['action'] ?? '') !== 'delete') {
                out(400, ['error' => 'action must be delete.']);
            }
            $row = $att->get($userId, (int) ($in['id'] ?? 0));
            if ($row === null) {
                out(404, ['error' => 'Attachment not found.']);
            }
            $att->delete($userId, $row['id']);
            $storage->delete($userId, $row['file_ref']);
            out(200, ['ok' => true, 'items' => $att->listFor($userId, $row['entity_type'], $row['entity_id'])]);
        }

        $kind = (string) ($_POST['kind'] ?? '') === 'income' ? 'income' : 'expense';
        $id   = (int) ($_POST['entry_id'] ?? 0);
        if (!$ownsEntry($kind, $id)) {
            out(404, ['error' => 'Entry not found.']);
        }
        $f = $_FILES['file'] ?? null;
        if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            out(400, ['error' => 'No file received.']);
        }
        try {
            $stored = $storage->storeFile($userId, (string) $f['tmp_name'], (int) $f['size'], (string) $f['name']);
        } catch (\RuntimeException $e) {
            out(400, ['error' => $e->getMessage()]);
        }
        $att->add($userId, $kind, $id, $stored['file_ref'], $stored['mime'], $stored['name'], $stored['size']);
        out(200, ['ok' => true, 'items' => $att->listFor($userId, $kind, $id)]);
    }

    $kind = (string) ($_GET['kind'] ?? '') === 'income' ? 'income' : 'expense';
    $id   = (int) ($_GET['entry_id'] ?? 0);
    if (!$ownsEntry($kind, $id)) {
        out(404, ['error' => 'Entry not found.']);
    }
    out(200, ['ok' => true, 'items' => $att->listFor($userId, $kind, $id)]);
} catch (\Throwable $e) {
    error_log('attachments.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not handle the attachments.']);
}
