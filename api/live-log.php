<?php

declare(strict_types=1);

/**
 * What the browser saw during a voice session: events (setup complete, time to first audio, interruptions, cancelled
 * calls, GoAway, idle/limit close, errors) go to the voice log; the spoken turns (transcriptions) are saved into the
 * session's conversation so voice and text share history. Also sent by sendBeacon when the page closes.
 *
 *   POST { session_id, events?: [{kind, name?, ok?, ms?, detail?}], transcript?: [{role: user|assistant, text}] }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\VoiceLog;

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

/** The kinds the browser may log (tool calls are logged by live-tool.php, the start by live-token.php). */
const CLIENT_KINDS = ['setup_complete', 'first_audio', 'interrupted', 'cancelled', 'goaway', 'resume', 'idle_close', 'limit_close', 'session_end', 'client_error'];

$in        = json_decode((string) file_get_contents('php://input'), true);
$in        = is_array($in) ? $in : [];
$sessionId = (string) ($in['session_id'] ?? '');

$log    = new VoiceLog();
$convId = $log->sessionConversation($userId, $sessionId);
if ($convId === null) {
    out(404, ['error' => 'Unknown voice session.']);
}

try {
    $n = 0;
    foreach (array_slice((array) ($in['events'] ?? []), 0, 50) as $e) {
        if (!is_array($e) || !in_array($e['kind'] ?? '', CLIENT_KINDS, true)) {
            continue;
        }
        $detail = is_array($e['detail'] ?? null) ? $e['detail'] : null;
        $log->add($userId, $sessionId, (string) $e['kind'], $convId, isset($e['name']) ? (string) $e['name'] : null,
            isset($e['ok']) ? (bool) $e['ok'] : null, isset($e['ms']) ? max(0, (int) $e['ms']) : null, $detail);
        $n++;
    }

    $saved = 0;
    if ($convId > 0) {
        $conversations = new Conversations();
        foreach (array_slice((array) ($in['transcript'] ?? []), 0, 40) as $t) {
            $role = is_array($t) ? (string) ($t['role'] ?? '') : '';
            $text = is_array($t) ? trim((string) ($t['text'] ?? '')) : '';
            if ($text === '' || !in_array($role, ['user', 'assistant'], true)) {
                continue;
            }
            $conversations->addMessage($convId, $role, mb_substr($text, 0, 2000));
            $saved++;
        }
    }
    out(200, ['ok' => true, 'events' => $n, 'saved' => $saved]);
} catch (\Throwable $e) {
    error_log('live-log.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not save the voice log.']);
}
