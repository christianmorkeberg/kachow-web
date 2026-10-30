<?php

declare(strict_types=1);

/**
 * Chat history endpoint (authenticated session).
 *
 *   GET                       → list the user's conversations (history)
 *   GET  ?q=text              → search the user's conversations
 *   GET  ?id=N                → one conversation's messages (to reopen it)
 *   POST { action:'delete',         id }
 *   POST { action:'generate_title', id }  → AI-title it if missing, returns the title
 *
 * All operations are scoped to the logged-in user.
 */

require __DIR__ . '/../bootstrap.php';

use App\Assistant\ConversationTitler;
use App\Assistant\GeminiClient;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\NotificationHistory;
use App\Data\RememberTokens;
use App\Data\ScheduledTasks;
use App\Data\Users;
use App\Support\Markdown;

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

$conversations = new Conversations();

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $action = is_array($in) ? (string) ($in['action'] ?? '') : '';
        $id     = (int) ($in['id'] ?? 0);
        if ($id <= 0) {
            out(400, ['error' => 'A conversation id is required.']);
        }

        if ($action === 'delete') {
            out(200, ['ok' => $conversations->delete($userId, $id)]);
        }

        if ($action === 'generate_title') {
            $titler = new ConversationTitler(GeminiClient::fromEnv(), $conversations);
            out(200, ['title' => $titler->ensure($userId, $id)]);
        }

        out(400, ['error' => 'Unknown action.']);
    }

    // GET ?recent=1 → the most recent conversation + server-side idle age, so the
    // client can decide whether to resume it or start fresh after a gap.
    if (isset($_GET['recent'])) {
        out(200, [
            'recent'      => $conversations->mostRecent($userId),
            // Scheduled tasks that found something, so the client can show a "here's
            // something to see" banner even if the push notification was missed.
            'unseen_tasks' => (new ScheduledTasks())->unseenForUser($userId),
        ]);
    }

    // GET: one conversation's messages (reopen).
    if (isset($_GET['id'])) {
        $id = (int) $_GET['id'];
        if ($conversations->ownerId($id) !== $userId) {
            out(404, ['error' => 'Conversation not found.']);
        }
        // Best-effort: if this is a scheduled task's own conversation, opening it is
        // what "seeing" the result means.
        try {
            (new ScheduledTasks())->clearUnseenByConversation($userId, $id);
        } catch (\Throwable $e) {
            error_log('conversations.php clearUnseenByConversation: ' . $e->getMessage());
        }
        try {
            (new NotificationHistory())->markReadByUrl($userId, '/?conv=' . $id);
        } catch (\Throwable $e) {
            error_log('conversations.php markReadByUrl: ' . $e->getMessage());
        }
        // A scheduled task's own conversation reads differently: its "user" lines are the task's
        // stored instruction (not something typed), and a notify_me call is shown as the notification.
        $task = null;
        try {
            $task = (new ScheduledTasks())->byConversation($userId, $id);
        } catch (\Throwable $e) {
            error_log('conversations.php byConversation: ' . $e->getMessage());
        }
        // ?after=M: only the messages newer than M — the chat page polls with it for the late answer of a turn that went on in the background,
        // and each poll marks the chat as watched (so no push is sent for something already on the screen).
        $after = isset($_GET['after']) ? (int) $_GET['after'] : 0;
        if ($after > 0) {
            \App\Support\Detach::touchWatch($userId, $id);
        }
        $out = [];
        foreach ($conversations->messages($id) as $m) {
            if ($after > 0 && (int) $m['id'] <= $after) {
                continue;
            }
            $role = (string) $m['role'];
            if ($role === 'tool' && $task !== null && (string) ($m['tool_name'] ?? '') === 'notify_me') {
                $sent = json_decode((string) $m['content'], true);
                if (is_array($sent) && isset($sent['title'], $sent['body'])) {
                    $out[] = [
                        'id'      => (int) $m['id'],
                        'role'    => 'notification',
                        'content' => (string) $sent['title'] . "\n" . (string) $sent['body'],
                        'html'    => null,
                        'card'    => null,
                        'at'      => (string) $m['created_at'],
                    ];
                }
                continue;
            }
            if ($role !== 'user' && $role !== 'assistant') {
                continue; // internal tool rows aren't shown
            }
            $content = (string) $m['content'];
            if ($role === 'user') {
                $content = ScheduledTasks::stripRunPreamble($content);
            }
            $card    = null;
            if ($role === 'assistant' && isset($m['card']) && $m['card'] !== null && $m['card'] !== '') {
                $decoded = json_decode((string) $m['card'], true);
                $card    = is_array($decoded) ? $decoded : null;
            }
            $diagnostics = null;
            if ($role === 'assistant' && isset($m['diagnostics']) && $m['diagnostics'] !== null && $m['diagnostics'] !== '') {
                $dd          = json_decode((string) $m['diagnostics'], true);
                $diagnostics = is_array($dd) ? $dd : null;
            }
            $out[] = [
                'id'          => (int) $m['id'],
                'role'        => $role === 'user' && $task !== null ? 'scheduled' : $role,
                'content'     => $content,
                'html'        => $role === 'assistant' ? Markdown::toHtml($content) : null,
                'card'        => $card,
                'diagnostics' => $diagnostics,
                // DB TIMESTAMP — despite config.php's UTC default for PHP's own clock, this
                // column is MySQL's own DEFAULT CURRENT_TIMESTAMP, stamped in the DB
                // connection's session zone (confirmed server-local, not UTC, by a 2h-off
                // hover time). The client parses it as local wall-clock time, no 'Z'.
                'at'          => (string) $m['created_at'],
            ];
        }
        out(200, [
            'id'        => $id,
            'title'     => $conversations->title($userId, $id),
            'scheduled' => $task !== null ? ['label' => $task['label']] : null,
            'messages'  => $out,
        ]);
    }

    // GET: search or list.
    $q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
    $list = $q !== '' ? $conversations->searchForUser($userId, $q) : $conversations->listForUser($userId);

    out(200, ['conversations' => array_map(static function (array $c): array {
        $ts = $c['last_at'] !== '' ? strtotime($c['last_at']) : false;

        return [
            'id'      => $c['id'],
            'title'   => $c['title'],
            'preview' => $c['preview'],
            'count'   => $c['count'],
            'when'    => $ts !== false ? date('j M', $ts) : '',
        ];
    }, $list)]);
} catch (\Throwable $e) {
    error_log('conversations.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
