<?php

declare(strict_types=1);

/**
 * The Home card (authenticated session, JSON): lights, rooms and radiator thermostats, read and controlled through the home agent.
 *
 *   GET  ?part=lights                                        → { ok, rooms:[…], other:[…], thermostats_known }  (the bridge's lists, live; the saved thermostat names + rooms)
 *   GET  ?part=thermostats                                   → { ok, thermostats:[…] }            (each valve's numbers, with its Hue room)
 *   POST { action:'light', id, on?, brightness?, color? }    → one light (color: a hex like #ff8800, a word, a white)
 *   POST { action:'group', id, on?, brightness? }            → a whole room (its grouped_light id)
 *   POST { action:'thermostat', id, target }                 → a valve's target in °C (a slow valve answers "sent")
 *
 * The two reads are separate so the card can show the lights while the (slower) valves are still answering.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\AgentCommands;
use App\Data\ApiTokens;
use App\Data\Connections;
use App\Data\HomeDevices;
use App\Data\RememberTokens;
use App\Data\UserSettings;
use App\Data\Users;
use App\Home\HomeOwner;
use App\Home\HueSync;
use App\Home\ThermostatService;
use App\Support\HomeCard;
use App\Support\Thermostats;
use App\Tools\HomeDeviceCall;
use App\Tools\SetThermostat;

header('Content-Type: application/json');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
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
// Release the session lock: a slow valve must not hold up the user's other requests.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

$agent  = new AgentCommands();
$tokens = new ApiTokens();
$home   = new HomeDeviceCall($agent, $tokens, new HueSync(new HomeDevices(), HueSync::viaAgent($agent)), new HomeOwner($tokens, new Connections()));
$settings = new UserSettings();

/** One Hue list through the agent: the "data" array, or an error string. @return array{data?: list<array<string, mixed>>, error?: string} */
function hueList(HomeDeviceCall $home, int $userId, string $kind): array
{
    $res = $home->execute(['device' => 'hue', 'method' => 'GET', 'path' => '/clip/v2/resource/' . $kind], $userId);
    if (isset($res['error'])) {
        return ['error' => (string) $res['error']];
    }
    $data = $res['response']['data'] ?? null;
    if (!is_array($data)) {
        return ['error' => 'The bridge\'s ' . $kind . ' list was too long to read through the home agent.'];
    }

    return ['data' => array_values($data)];
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $in     = is_array($in) ? $in : [];
        $action = (string) ($in['action'] ?? '');
        $id     = trim((string) ($in['id'] ?? ''));

        if ($action === 'light' || $action === 'group') {
            if (!HomeCard::validId($id)) {
                out(400, ['error' => 'Not a light id.']);
            }
            $body = HomeCard::body($action === 'group' ? array_diff_key($in, ['color' => 1]) : $in);
            if ($body === null) {
                out(400, ['error' => 'Nothing valid to set (on, brightness 0–100, or a known colour).']);
            }
            $res = $home->execute(['device' => 'hue', 'method' => 'PUT', 'path' => '/clip/v2/resource/' . ($action === 'group' ? 'grouped_light' : 'light') . '/' . $id, 'body' => $body], $userId);
            if (isset($res['error'])) {
                out(502, ['error' => (string) $res['error']]);
            }
            if (($res['http_status'] ?? 200) >= 400 || !empty($res['response']['errors'])) {
                out(502, ['error' => 'The bridge refused that: ' . json_encode($res['response']['errors'] ?? $res['response'], JSON_UNESCAPED_UNICODE)]);
            }
            out(200, ['ok' => true]);
        }
        if ($action === 'thermostat') {
            $res = (new SetThermostat($home, $settings))->execute(['thermostat' => $id, 'temperature_c' => $in['target'] ?? null], $userId);
            if (isset($res['error']) || ($res['set'] ?? false) === false) {
                out(502, ['error' => (string) ($res['error'] ?? 'The thermostat did not take that.')]);
            }
            out(200, ['ok' => true, 'set' => $res['set'], 'target_c' => $res['target_c'] ?? null]);
        }
        out(400, ['error' => 'Unknown action.']);
    }

    $part = (string) ($_GET['part'] ?? '');
    if ($part === 'lights') {
        $lights = hueList($home, $userId, 'light');
        if (isset($lights['error'])) {
            out(502, ['error' => $lights['error']]);
        }
        // Rooms and groups are small; if either cannot be read the lights still show, just not grouped.
        $rooms  = hueList($home, $userId, 'room');
        $groups = hueList($home, $userId, 'grouped_light');
        $card   = HomeCard::lights($lights['data'], $rooms['data'] ?? [], $groups['data'] ?? []);
        // Which thermostats exist and in which room, from the saved names alone (no valve is asked): the card reserves their tiles at once.
        $known = null;
        if (trim((string) $settings->get($userId, 'thermostats')) !== '') {
            $svc   = new ThermostatService($home, $settings);
            $known = array_map(static fn (array $t): array => ['id' => $t['id'], 'name' => $t['name'], 'room' => $svc->roomFor($userId, $t['name'])], Thermostats::parse($settings->get($userId, 'thermostats')));
        }
        out(200, ['ok' => true] + $card + ['thermostats_known' => $known] + (isset($rooms['error']) ? ['note' => $rooms['error']] : []));
    }
    if ($part === 'thermostats') {
        $svc  = new ThermostatService($home, $settings);
        $list = $svc->list($userId);
        if ($list['error'] !== null) {
            out(502, ['error' => $list['error']]);
        }
        $rows = [];
        foreach ($list['list'] as $t) {
            $r = $svc->read($userId, $t);
            if (isset($r['error'])) {
                $rows[] = ['name' => $t['name'], 'id' => $t['id'], 'error' => $r['error'], 'room' => $svc->roomFor($userId, $t['name'])];
                continue;
            }
            $rows[] = $r['row'] + ['room' => $svc->roomFor($userId, $t['name'])];
        }
        out(200, ['ok' => true, 'thermostats' => $rows]);
    }
    out(400, ['error' => 'Use ?part=lights or ?part=thermostats.']);
} catch (\Throwable $e) {
    error_log('home.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
