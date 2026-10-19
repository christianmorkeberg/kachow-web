<?php

declare(strict_types=1);

/**
 * Disconnect a mailbox: removes the account and its stored (encrypted) credentials. Authenticated session, JSON.
 *
 *   POST { id } → { ok: true }
 *
 * Owner-scoped (EmailAccounts::delete only touches the caller's own rows). Gmail / Outlook tokens at the provider
 * are not revoked here — the user can remove the app's access in their Google / Microsoft account if they want.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\EmailAccounts;
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
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    out(405, ['error' => 'POST only.']);
}
$userId = (int) $session->userId();

$in = json_decode((string) file_get_contents('php://input'), true);
$id = is_array($in) ? (int) ($in['id'] ?? 0) : 0;
if ($id <= 0) {
    out(400, ['error' => 'Which mailbox?']);
}

try {
    if (!(new EmailAccounts())->delete($userId, $id)) {
        out(404, ['error' => 'That mailbox is not connected.']);
    }
} catch (\Throwable $e) {
    error_log('email-disconnect.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not disconnect that mailbox.']);
}

out(200, ['ok' => true]);
