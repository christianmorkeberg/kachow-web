<?php

declare(strict_types=1);

/**
 * Export dev ideas as a Markdown download — one, several or all (the card's export button).
 * The developer exports from the whole shared backlog, anyone else from their own ideas.
 *
 *   GET ?ids=12,15,20            → exactly those ideas (any status)
 *   GET ?filter=open|new|in_progress|done|all   → everything with that status (default open)
 *   → kachow-dev-ideas.md (or kachow-dev-idea-12.md for a single one)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\DevIdeas;
use App\Data\RememberTokens;
use App\Data\Users;

function fail(int $code, string $msg): never
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $msg;
    exit;
}

$users   = new Users();
$session = new Session($users);
$session->boot();
if (!$session->isLoggedIn()) {
    $remembered = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($remembered !== null) {
        $session->establish($remembered);
    }
}
if (!$session->isLoggedIn()) {
    fail(401, 'Not authenticated.');
}
$userId = (int) $session->userId();

try {
    $ideas = new DevIdeas();
    $all   = $users->isAdmin($userId) ? $ideas->listAll() : $ideas->listForUser($userId);

    $ids = array_values(array_unique(array_filter(
        array_map('intval', explode(',', (string) ($_GET['ids'] ?? ''))),
        static fn (int $i): bool => $i > 0
    )));
    if ($ids !== []) {
        $pick = array_values(array_filter($all, static fn (array $i): bool => in_array($i['id'], $ids, true)));
    } else {
        $filter = (string) ($_GET['filter'] ?? 'open');
        $pick   = array_values(array_filter($all, static fn (array $i): bool => match ($filter) {
            'all'   => true,
            'new', 'in_progress', 'done' => $i['status'] === $filter,
            default => $i['status'] !== 'done',
        }));
    }
    if ($pick === []) {
        fail(404, 'No ideas to export.');
    }
    // "from" only when someone else suggested it.
    foreach ($pick as &$i) {
        if (($i['user_id'] ?? 0) === $userId) {
            unset($i['from']);
        }
    }
    unset($i);

    $name = count($pick) === 1 ? 'kachow-dev-idea-' . $pick[0]['id'] . '.md' : 'kachow-dev-ideas.md';
    header('Content-Type: text/markdown; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $name . '"');
    header('Cache-Control: no-store');
    echo DevIdeas::exportMarkdown($pick);
} catch (\Throwable $e) {
    error_log('dev-ideas-export.php: ' . $e->getMessage());
    fail(500, 'Something went wrong.');
}
