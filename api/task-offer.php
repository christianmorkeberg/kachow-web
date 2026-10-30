<?php

declare(strict_types=1);

/**
 * A scheduled task's "do you want me to …?" (notify_me's `offer`): what the Run / Skip sheet opened by the push talks to.
 *
 *   GET  ?id=N                           → { ok, offer: { id, question, status, steps, result } }
 *   POST { id, decision: "run"|"skip" }  → run answers at once ({status:"running"}) and makes the stored calls in the background (house tools only);
 *                                          the sheet polls GET until the status is done / failed. A second tap or device gets the current state.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\Memories;
use App\Data\RememberTokens;
use App\Data\TaskOffers;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Support\Detach;
use App\Tools\RegistryFactory;

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/** @param array<string, mixed> $o */
function view(array $o): array
{
    return ['id' => $o['id'], 'question' => $o['question'], 'status' => $o['status'], 'steps' => count($o['calls']), 'result' => $o['result']];
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
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();   // the run below can take a while: do not hold the session
}

try {
    $offers = new TaskOffers();
    $isPost = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST';
    $in     = $isPost ? (json_decode((string) file_get_contents('php://input'), true) ?: []) : [];
    $id     = (int) ($isPost ? ($in['id'] ?? 0) : ($_GET['id'] ?? 0));
    $offer  = $id > 0 ? $offers->get($userId, $id) : null;
    if ($offer === null) {
        out(404, ['error' => 'That question is gone.']);
    }
    if (!$isPost) {
        out(200, ['ok' => true, 'offer' => view($offer)]);
    }

    $decision = (string) ($in['decision'] ?? '');
    if ($decision === 'skip') {
        $offers->skip($userId, $id);
        out(200, ['ok' => true, 'offer' => view($offers->get($userId, $id) ?? $offer)]);
    }
    if ($decision !== 'run') {
        out(400, ['error' => 'decision must be run or skip.']);
    }
    if (!$offers->claim($userId, $id)) {
        out(200, ['ok' => true, 'offer' => view($offer)]);   // already answered (a double tap, or another device): just say how it stands
    }

    // Answer now, then make the calls: eleven lights go through the home agent one at a time and take a while.
    $running = $offer;
    $running['status'] = 'running';
    $body = ['ok' => true, 'offer' => view($running)];
    if (Detach::available()) {
        Detach::release(200, $body, 120);
    } else {
        // no early release on this server: the page waits for the run (it shows "Running…" until the answer arrives)
    }
    $registry = RegistryFactory::standard($users, new Memories(), new UserInstructions());
    $res      = TaskOffers::run($registry, $userId, $offer['calls']);
    $offers->finish($userId, $id, $res['ok'] ? 'done' : 'failed', $res['text']);
    if ($offer['conversation_id'] !== null) {
        try {
            (new Conversations())->addMessage($offer['conversation_id'], 'assistant', ($res['ok'] ? '✅ ' : '⚠️ ') . $res['text'] . ' (' . $offer['question'] . ')');
        } catch (\Throwable $e) {
            error_log('task-offer.php conversation note: ' . $e->getMessage());
        }
    }
    if (!Detach::available()) {
        out(200, ['ok' => true, 'offer' => view($offers->get($userId, $id) ?? $running)]);
    }
    exit;
} catch (\Throwable $e) {
    error_log('task-offer.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.', 'debug' => get_class($e) . ': ' . $e->getMessage()]);
}
