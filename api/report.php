<?php

declare(strict_types=1);

/**
 * "Report to developer" — a user flags a specific message that looked off. Stores a
 * self-contained snapshot (the message + a little context + its diagnostics) and pushes
 * a notification to the developer(s). Owner-scoped: you can only report a message in your own conversation.
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
use App\Notify\NotificationTypes;
use App\Notify\Notifier;

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

    // Push the developer(s) — best-effort, never fails the request.
    try {
        notifyAdmins($users, $userId, $reportId, $note, $ctx);
    } catch (\Throwable $e) {
        error_log('report.php notify: ' . $e->getMessage());
    }

    out(200, ['ok' => true, 'id' => $reportId]);
} catch (\Throwable $e) {
    error_log('report.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not send the report.']);
}

/**
 * Pushes "new feedback report" to the developer(s) — replaces the old e-mail. Tapping it opens the
 * open reports (api/card.php?for=feedback). The push also lands in the in-app notification history.
 *
 * @param array<string, mixed> $ctx
 */
function notifyAdmins(Users $users, int $reporterId, int $reportId, ?string $note, array $ctx): void
{
    $adminIds = $users->adminIds();
    if ($adminIds === []) {
        return;
    }
    $reporter = $users->findById($reporterId);
    $who      = is_array($reporter) ? (string) ($reporter['name'] ?: $reporter['email']) : ('user #' . $reporterId);

    // The note if there is one, otherwise what was flagged — one short line.
    $what = $note !== null && trim($note) !== '' ? trim($note) : trim((string) $ctx['content']);
    $what = trim((string) preg_replace('/\s+/u', ' ', $what));
    $body = ($what === '' ? 'A message was flagged.' : mb_substr($what, 0, 140) . (mb_strlen($what) > 140 ? '…' : ''));

    $notifier = Notifier::fromEnv();
    foreach ($adminIds as $adminId) {
        $notifier->notify($adminId, NotificationTypes::FEEDBACK_REPORT, 'Feedback #' . $reportId . ' from ' . $who, $body);
    }
}
