<?php

declare(strict_types=1);

/**
 * Live progress of the caller's in-flight chat turn (authenticated session, JSON), polled
 * by the browser while it waits for api/chat.php — so the typing bubble can show what the
 * assistant is doing ("checking your calendar…"). Own turns only (the file is keyed by the
 * session's user id). Tool names + status only, never arguments or content.
 *
 *   GET ?turn=<hex id> → { phase, steps: [{tool, status}] } | { phase: null }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\Session;
use App\Data\Users;
use App\Support\TurnProgress;

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

$session = new Session(new Users());
$session->boot();
if (!$session->isLoggedIn()) {
    out(401, ['error' => 'Not authenticated.']);
}
$userId = (int) $session->userId();
session_write_close(); // read-only; never hold the session lock while polling

$turn = isset($_GET['turn']) ? (string) $_GET['turn'] : '';
if (!TurnProgress::validId($turn)) {
    out(400, ['error' => 'Invalid turn id.']);
}

$state = (new TurnProgress($userId, $turn))->read();
out(200, $state ?? ['phase' => null, 'steps' => []]);
