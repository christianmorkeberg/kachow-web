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
use App\Data\RememberTokens;
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

    // GET: one conversation's messages (reopen).
    if (isset($_GET['id'])) {
        $id = (int) $_GET['id'];
        if ($conversations->ownerId($id) !== $userId) {
            out(404, ['error' => 'Conversation not found.']);
        }
        $out = [];
        foreach ($conversations->messages($id) as $m) {
            $role = (string) $m['role'];
            if ($role !== 'user' && $role !== 'assistant') {
                continue; // internal tool rows aren't shown
            }
            $content = (string) $m['content'];
            $card    = null;
            if ($role === 'assistant' && isset($m['card']) && $m['card'] !== null && $m['card'] !== '') {
                $decoded = json_decode((string) $m['card'], true);
                $card    = is_array($decoded) ? $decoded : null;
            }
            $out[] = [
                'role'    => $role,
                'content' => $content,
                'html'    => $role === 'assistant' ? Markdown::toHtml($content) : null,
                'card'    => $card,
            ];
        }
        out(200, ['id' => $id, 'title' => $conversations->title($userId, $id), 'messages' => $out]);
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
