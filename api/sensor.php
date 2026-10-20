<?php

declare(strict_types=1);

/**
 * Sensor readings for routines — NO login session; authenticated by a per-user token (api_tokens scope 'sensor', see the
 * get_sensor_setup tool). Anything that can open a URL can be a sensor (a Pico, a Shelly, an iPhone shortcut):
 *
 *   GET/POST /api/sensor.php?t=<token>&s=kitchen_light&v=42
 *   GET/POST /api/sensor.php?t=<token>&s=window&v=open
 *
 * A routine with a sensor trigger starts when a reading crosses its value; this only REQUESTS the run (conditions, "ask first"
 * and the run itself are the runner's). Answers a short text/plain line.
 */

require __DIR__ . '/../bootstrap.php';

use App\Data\ApiTokens;
use App\Data\Routines;
use App\Notify\RoutineSensorRunner;
use App\Tools\GetSensorSetup;

header('Content-Type: text/plain; charset=utf-8');

function line(int $status, string $text): never
{
    http_response_code($status);
    echo $text . "\n";
    exit;
}

$token  = (string) ($_GET['t'] ?? $_POST['t'] ?? '');
$sensor = trim((string) ($_GET['s'] ?? $_POST['s'] ?? ''));
$value  = trim((string) ($_GET['v'] ?? $_POST['v'] ?? ''));
if ($sensor === '' || $value === '' || mb_strlen($sensor) > 64 || mb_strlen($value) > 40) {
    line(400, 'Send s (the sensor name) and v (the reading).');
}

try {
    $userId = (new ApiTokens())->userForToken($token, GetSensorSetup::SCOPE);
    if ($userId === null) {
        line(403, 'Invalid token.');
    }
    $reading = is_numeric($value) ? (float) $value : $value;
    $started = (new RoutineSensorRunner(new Routines()))->onReading($userId, $sensor, $reading);
    line(200, 'OK' . ($started !== [] ? ' — started ' . count($started) . ' routine' . (count($started) === 1 ? '' : 's') : ''));
} catch (\Throwable $e) {
    error_log('sensor: ' . $e->getMessage());
    line(500, 'Could not record that.');
}
