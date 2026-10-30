<?php

declare(strict_types=1);

/**
 * The Shelly BLU gateway's script calls this when a radiator valve has reported (see App\Home\GatewayScript). NO login session: the gateway authenticates with the user's
 * private 'shelly' token (api_tokens scope), like the Pico does with its own.
 *
 *   GET ?t=<token>&id=200&target=16&cur=21.6&pos=0&ts=<valve's own report time>[&rssi=-70&bat=100]
 *   -> { ok: true, id, announced }   announced = this report completed a "set the radiators" batch and the user was told
 *
 * The reading goes straight into the home-state cache; a pending "sent" target the valve now has is settled (one push to the user, via the same batch the
 * waiting watcher uses, so only one of them ever announces it).
 */

require __DIR__ . '/../bootstrap.php';

use App\Data\AgentCommands;
use App\Data\ApiTokens;
use App\Data\Connections;
use App\Data\HomeState;
use App\Data\UserSettings;
use App\Home\ConfirmDelivery;
use App\Home\GatewayReport;
use App\Home\GatewayScript;
use App\Home\HomeOwner;
use App\Home\PendingSets;
use App\Home\ThermostatService;
use App\Tools\HomeDeviceCall;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

$token = (string) ($_GET['t'] ?? '');
if ($token === '') {
    reply(401, ['ok' => false, 'error' => 'Missing token']);
}

try {
    $tokens = new ApiTokens();
    $userId = $tokens->userForToken($token, GatewayScript::SCOPE);
    if ($userId === null) {
        reply(401, ['ok' => false, 'error' => 'Invalid token']);
    }
    $owner = new HomeOwner($tokens, new Connections());
    $state = new HomeState(null, $owner);
    // acceptReport() never asks the home agent; the service only needs the call object to exist.
    $service = new ThermostatService(new HomeDeviceCall(new AgentCommands(), $tokens, null, $owner), new UserSettings(), $state);
    $result  = (new GatewayReport($service, new PendingSets($state), new ConfirmDelivery($userId)))->accept($userId, $_GET);
    reply($result['ok'] ? 200 : 400, $result);
} catch (\Throwable $e) {
    error_log('shelly-hook.php: ' . $e->getMessage());
    reply(500, ['ok' => false, 'error' => 'Something went wrong.']);
}
