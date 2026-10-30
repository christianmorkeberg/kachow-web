<?php

declare(strict_types=1);

/**
 * Voice (Gemini Live) for the kiosk — the HOUSE only. The kiosk's sign-in (session, or the kiosk token cookie) works here and nowhere else in
 * the voice stack: live-token.php / live-tool.php / live-log.php stay logged-in-user only. A kiosk session gets App\Voice\KioskVoice::TOOLS
 * (lights, heating, prices, weather, reminders), no gateway to the full assistant, and a prompt without agenda, memories or instructions.
 *
 *   POST ?a=token    { lang_hint? }                          → { token, ws_url, setup, session_id, conversation_id, remaining_seconds, idle_seconds, tool_mode, language, stop_words, slow_tools }
 *   POST ?a=tool     { session_id, name, args, turn? }       → { ok, result, card:null, ms, summary }
 *   POST ?a=log      { session_id, events?, transcript? }    → { ok }
 *   POST ?a=language { language: en|da }                     → { ok }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\KioskAccess;
use App\Data\Conversations;
use App\Data\HomeDevices;
use App\Data\Memories;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Data\UserSettings;
use App\Data\VoiceLog;
use App\Tools\RegistryFactory;
use App\Voice\KioskVoice;
use App\Voice\LiveTokens;
use App\Voice\VoiceSession;
use App\Voice\VoiceToolRunner;

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

/** The kinds the browser may log (tool calls are logged here, the start by ?a=token). */
const CLIENT_KINDS = ['setup_complete', 'first_audio', 'interrupted', 'cancelled', 'goaway', 'resume', 'idle_close', 'limit_close', 'session_end', 'client_error', 'stop_word'];

$who = KioskAccess::resolve();
if ($who === null) {
    out(401, ['error' => 'Not authenticated.']);
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    out(405, ['error' => 'POST only.']);
}
$userId = $who['user_id'];
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

$in = json_decode((string) file_get_contents('php://input'), true);
$in = is_array($in) ? $in : [];
$a  = (string) ($_GET['a'] ?? '');

try {
    $settings = new UserSettings();
    $log      = new VoiceLog();

    if ($a === 'token') {
        $hint   = mb_substr((string) ($in['lang_hint'] ?? ''), 0, 16);
        $limits = VoiceSession::limits($settings->get($userId, 'voice_daily_minutes'), $settings->get($userId, 'voice_idle_seconds'));
        $left   = $limits['daily_seconds'] - $log->usedSecondsToday($userId);
        if ($left < 10) {
            out(429, ['error' => 'The voice limit for today is used up (' . intdiv($limits['daily_seconds'], 60) . ' min). It resets at midnight.', 'remaining_seconds' => 0]);
        }
        $language  = VoiceSession::resolveLanguage((string) $settings->get($userId, 'voice_language'), $hint);
        $stopWords = VoiceSession::stopWords($settings->get($userId, 'voice_stop_words'));

        $users    = new Users();
        $registry = RegistryFactory::standard($users, new Memories(), new UserInstructions());
        $setup    = VoiceSession::setup(
            $registry, (string) $settings->get($userId, 'voice_model'), (string) $settings->get($userId, 'voice_name'), 'auto',
            [], [], '', null, $language, $stopWords, '',
            KioskVoice::TOOLS, KioskVoice::prompt($language, $stopWords)
        );

        $apiKey = (string) ($_ENV['GEMINI_API_KEY'] ?? '');
        if ($apiKey === '') {
            out(500, ['error' => 'GEMINI_API_KEY is not configured.']);
        }
        try {
            $token = (new LiveTokens($apiKey))->mint();
        } catch (\Throwable $e) {
            error_log('kiosk-voice.php mint: ' . $e->getMessage());
            out(502, ['error' => $e->getMessage()]);
        }

        $conversations  = new Conversations();
        $conversationId = $conversations->start($userId);
        $conversations->setTitle($userId, $conversationId, 'Kiosk voice ' . (new DateTimeImmutable('now', new DateTimeZone('Europe/Copenhagen')))->format('j M H:i'));
        $sessionId = bin2hex(random_bytes(16));
        $log->add($userId, $sessionId, 'session_start', $conversationId, null, null, null, ['tool_mode' => 'auto', 'kiosk' => true, 'via' => $who['via']]);

        out(200, [
            'token' => $token['token'], 'ws_url' => LiveTokens::WS, 'setup' => $setup, 'session_id' => $sessionId, 'conversation_id' => $conversationId,
            'remaining_seconds' => $left, 'idle_seconds' => $limits['idle_seconds'], 'tool_mode' => 'auto', 'language' => $language,
            'stop_words' => $stopWords, 'slow_tools' => KioskVoice::SLOW,
        ]);
    }

    if ($a === 'language') {
        $lang = (string) ($in['language'] ?? '');
        if (!in_array($lang, ['en', 'da'], true)) {
            out(400, ['error' => 'language must be en or da.']);
        }
        $settings->set($userId, 'voice_language', $lang);
        out(200, ['ok' => true]);
    }

    $sessionId = (string) ($in['session_id'] ?? '');
    $convId    = $log->sessionConversation($userId, $sessionId);
    if ($convId === null) {
        out(404, ['error' => 'Unknown voice session.']);
    }

    if ($a === 'tool') {
        $name = (string) ($in['name'] ?? '');
        $args = is_array($in['args'] ?? null) ? $in['args'] : [];
        $turn = max(0, (int) ($in['turn'] ?? 0));
        if ($name === '') {
            out(400, ['error' => 'A tool name is required.']);
        }
        $registry = RegistryFactory::standard(new Users(), new Memories(), new UserInstructions());
        $homeName = static function (string $id) use ($userId): ?string {
            try {
                foreach ((new HomeDevices())->entries($userId, 'hue') as $e) {
                    if ($e['id'] === $id || $e['group'] === $id) {
                        return $e['name'];
                    }
                }
            } catch (\Throwable $e) {
                // no saved list: the line just says "a light"
            }

            return null;
        };
        // No gateway (nothing here reaches the full assistant) and only the kiosk's tools.
        $noGateway = static fn (string $request): array => ['reply' => 'Not available on this display.', 'card' => null];
        $res       = (new VoiceToolRunner($registry, $noGateway, null, $homeName, KioskVoice::TOOLS))->run($name, $args, $userId, $sessionId, $turn, $convId);
        $argText   = mb_substr((string) json_encode($args, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 0, 400);
        if ($res['ok']) {
            $log->add($userId, $sessionId, 'tool_call', $convId, $name, true, $res['ms'], ['args' => $argText]);
        } else {
            $log->add($userId, $sessionId, 'tool_error', $convId, $name, false, $res['ms'], ['args' => $argText, 'error' => mb_substr((string) $res['error'], 0, 500)]);
        }
        out(200, ['ok' => $res['ok'], 'result' => $res['result'], 'card' => null, 'ms' => $res['ms'], 'summary' => $res['summary']]);
    }

    if ($a === 'log') {
        $n = 0;
        foreach (array_slice((array) ($in['events'] ?? []), 0, 50) as $e) {
            if (!is_array($e) || !in_array($e['kind'] ?? '', CLIENT_KINDS, true)) {
                continue;
            }
            $log->add($userId, $sessionId, (string) $e['kind'], $convId, isset($e['name']) ? (string) $e['name'] : null,
                isset($e['ok']) ? (bool) $e['ok'] : null, isset($e['ms']) ? max(0, (int) $e['ms']) : null, is_array($e['detail'] ?? null) ? $e['detail'] : null);
            $n++;
        }
        $saved = 0;
        if ($convId > 0) {
            $conversations = new Conversations();
            foreach (array_slice((array) ($in['transcript'] ?? []), 0, 40) as $t) {
                $role = is_array($t) ? (string) ($t['role'] ?? '') : '';
                $text = is_array($t) ? trim((string) ($t['text'] ?? '')) : '';
                if ($text !== '' && in_array($role, ['user', 'assistant'], true)) {
                    $conversations->addMessage($convId, $role, mb_substr($text, 0, 2000));
                    $saved++;
                }
            }
        }
        out(200, ['ok' => true, 'events' => $n, 'saved' => $saved]);
    }

    out(400, ['error' => 'Unknown action.']);
} catch (\Throwable $e) {
    error_log('kiosk-voice.php: ' . $e->getMessage());
    out(500, ['error' => 'Voice failed on the server.']);
}
