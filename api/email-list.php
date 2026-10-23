<?php

declare(strict_types=1);

/**
 * The inbox list for one mailbox (or all of them) — the mailbox picker on an email-list card posts here, so switching mailbox is one tap
 * and needs no assistant round-trip.
 *
 *   GET ?account=<id>|(empty = all)&q=<search>&limit=<n>  → { ok, card: email_list card, failed? }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Email\EmailService;
use App\Tools\GetEmails;

header('Content-Type: application/json');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
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

$email     = EmailService::fromEnv();
$accountId = isset($_GET['account']) && ctype_digit((string) $_GET['account']) ? (int) $_GET['account'] : null;
$query     = isset($_GET['q']) && trim((string) $_GET['q']) !== '' ? mb_substr(trim((string) $_GET['q']), 0, 200) : null;
$limit     = max(1, min(25, (int) ($_GET['limit'] ?? 12)));

try {
    $res = $email->listAcross($userId, $accountId, $limit, $query);
} catch (\Throwable $e) {
    error_log('email-list.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not reach ' . ($accountId !== null ? 'that mailbox' : 'your mailboxes') . ' just now.', 'debug' => $e->getMessage()]);
}

$items = array_map(
    static fn (array $r): array => $r['message']->toArray(false) + ['account' => $r['account']['email'], 'account_id' => $r['account']['id']],
    $res['messages']
);

out(200, [
    'ok'     => true,
    'failed' => $res['failed'],
    'card'   => [
        'kind'       => 'email_list',
        'title'      => $query !== null ? 'Email search' : 'Recent email',
        'account_id' => $accountId,
        'query'      => $query,
        'accounts'   => GetEmails::accountChips($email->accountsFor($userId)),
        'items'      => $items,
    ],
]);
