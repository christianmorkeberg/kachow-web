<?php

declare(strict_types=1);

/**
 * Settings card actions (authenticated session, JSON) — the tap affordances on the
 * personality slider card. Own settings only.
 *
 *   POST { key:'personality', value:'off'|'subtle'|'full' } → save it, returns the card
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
$userId = (int) $session->userId();

// GET → the user's current setting values, so the app can apply the saved theme on
// load across devices (after the instant localStorage apply that avoids a flash).
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    $read   = new UserSettings();
    $values = [];
    foreach (UserSettings::keys() as $k) {
        $values[$k] = $read->get($userId, $k);
    }
    out(200, ['ok' => true, 'values' => $values]);
}

$in    = json_decode((string) file_get_contents('php://input'), true);
$key   = is_array($in) ? trim((string) ($in['key'] ?? '')) : '';
$value = is_array($in) ? trim((string) ($in['value'] ?? '')) : '';

if (!UserSettings::exists($key)) {
    out(400, ['error' => 'Unknown setting.']);
}
// Canonicalise the values the cards drive.
if ($key === 'personality') {
    $value = UserSettings::normalizePersonality($value);
} elseif ($key === 'theme') {
    $value = UserSettings::normalizeTheme($value);
}

$settings = new UserSettings();
$settings->set($userId, $key, $value);
$saved = $settings->get($userId, $key) ?? '';

$card = null;
if ($key === 'personality') {
    $card = UserSettings::personalityCard($saved);
} elseif ($key === 'theme') {
    $card = UserSettings::appearanceCard($saved);
}

out(200, ['ok' => true, 'key' => $key, 'value' => $saved, 'card' => $card]);
