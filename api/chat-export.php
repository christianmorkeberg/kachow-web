<?php

declare(strict_types=1);

/**
 * Export one conversation as a downloadable file (authenticated session).
 *
 *   GET ?id=N[&format=md|txt]
 *     → downloads the conversation's messages (owner-scoped).
 *
 * Only user/assistant turns are exported; internal tool rows are skipped. When an
 * assistant turn carried a rendered card, a short "[card: kind]" note is appended so
 * the export hints that a widget was shown without dumping raw JSON.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\RememberTokens;
use App\Data\Users;

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
    http_response_code(401);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not authenticated.';
    exit;
}
$userId = (int) $session->userId();

$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
if ($id <= 0) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'A conversation id is required.';
    exit;
}

$conversations = new Conversations();
if ($conversations->ownerId($id) !== $userId) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Conversation not found.';
    exit;
}

$format = (isset($_GET['format']) && strtolower((string) $_GET['format']) === 'txt') ? 'txt' : 'md';

$title = $conversations->title($userId, $id);
$title = ($title !== null && trim($title) !== '') ? trim($title) : 'Conversation';

// Build the document.
$md      = $format === 'md';
$eol     = "\r\n"; // Windows-friendly line endings for the downloaded file
$lines   = [];

if ($md) {
    $lines[] = '# ' . $title;
    $lines[] = '';
    $lines[] = '_Exported from Kachow · ' . date('j M Y, H:i') . '_';
} else {
    $lines[] = $title;
    $lines[] = 'Exported from Kachow · ' . date('j M Y, H:i');
    $lines[] = str_repeat('=', min(60, max(strlen($title), 20)));
}
$lines[] = '';

foreach ($conversations->messages($id) as $m) {
    $role = (string) $m['role'];
    if ($role !== 'user' && $role !== 'assistant') {
        continue; // internal tool rows aren't exported
    }

    $who     = $role === 'user' ? 'You' : 'Kachow';
    $when    = isset($m['created_at']) && $m['created_at'] !== null ? date('j M, H:i', strtotime((string) $m['created_at'])) : '';
    $content = trim((string) $m['content']);

    // A short note when this assistant turn showed a card widget.
    $cardNote = '';
    if ($role === 'assistant' && isset($m['card']) && $m['card'] !== null && $m['card'] !== '') {
        $decoded = json_decode((string) $m['card'], true);
        if (is_array($decoded) && isset($decoded['kind'])) {
            $cardNote = '[card: ' . (string) $decoded['kind'] . ']';
        }
    }

    if ($md) {
        $header = '**' . $who . '**' . ($when !== '' ? ' · ' . $when : '');
        $lines[] = $header;
        $lines[] = '';
        if ($content !== '') {
            $lines[] = $content;
        }
        if ($cardNote !== '') {
            $lines[] = ($content !== '' ? '' : '') . '_' . $cardNote . '_';
        }
        $lines[] = '';
        $lines[] = '---';
        $lines[] = '';
    } else {
        $lines[] = $who . ($when !== '' ? ' (' . $when . ')' : '') . ':';
        if ($content !== '') {
            $lines[] = $content;
        }
        if ($cardNote !== '') {
            $lines[] = $cardNote;
        }
        $lines[] = '';
    }
}

// Filename: a safe slug from the title.
$slug = strtolower($title);
$slug = preg_replace('/[^a-z0-9]+/i', '-', $slug) ?? '';
$slug = trim($slug, '-');
if ($slug === '') {
    $slug = 'conversation';
}
$fname = 'kachow-' . $slug . '-' . $id . '.' . $format;

$body = implode($eol, $lines);

header('Content-Type: ' . ($md ? 'text/markdown' : 'text/plain') . '; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $fname . '"');
header('Content-Length: ' . strlen($body));
echo $body;
