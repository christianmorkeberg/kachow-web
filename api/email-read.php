<?php

declare(strict_types=1);

/**
 * Open one email in full (authenticated session, JSON) — used when the user taps
 * a message in an email-list card. Returns an `email` card for app.js to render.
 * Read-only; bypasses the assistant loop so opening a mail is instant and free.
 *
 *   POST { account_id?, id }  → { ok, card }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Email\EmailService;

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

$in        = json_decode((string) file_get_contents('php://input'), true);
$in        = is_array($in) ? $in : [];
$id        = trim((string) ($in['id'] ?? ''));
$accountId = isset($in['account_id']) && $in['account_id'] !== null ? (int) $in['account_id'] : null;
if ($id === '') {
    out(400, ['error' => 'An email id is required.']);
}

try {
    $msg = EmailService::fromEnv()->get($userId, $accountId, $id);
} catch (\Throwable $e) {
    error_log('email-read.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not open that email.', 'debug' => $e->getMessage()]);
}
if ($msg === null) {
    out(404, ['error' => 'That email could not be found.']);
}

out(200, ['ok' => true, 'card' => ['kind' => 'email', 'account_id' => $accountId] + $msg->toArray(true)]);
