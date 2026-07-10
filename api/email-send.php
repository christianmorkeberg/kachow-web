<?php

declare(strict_types=1);

/**
 * Send a confirmed draft (authenticated session, JSON) — the Send button on an
 * email-draft card posts here. Enforces the global send lock (EMAIL_SEND_ENABLED).
 *
 *   POST { account_id?, draft_id?, to, subject, body, cc?, thread_id? }
 *     → { ok, sent, card }  or  { error }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Email\EmailDraft;
use App\Email\EmailService;
use App\Email\SendLockedException;

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
$to        = trim((string) ($in['to'] ?? ''));
$body      = (string) ($in['body'] ?? '');
$accountId = isset($in['account_id']) && $in['account_id'] !== null ? (int) $in['account_id'] : null;
$draftId   = (string) ($in['draft_id'] ?? '');
if ($to === '' || $body === '') {
    out(400, ['error' => 'Missing recipient or body.']);
}

$draft = new EmailDraft(
    to:       $to,
    subject:  (string) ($in['subject'] ?? ''),
    bodyText: $body,
    cc:       trim((string) ($in['cc'] ?? '')),
    threadId: isset($in['thread_id']) && trim((string) $in['thread_id']) !== '' ? (string) $in['thread_id'] : null,
);

try {
    EmailService::fromEnv()->sendDraft($userId, $accountId, $draftId, $draft);
} catch (SendLockedException $e) {
    out(403, ['error' => 'Sending is currently turned off.']);
} catch (\Throwable $e) {
    error_log('email-send.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not send that email.', 'debug' => $e->getMessage()]);
}

out(200, [
    'ok'   => true,
    'sent' => true,
    'card' => [
        'kind'    => 'email_draft',
        'title'   => 'Email sent',
        'to'      => $to,
        'cc'      => $draft->cc,
        'subject' => $draft->subject,
        'body'    => $body,
        'note'    => 'Sent.',
        'sent'    => true,
    ],
]);
