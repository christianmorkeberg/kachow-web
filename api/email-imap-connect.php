<?php

declare(strict_types=1);

/**
 * Connect a mailbox over IMAP (app password) — authenticated session, JSON.
 *
 *   POST { email, password, host, port, ssl, draft_folder? }
 *     → verifies the credentials by logging in and selecting INBOX, then stores
 *       them ENCRYPTED as an email account (provider = 'imap').
 *
 * Used for Outlook/Hotmail (via app password) and the dedicated Kachow mailbox,
 * where OAuth isn't available/practical.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\EmailAccounts;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Email\ImapClient;

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

$in    = json_decode((string) file_get_contents('php://input'), true);
$in    = is_array($in) ? $in : [];
$email = trim((string) ($in['email'] ?? ''));
$pass  = (string) ($in['password'] ?? '');
$host  = trim((string) ($in['host'] ?? ''));
$port  = (int) ($in['port'] ?? 993);
$ssl   = ($in['ssl'] ?? true) !== false;
$draftFolder = trim((string) ($in['draft_folder'] ?? 'Drafts')) ?: 'Drafts';

if ($email === '' || $pass === '' || $host === '') {
    out(400, ['error' => 'Email, password and server are all required.']);
}
if ($port <= 0 || $port > 65535) {
    $port = 993;
}

// Verify the credentials before saving anything.
try {
    $client = new ImapClient($host, $port, 20, $ssl);
    $client->login($email, $pass);
    $client->select('INBOX');
    $client->close();
} catch (\Throwable $e) {
    // The message is user-facing but generic enough not to leak internals; the
    // full detail is logged for the console-debug pattern is not used here (this
    // is a form), so log server-side.
    error_log('email-imap-connect.php: ' . $e->getMessage());
    out(422, ['error' => 'Could not sign in to that mailbox: ' . $e->getMessage()]);
}

try {
    $accounts = new EmailAccounts();
    $accounts->upsert($userId, 'imap', $email, $email, [
        'host'         => $host,
        'port'         => $port,
        'ssl'          => $ssl,
        'username'     => $email,
        'password'     => $pass,
        'draft_folder' => $draftFolder,
    ]);
    out(200, ['ok' => true, 'email' => $email]);
} catch (\Throwable $e) {
    error_log('email-imap-connect.php save: ' . $e->getMessage());
    out(500, ['error' => 'Signed in, but could not save the account. Please try again.']);
}
