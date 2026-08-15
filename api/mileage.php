<?php

declare(strict_types=1);

/**
 * Mileage (kørsel) card data (authenticated session, JSON). Powers the card's own
 * interactivity — logging a driving day, deleting one, setting the round-trip distance —
 * and year navigation, without a chat turn.
 *
 *   GET  /api/mileage.php?offset=0                  → this year's card (-1 = last year)
 *   POST { action:'log'[, date, km, note] }         → log a driving day
 *   POST { action:'delete', id }                    → remove a logged day
 *   POST { action:'set_distance', km }              → set the round-trip distance
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Mileage;
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

$settings = new UserSettings();
$mileage  = new Mileage($settings);

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $action = is_array($in) ? (string) ($in['action'] ?? '') : '';

        if ($action === 'log') {
            $km = isset($in['km']) && $in['km'] !== '' ? (float) $in['km'] : null;
            $mileage->logTrip(
                $userId,
                isset($in['date']) ? (string) $in['date'] : null,
                $km,
                isset($in['note']) ? (string) $in['note'] : null
            );
            out(200, ['ok' => true, 'card' => $mileage->card($userId, 0)]);
        }

        if ($action === 'delete') {
            $id = (int) ($in['id'] ?? 0);
            if ($id > 0) {
                $mileage->deleteTrip($userId, $id);
            }
            out(200, ['ok' => true, 'card' => $mileage->card($userId, 0)]);
        }

        if ($action === 'set_distance') {
            $km = isset($in['km']) ? (float) $in['km'] : 0.0;
            $settings->set($userId, 'mileage_round_trip_km', $km > 0 ? (string) $km : '');
            out(200, ['ok' => true, 'card' => $mileage->card($userId, 0)]);
        }

        out(400, ['error' => 'Unknown action.']);
    }

    $offset = max(-100, min(0, (int) ($_GET['offset'] ?? 0)));
    out(200, ['ok' => true, 'card' => $mileage->card($userId, $offset)]);
} catch (\Throwable $e) {
    error_log('mileage.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong loading mileage.']);
}
