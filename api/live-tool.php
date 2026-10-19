<?php

declare(strict_types=1);

/**
 * Runs ONE tool call from a voice session (the browser forwards what Gemini Live asked for). Allow-listed tools only,
 * owner-scoped by the session. Returns what the model should be told (trimmed) and, separately, the card to show on
 * screen. Every call is logged (name, latency, error); a failed call also becomes a feedback report for the developer.
 *
 *   POST { session_id, name, args }  → { ok, result, card, ms }
 */

require __DIR__ . '/../bootstrap.php';

use App\Assistant\AssistantLoop;
use App\Assistant\GeminiClient;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\FeedbackReports;
use App\Data\Memories;
use App\Data\RememberTokens;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Data\UserSettings;
use App\Data\VoiceLog;
use App\Notify\Notifier;
use App\Tools\RegistryFactory;
use App\Voice\ConfirmGate;
use App\Voice\VoiceAlert;
use App\Voice\VoiceToolRunner;

header('Content-Type: application/json');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
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
if (!$users->isAdmin($userId)) {
    out(403, ['error' => 'Voice mode is still a developer preview.']);
}

$in        = json_decode((string) file_get_contents('php://input'), true);
$in        = is_array($in) ? $in : [];
$sessionId = (string) ($in['session_id'] ?? '');
$name      = (string) ($in['name'] ?? '');
$args      = is_array($in['args'] ?? null) ? $in['args'] : [];
$turn      = max(0, (int) ($in['turn'] ?? 0));

$log = new VoiceLog();
$convId = $log->sessionConversation($userId, $sessionId);
if ($convId === null) {
    out(404, ['error' => 'Unknown voice session.']);
}
if ($name === '') {
    out(400, ['error' => 'A tool name is required.']);
}

try {
    $memories      = new Memories();
    $instructions  = new UserInstructions();
    $conversations = new Conversations();
    $registry      = RegistryFactory::standard($users, $memories, $instructions);

    // "Ask the full assistant": the normal text loop, in a conversation of its own per voice session.
    $gateway = function (string $request) use ($userId, $sessionId, $log, $conversations, $registry, $memories, $instructions): array {
        $gwConv = $log->gatewayConversation($sessionId);
        if ($gwConv === null) {
            $gwConv = $conversations->start($userId);
            $conversations->setTitle($userId, $gwConv, 'Voice → assistant');
            $log->add($userId, $sessionId, 'gateway', $gwConv);
        }
        $loop  = new AssistantLoop(GeminiClient::fromEnv(), $registry, $conversations, $instructions, $memories, new UserSettings());
        $reply = $loop->handle($userId, $gwConv, $request);

        return ['reply' => $reply, 'card' => $loop->lastRender()];
    };

    $res = (new VoiceToolRunner($registry, $gateway, new ConfirmGate($log)))->run($name, $args, $userId, $sessionId, $turn, $convId);

    $argText = mb_substr((string) json_encode($args, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 0, 400);
    if ($res['ok']) {
        $log->add($userId, $sessionId, 'tool_call', $convId, $name, true, $res['ms'], ['args' => $argText]);
    } else {
        $log->add($userId, $sessionId, 'tool_error', $convId, $name, false, $res['ms'], ['args' => $argText, 'error' => mb_substr((string) $res['error'], 0, 500)]);
        // A tool that THREW (a bug or an outage) reaches the developer without anyone reporting it, at most a few per session.
        // An error the model can act on ("no time given") is only logged.
        if ($res['fault'] && $log->countKind($sessionId, 'auto_report') < VoiceAlert::MAX_PER_SESSION) {
            try {
                $transcript = [];
                foreach (array_slice($conversations->messages($convId), -10) as $m) {
                    if (in_array($m['role'], ['user', 'assistant'], true)) {
                        $transcript[] = ['role' => (string) $m['role'], 'content' => (string) $m['content']];
                    }
                }
                $notifier = null;
                try {
                    $notifier = Notifier::fromEnv();
                } catch (\Throwable $e) {
                    // push not configured: the report is still created
                }
                $rid = VoiceAlert::report(new FeedbackReports(), $notifier, $users, $userId, $convId,
                    ['name' => $name, 'args' => $argText, 'error' => (string) $res['error'], 'ms' => $res['ms']], $transcript);
                $log->add($userId, $sessionId, 'auto_report', $convId, $name, null, null, ['report_id' => $rid]);
            } catch (\Throwable $e) {
                error_log('live-tool.php auto-report: ' . $e->getMessage());
            }
        }
    }

    out(200, ['ok' => $res['ok'], 'result' => $res['result'], 'card' => $res['card'], 'ms' => $res['ms']]);
} catch (\Throwable $e) {
    error_log('live-tool.php: ' . $e->getMessage());
    out(500, ['ok' => false, 'result' => ['error' => 'The tool failed.'], 'card' => null, 'debug' => get_class($e) . ': ' . $e->getMessage()]);
}
