<?php

declare(strict_types=1);

/**
 * The Settings card and its actions (authenticated session, JSON). Own settings only.
 *
 *   GET ?card=1                    → { ok, card }   the Settings card (every setting, grouped, with its current value)
 *   GET                            → { ok, values } the current value of every setting (the app applies the saved theme on load)
 *   POST { key, value }            → save it ('' = back to the default), returns { ok, key, value, card? }
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
    if (isset($_GET['card'])) {
        out(200, ['ok' => true, 'card' => $read->settingsCard($userId)]);
    }
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
if ($key === 'work_clock' && $value !== '') {
    $value = UserSettings::normalizeWorkClock($value) ?? '';
    if ($value === '') {
        out(400, ['error' => 'Work clock must be manual or automatic (location).']);
    }
}
if ($key === 'personality') {
    $value = UserSettings::normalizePersonality($value);
} elseif (in_array($key, ['theme', 'theme_dark', 'theme_light'], true)) {
    $value = UserSettings::normalizeThemeFor($key, $value);   // theme may be "auto" (follow the device)
} elseif ($key === 'home_cards') {
    $value = UserSettings::normalizeHomeCards($value);          // known card keys only; empty = the default rail
}

$settings = new UserSettings();
$settings->set($userId, $key, $value);
$saved = $settings->get($userId, $key) ?? '';

$card = null;
if (in_array($key, ['theme', 'theme_dark', 'theme_light'], true)) {
    $card = $settings->appearance($userId);
}

out(200, ['ok' => true, 'key' => $key, 'value' => $saved, 'card' => $card]);
