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

$in    = json_decode((string) file_get_contents('php://input'), true);
$key   = is_array($in) ? trim((string) ($in['key'] ?? '')) : '';
$value = is_array($in) ? trim((string) ($in['value'] ?? '')) : '';

if (!UserSettings::exists($key)) {
    out(400, ['error' => 'Unknown setting.']);
}
// The slider only drives the personality dial; keep it to its known values.
if ($key === 'personality' && !in_array(strtolower($value), UserSettings::PERSONALITY_LEVELS, true)) {
    out(400, ['error' => 'Invalid personality level.']);
}

$settings = new UserSettings();
$settings->set($userId, $key, $value);
$saved = $settings->get($userId, $key) ?? '';

out(200, [
    'ok'    => true,
    'key'   => $key,
    'value' => $saved,
    'card'  => $key === 'personality' ? UserSettings::personalityCard($saved) : null,
]);
