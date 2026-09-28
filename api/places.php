<?php

declare(strict_types=1);

/**
 * The user's places (location tracking phase 2) for the places map card — authenticated
 * session, JSON, own data only.
 *
 *   POST { action: "list" }                                               → { card }
 *   POST { action: "create", name, type, lat, lon, radius_m }             → { card }   (circle)
 *   POST { action: "create", name, type, polygon: [[lat, lon], …] }       → { card }   (polygon)
 *   POST { action: "update", id, name?, type?, lat?, lon?, radius_m?, polygon? } → { card }
 *   POST { action: "delete", id }                                         → { card }
 *   Any action with suggest: true also returns the frequent-unnamed-place suggestions.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\LocationPoints;
use App\Data\Places;
use App\Data\RememberTokens;
use App\Data\Timeline;
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

$in     = json_decode((string) file_get_contents('php://input'), true);
$in     = is_array($in) ? $in : [];
$action = (string) ($in['action'] ?? 'list');
$fields = array_intersect_key($in, array_flip(['name', 'type', 'lat', 'lon', 'radius_m', 'polygon']));

try {
    $places = new Places();
    $focus  = null;
    if ($action === 'create') {
        $focus = $places->add($userId, $fields)['id'];
    } elseif ($action === 'update') {
        $focus = (int) ($in['id'] ?? 0);
        if ($places->update($userId, $focus, $fields) === null) {
            out(404, ['error' => 'No such place.']);
        }
    } elseif ($action === 'delete') {
        if (!$places->delete($userId, (int) ($in['id'] ?? 0))) {
            out(404, ['error' => 'No such place.']);
        }
    } elseif ($action !== 'list') {
        out(400, ['error' => 'Unknown action.']);
    }

    $points = new LocationPoints();
    $last   = $points->latest($userId);
    $card   = Places::card($places->list($userId), $focus, $last !== null ? [$last['lat'], $last['lon']] : null);
    if (!empty($in['suggest'])) {
        $card['suggestions'] = (new Timeline($points, $places, new UserSettings()))->suggestions($userId);
        $card['_persist_strip'][] = 'suggestions';
    }
    out(200, ['ok' => true, 'card' => $card]);
} catch (\InvalidArgumentException $e) {
    out(422, ['error' => $e->getMessage()]);
} catch (\Throwable $e) {
    error_log('places.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
