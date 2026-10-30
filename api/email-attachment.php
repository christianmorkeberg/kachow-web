<?php

declare(strict_types=1);

/**
 * Downloads one attached file of an email (authenticated session) — the buttons on the email card. The file is fetched from the mailbox each
 * time (nothing is stored) and sent as a download.
 *
 *   GET ?id=<message id>&att=<attachment id>[&account_id=N]  → the file
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Email\EmailService;

function fail(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
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
    fail(401, 'Not authenticated.');
}
$userId = (int) $session->userId();
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();   // a slow mailbox must not hold up the user's other requests
}

$id        = trim((string) ($_GET['id'] ?? ''));
$att       = trim((string) ($_GET['att'] ?? ''));
$accountId = isset($_GET['account_id']) && $_GET['account_id'] !== '' ? (int) $_GET['account_id'] : null;
if ($id === '' || $att === '') {
    fail(400, 'An email id and an attachment id are required.');
}

try {
    $file = EmailService::fromEnv()->attachment($userId, $accountId, $id, $att);
} catch (\Throwable $e) {
    error_log('email-attachment.php: ' . $e->getMessage());
    fail(500, 'Could not fetch that file.');
}
if ($file === null) {
    fail(404, 'That file could not be found.');
}

// A file name that is safe in a header: no path, no control characters or quotes; the real name goes along as UTF-8 (RFC 5987).
$name = trim((string) preg_replace('/[\x00-\x1f"\\\\\/]+/u', '_', (string) $file['filename']));
$name = $name !== '' ? $name : 'attachment';
$ascii = trim((string) preg_replace('/[^\x20-\x7e]+/', '_', $name));
$mime  = preg_match('#^[a-z0-9.+-]+/[a-z0-9.+-]+$#i', (string) $file['mime']) === 1 ? strtolower((string) $file['mime']) : 'application/octet-stream';

header('Content-Type: ' . $mime);
header('Content-Disposition: attachment; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($name));
header('Content-Length: ' . strlen((string) $file['data']));
header('X-Content-Type-Options: nosniff');
header('Cache-Control: private, no-store');
echo $file['data'];
