<?php

declare(strict_types=1);

/**
 * Starts a voice (Gemini Live) session — developer only while voice mode is a spike. Checks the daily voice-minutes
 * cap, builds the session setup (voice, system instruction with the user's agenda, memories and instructions, the voice
 * tools), mints a short-lived single-use Live token so the browser can connect to Google directly without the API key,
 * and opens the session in the voice log with its own conversation (the transcript is saved there).
 *
 *   POST { tool_mode?: "auto"|"nonblocking"|"blocking" }
 *   → { token, ws_url, setup, session_id, conversation_id, remaining_seconds, idle_seconds, tool_mode }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Conversations;
use App\Data\Memories;
use App\Data\RememberTokens;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Data\UserSettings;
use App\Data\VoiceLog;
use App\Tools\RegistryFactory;
use App\Voice\LiveTokens;
use App\Voice\VoiceSession;

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
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    out(405, ['error' => 'POST only.']);
}

try {
    $in       = json_decode((string) file_get_contents('php://input'), true);
    $hint     = is_array($in) ? mb_substr((string) ($in['lang_hint'] ?? ''), 0, 16) : '';
    $toolMode = is_array($in) && in_array($in['tool_mode'] ?? '', ['auto', 'nonblocking', 'blocking'], true) ? (string) $in['tool_mode'] : 'auto';

    $settings = new UserSettings();
    $limits   = VoiceSession::limits($settings->get($userId, 'voice_daily_minutes'), $settings->get($userId, 'voice_idle_seconds'));
    $log      = new VoiceLog();
    $left     = $limits['daily_seconds'] - $log->usedSecondsToday($userId);
    if ($left < 10) {
        out(429, ['error' => 'The voice limit for today is used up (' . intdiv($limits['daily_seconds'], 60) . ' min). It resets at midnight.', 'remaining_seconds' => 0]);
    }

    // The EN | DA switch's saved choice; until one is made, the browser language decides (and is saved, so it stays).
    $storedLang = (string) $settings->get($userId, 'voice_language');
    $language   = VoiceSession::resolveLanguage($storedLang, $hint);
    if (VoiceSession::language($storedLang) === 'auto') {
        $settings->set($userId, 'voice_language', $language);
    }

    // The routines (names + phrases), so "I'm leaving" in voice runs one.
    $routineLines = '';
    try {
        foreach ((new \App\Data\Routines())->active($userId) as $r) {
            $routineLines .= '- ' . $r['label'] . ($r['phrases'] !== [] ? ' — says: ' . implode(' / ', array_map(static fn (string $x): string => '"' . $x . '"', $r['phrases'])) : '') . "\n";
        }
    } catch (\Throwable $e) {
        error_log('live-token.php routines: ' . $e->getMessage());   // not migrated yet: no routines
    }

    $stopWords = VoiceSession::stopWords($settings->get($userId, 'voice_stop_words'));

    $memories     = new Memories();
    $instructions = new UserInstructions();
    $registry     = RegistryFactory::standard($users, $memories, $instructions);

    // The next week's agenda, so "this event" / "move it to Thursday" needs one update call, not a look-up first.
    $agenda = '';
    try {
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $res = $registry->dispatch('get_calendar_events', [
            'from' => $now->setTime(0, 0)->modify('-1 day')->format('Y-m-d\TH:i:s\Z'),
            'to'   => $now->modify('+7 days')->format('Y-m-d\TH:i:s\Z'),
        ], $userId);
        $agenda = VoiceSession::agenda((array) ($res['events'] ?? []));
    } catch (\Throwable $e) {
        error_log('live-token.php agenda: ' . $e->getMessage());   // no calendar connected / Google down: the session goes on without it
    }

    $setup = VoiceSession::setup(
        $registry,
        (string) $settings->get($userId, 'voice_model'),
        (string) $settings->get($userId, 'voice_name'),
        $toolMode,
        $memories->all($userId),
        $instructions->all($userId),
        $agenda,
        null,
        $language,
        $stopWords,
        rtrim($routineLines)
    );

    $apiKey = (string) ($_ENV['GEMINI_API_KEY'] ?? '');
    if ($apiKey === '') {
        out(500, ['error' => 'GEMINI_API_KEY is not configured.']);
    }
    try {
        $token = (new LiveTokens($apiKey))->mint();
    } catch (\Throwable $e) {
        error_log('live-token.php mint: ' . $e->getMessage());
        out(502, ['error' => $e->getMessage()]);
    }

    $conversations  = new Conversations();
    $conversationId = $conversations->start($userId);
    $conversations->setTitle($userId, $conversationId, 'Voice ' . (new DateTimeImmutable('now', new DateTimeZone('Europe/Copenhagen')))->format('j M H:i'));
    $sessionId = bin2hex(random_bytes(16));
    $log->add($userId, $sessionId, 'session_start', $conversationId, null, null, null, [
        'tool_mode' => $toolMode, 'model' => (string) $settings->get($userId, 'voice_model'), 'agenda_events' => $agenda === '' ? 0 : substr_count($agenda, "\n") + 1,
    ]);

    out(200, [
        'token'             => $token['token'],
        'ws_url'            => LiveTokens::WS,
        'setup'             => $setup,
        'session_id'        => $sessionId,
        'conversation_id'   => $conversationId,
        'remaining_seconds' => $left,
        'idle_seconds'      => $limits['idle_seconds'],
        'tool_mode'         => $toolMode,
        'language'          => $language,
        'stop_words'        => $stopWords,
        'slow_tools'        => \App\Voice\VoiceTools::SLOW,
    ]);
} catch (\Throwable $e) {
    error_log('live-token.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not start a voice session.', 'debug' => get_class($e) . ': ' . $e->getMessage()]);
}
