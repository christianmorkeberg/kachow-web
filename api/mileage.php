<?php

declare(strict_types=1);

/**
 * Mileage (kørsel) card data (authenticated session, JSON). Powers the card's own
 * interactivity without a chat turn: logging/deleting a driving day, managing
 * destinations (add/edit/archive), address→distance lookup, and year navigation.
 *
 *   GET  /api/mileage.php?offset=0                          → this year's card (-1 = last year)
 *   POST { action:'log', destination_id[, date, km, note] } → log a driving day
 *   POST { action:'delete', id }                            → remove a logged day
 *   POST { action:'add_destination', name, type, km,
 *          home_address, dest_address }                     → add a destination
 *   POST { action:'update_destination', id, ...fields }     → edit a destination
 *   POST { action:'archive_destination', id }               → archive a destination
 *   POST { action:'lookup_distance', home, dest }           → address → round-trip km (no save)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\LocationPoints;
use App\Data\Mileage;
use App\Data\MileageSuggestions;
use App\Data\Places;
use App\Data\RememberTokens;
use App\Data\Timeline;
use App\Data\Users;
use App\Data\UserSettings;
use App\Maps\MapDistance;

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
$maps     = new MapDistance();
$suggest  = new MileageSuggestions(new Timeline(new LocationPoints(), new Places(), $settings), new Places(), $mileage, $maps);

/** Build the card for a year offset with the pending kørebog suggestions attached. */
$card = static fn (int $off = 0): array => $suggest->attach($mileage->card($userId, $off), $userId);

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $action = is_array($in) ? (string) ($in['action'] ?? '') : '';

        switch ($action) {
            case 'log':
                $destId = isset($in['destination_id']) && $in['destination_id'] !== '' ? (int) $in['destination_id'] : null;
                $km     = isset($in['km']) && $in['km'] !== '' ? (float) $in['km'] : null;
                $mileage->logTrip(
                    $userId,
                    $destId,
                    isset($in['date']) ? (string) $in['date'] : null,
                    $km,
                    isset($in['note']) ? (string) $in['note'] : null
                );
                out(200, ['ok' => true, 'card' => $card()]);

                // no break (out() exits)
            case 'delete':
                $id = (int) ($in['id'] ?? 0);
                if ($id > 0) {
                    $mileage->deleteTrip($userId, $id);
                }
                out(200, ['ok' => true, 'card' => $card()]);

            case 'add_destination':
                $mileage->addDestination(
                    $userId,
                    (string) ($in['name'] ?? ''),
                    (string) ($in['type'] ?? Mileage::TYPE_BUSINESS),
                    isset($in['km']) ? (float) $in['km'] : 0.0,
                    isset($in['home_address']) ? (string) $in['home_address'] : null,
                    isset($in['dest_address']) ? (string) $in['dest_address'] : null,
                    isset($in['place_id']) && (int) $in['place_id'] > 0 ? (int) $in['place_id'] : null
                );
                out(200, ['ok' => true, 'card' => $card()]);

            case 'update_destination':
                $id = (int) ($in['id'] ?? 0);
                $fields = [];
                foreach (['name', 'type', 'home_address', 'dest_address'] as $k) {
                    if (array_key_exists($k, $in)) {
                        $fields[$k] = (string) $in[$k];
                    }
                }
                if (array_key_exists('km', $in)) {
                    $fields['round_trip_km'] = (float) $in['km'];
                }
                if (array_key_exists('place_id', $in)) {
                    $fields['place_id'] = $in['place_id'];
                }
                if ($id > 0 && $fields !== []) {
                    $mileage->updateDestination($userId, $id, $fields);
                }
                out(200, ['ok' => true, 'card' => $card()]);

            case 'archive_destination':
                $id = (int) ($in['id'] ?? 0);
                if ($id > 0) {
                    $mileage->archiveDestination($userId, $id);
                }
                out(200, ['ok' => true, 'card' => $card()]);

            case 'lookup_distance':
                if (!$maps->isConfigured()) {
                    out(200, ['ok' => false, 'error' => 'Map lookup isn\'t set up yet — enter the distance manually.']);
                }
                try {
                    $res = $maps->lookup((string) ($in['home'] ?? ''), (string) ($in['dest'] ?? ''));
                    out(200, ['ok' => true, 'lookup' => $res]);
                } catch (\RuntimeException $e) {
                    out(200, ['ok' => false, 'error' => $e->getMessage()]);
                }

                // no break (out() exits)
            case 'confirm_suggestion':
                // Log a suggested driving day for a linked destination.
                $destId = (int) ($in['destination_id'] ?? 0);
                $date   = isset($in['date']) ? (string) $in['date'] : '';
                if ($destId <= 0 || $date === '') {
                    out(400, ['error' => 'Confirming needs a linked destination and a date.']);
                }
                $km = isset($in['km']) && $in['km'] !== '' ? (float) $in['km'] : null;
                $mileage->logTrip($userId, $destId, $date, $km, null);
                out(200, ['ok' => true, 'card' => $card()]);

                // no break (out() exits)
            case 'dismiss_suggestion':
                $date    = isset($in['date']) ? (string) $in['date'] : '';
                $placeId = (int) ($in['place_id'] ?? 0);
                if ($date !== '' && $placeId > 0) {
                    $mileage->dismissSuggestion($userId, $date, $placeId);
                }
                out(200, ['ok' => true, 'card' => $card()]);

                // no break (out() exits)
            case 'link_place':
                // Link a saved place to a mileage destination so its drives can be logged.
                $destId  = (int) ($in['destination_id'] ?? 0);
                $placeId = (int) ($in['place_id'] ?? 0);
                if ($destId > 0 && $placeId > 0) {
                    $mileage->updateDestination($userId, $destId, ['place_id' => $placeId]);
                }
                out(200, ['ok' => true, 'card' => $card()]);

                // no break (out() exits)
            default:
                out(400, ['error' => 'Unknown action.']);
        }
    }

    $offset = max(-100, min(0, (int) ($_GET['offset'] ?? 0)));
    out(200, ['ok' => true, 'card' => $card($offset)]);
} catch (\Throwable $e) {
    error_log('mileage.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong loading mileage.']);
}
