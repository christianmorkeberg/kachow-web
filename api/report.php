<?php

declare(strict_types=1);

/**
 * "Report to developer" — a user flags a specific message that looked off. Stores a
 * self-contained snapshot (the message + a little context + its diagnostics) and emails
 * the developer(s). Owner-scoped: you can only report a message in your own conversation.
 *
 *   POST { message_id:int, note?:string } → { ok:true, id:int }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\FeedbackReports;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Mail\NativeMailer;

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
$messageId = (int) ($in['message_id'] ?? 0);
$note      = isset($in['note']) ? (string) $in['note'] : null;

if ($messageId <= 0) {
    out(400, ['error' => 'A message id is required.']);
}

$conversations = new Conversations();
$ctx = $conversations->messageContext($messageId);
if ($ctx === null || $ctx['user_id'] !== $userId) {
    // Either it doesn't exist or it isn't the user's — same opaque answer.
    out(404, ['error' => 'Message not found.']);
}

try {
    $conversationId = $ctx['conversation_id'];

    // Build a small context window: a few messages ending at the reported one.
    $all = $conversations->messages($conversationId);
    $window = [];
    foreach ($all as $m) {
        $window[] = $m;
        if ((int) $m['id'] === $messageId) {
            break;
        }
    }
    $window = array_slice($window, -12); // reported message + up to 11 preceding, for context

    $context = array_map(static function (array $m): array {
        return [
            'role'      => (string) $m['role'],
            'tool_name' => $m['tool_name'] !== null ? (string) $m['tool_name'] : null,
            'content'   => mb_substr((string) $m['content'], 0, 800),
        ];
    }, $window);

    $card = $ctx['card'] !== null ? json_decode($ctx['card'], true) : null;
    $diag = $ctx['diagnostics'] !== null ? json_decode($ctx['diagnostics'], true) : null;

    $snapshot = [
        'reported' => [
            'id'          => $messageId,
            'role'        => $ctx['role'],
            'content'     => $ctx['content'],
            'tool_name'   => $ctx['tool_name'],
            'card_kind'   => is_array($card) ? ($card['kind'] ?? null) : null,
            'diagnostics' => is_array($diag) ? $diag : null,
            'created_at'  => $ctx['created_at'],
        ],
        'context'     => $context,
        'reported_at' => date('c'),
    ];

    $reports  = new FeedbackReports();
    $reportId = $reports->create($userId, $conversationId, $messageId, $note, $snapshot);

    // Notify the developer(s) by email — best-effort, never fails the request.
    try {
        notifyAdmins($users, $userId, $reportId, $note, $ctx, $diag);
    } catch (\Throwable $e) {
        error_log('report.php notify: ' . $e->getMessage());
    }

    out(200, ['ok' => true, 'id' => $reportId]);
} catch (\Throwable $e) {
    error_log('report.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not send the report.']);
}

/**
 * @param array<string, mixed> $ctx
 * @param array<string, mixed>|null $diag
 */
function notifyAdmins(Users $users, int $reporterId, int $reportId, ?string $note, array $ctx, ?array $diag): void
{
    $admins = $users->adminContacts();
    if ($admins === []) {
        return;
    }
    $reporter = $users->findById($reporterId);
    $who      = is_array($reporter) ? (string) ($reporter['name'] ?: $reporter['email']) : ('user #' . $reporterId);

    $routing = is_array($diag) && isset($diag['routing']) ? implode(', ', (array) $diag['routing']) : '—';
    $calls   = '';
    if (is_array($diag) && !empty($diag['calls'])) {
        foreach ($diag['calls'] as $c) {
            $calls .= '<li><code>' . htmlspecialchars((string) ($c['name'] ?? '')) . '</code>'
                . (($c['ok'] ?? true) ? '' : ' <b>ERROR:</b> ' . htmlspecialchars((string) ($c['error'] ?? '')))
                . '</li>';
        }
    }

    $body = '<h2>Kachow feedback #' . $reportId . '</h2>'
        . '<p><b>From:</b> ' . htmlspecialchars($who) . '</p>'
        . ($note !== null && trim($note) !== ''
            ? '<p><b>Note:</b><br>' . nl2br(htmlspecialchars($note)) . '</p>' : '')
        . '<p><b>Reported message (' . htmlspecialchars((string) $ctx['role']) . '):</b></p>'
        . '<blockquote>' . nl2br(htmlspecialchars(mb_substr((string) $ctx['content'], 0, 1500))) . '</blockquote>'
        . '<p><b>Routing:</b> ' . htmlspecialchars($routing) . '</p>'
        . ($calls !== '' ? '<p><b>Tool calls:</b></p><ul>' . $calls . '</ul>' : '')
        . '<p style="color:#888">Reply in Kachow: “any feedback reports?”</p>';

    $mailer = NativeMailer::fromEnv();
    foreach ($admins as $a) {
        $mailer->send($a['email'], 'Kachow feedback #' . $reportId . ' from ' . $who, $body);
    }
}
