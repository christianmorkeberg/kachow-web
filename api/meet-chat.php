<?php

declare(strict_types=1);

/**
 * The recruiter chat endpoint — NO login: the link's token is the access.
 *   GET  ?t=<token>                  → {ok, messages:[{role,content}], remaining}   (what was said so far, for a reload)
 *   POST {token, message}            → {ok, reply, remaining}
 * Guards: an unknown / revoked / expired token answers the same as nothing; the link's message and token caps; a per-address rate limit; the message length.
 * The model has three tools and no access to anything else (App\Recruiter\RecruiterChat).
 */

require __DIR__ . '/../bootstrap.php';

use App\Assistant\GeminiClient;
use App\Data\Users;
use App\Recruiter\AboutEntries;
use App\Recruiter\LeadDelivery;
use App\Recruiter\RecruiterChat;
use App\Recruiter\RecruiterLinks;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $in     = $method === 'POST' ? (json_decode((string) file_get_contents('php://input'), true) ?: []) : [];
    $token  = (string) ($method === 'POST' ? ($in['token'] ?? '') : ($_GET['t'] ?? ''));

    $links = new RecruiterLinks();
    $link  = $links->byToken($token);
    if ($link === null) {
        out(404, ['ok' => false, 'error' => 'invalid']);
    }
    $state = RecruiterLinks::state($link);
    if ($state === 'revoked' || $state === 'expired') {
        out(410, ['ok' => false, 'error' => $state]);
    }
    $remaining = max(0, (int) $link['message_cap'] - (int) $link['messages_used']);
    if ((int) $link['tokens_used'] >= (int) $link['token_cap']) {
        $remaining = 0;
    }

    if ($method !== 'POST') {
        out(200, ['ok' => true, 'messages' => array_map(static fn (array $m): array => ['role' => $m['role'], 'content' => $m['content']], $links->messages((int) $link['id'], 40)), 'remaining' => $remaining]);
    }

    if ($state === 'full') {
        out(429, ['ok' => false, 'error' => 'full', 'remaining' => 0]);
    }
    $message = trim((string) ($in['message'] ?? ''));
    if ($message === '' || mb_strlen($message) > 1500) {
        out(400, ['ok' => false, 'error' => 'message']);
    }
    // Rate limit per address (a hash — the address itself is never stored): 20 messages in 10 minutes, 120 in a day.
    $ip     = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $ipHash = substr(hash_hmac('sha256', $ip, (string) ($_ENV['APP_ENCRYPTION_KEY'] ?? 'kachow-meet')), 0, 16);
    if ($links->recentFromIp($ipHash, 600) >= 20 || $links->recentFromIp($ipHash, 86400) >= 120) {
        out(429, ['ok' => false, 'error' => 'rate']);
    }

    $ownerName = trim((string) ((new Users())->findById((int) $link['user_id'])['name'] ?? '')) ?: 'the owner';
    $chat = new RecruiterChat(GeminiClient::fromEnv(null, 'recruiter'), new AboutEntries(), $links, LeadDelivery::fromEnv($links), $ownerName);
    $res  = $chat->reply($link, $message, $ipHash);
    if ($res['error'] !== null) {
        out(503, ['ok' => false, 'error' => $res['error']]);
    }
    $fresh = $links->byId((int) $link['id']) ?? $link;
    $body = ['ok' => true, 'reply' => $res['reply'], 'remaining' => max(0, (int) $fresh['message_cap'] - (int) $fresh['messages_used'])];
    if ($res['demo'] !== []) {
        $body['demo'] = \App\Recruiter\RecruiterDemo::resolve($res['demo']);   // the screenshots the assistant chose to show
    }
    out(200, $body);
} catch (\Throwable $e) {
    error_log('meet-chat.php: ' . $e->getMessage());
    out(500, ['ok' => false, 'error' => 'server']);
}
