<?php

declare(strict_types=1);

/**
 * Saves the voice language chosen with the EN | DA switch (the setting voice_language), so it stays the same for the
 * user on every device. Authenticated session, JSON.
 *
 *   POST { language: "en" | "da" } → { ok: true, language }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\UserSettings;

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
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    out(405, ['error' => 'POST only.']);
}

$in   = json_decode((string) file_get_contents('php://input'), true);
$lang = is_array($in) ? strtolower(trim((string) ($in['language'] ?? ''))) : '';
if (!in_array($lang, ['en', 'da'], true)) {
    out(400, ['error' => 'Language must be "en" or "da".']);
}

try {
    (new UserSettings())->set((int) $session->userId(), 'voice_language', $lang);
} catch (\Throwable $e) {
    error_log('live-language.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not save the language.']);
}

out(200, ['ok' => true, 'language' => $lang]);
