<?php

declare(strict_types=1);

/**
 * Serves an income entry's bilag (invoice image or PDF), authenticated + ownership-
 * checked. The files live outside the webroot; this is the only way to read them.
 *
 *   GET ?id=N  → the stored invoice file for income N, if it belongs to the user.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Income;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Receipts\ReceiptStorage;

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
    http_response_code(401);
    exit;
}
$userId = (int) $session->userId();

$id  = (int) ($_GET['id'] ?? 0);
$row = $id > 0 ? (new Income())->get($userId, $id) : null;
if ($row === null || $row['file_ref'] === null) {
    http_response_code(404);
    exit;
}

$path = (new ReceiptStorage())->pathFor($userId, (string) $row['file_ref']);
if ($path === null) {
    http_response_code(404);
    exit;
}

$mime = (string) ($row['mime'] ?? '') ?: 'application/octet-stream';
header('Content-Type: ' . $mime);
header('Content-Length: ' . (string) filesize($path));
header('Cache-Control: private, max-age=86400');
// PDFs open inline in the browser tab.
if ($mime === 'application/pdf') {
    header('Content-Disposition: inline; filename="invoice.pdf"');
}
readfile($path);
