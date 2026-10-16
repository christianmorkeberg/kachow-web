<?php

declare(strict_types=1);

/**
 * Home agent endpoint — the Raspberry Pi Pico W on the home network talks to the app here.
 * NO login session: the Pico authenticates with a per-user token (api_tokens scope 'agent').
 * It only ever calls OUT to this endpoint; the app never connects into the home network.
 *
 *   GET  /api/agent.php?t=<token>&action=poll&wait=20
 *        Long-poll: holds the request open up to `wait` seconds (max 25) and answers the moment a
 *        command is queued. -> {"command": {id, device, method, path, body}} or {"command": null}
 *        Every poll refreshes the token's last_used_at, which is how the app knows the Pico is online.
 *
 *   POST /api/agent.php?t=<token>&action=result
 *        body {"id": int, "status": int|null, "body": string|null, "error": string|null}
 *        -> {"ok": true|false}
 */

require __DIR__ . '/../bootstrap.php';

use App\Data\AgentCommands;
use App\Data\ApiTokens;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(int $status, mixed $body = []): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

$token = (string) ($_GET['t'] ?? '');
if ($token === '') {
    reply(401, ['error' => 'Missing token']);
}

try {
    $userId = (new ApiTokens())->userForToken($token, AgentCommands::SCOPE);
    if ($userId === null) {
        reply(401, ['error' => 'Invalid token']);
    }
    $commands = new AgentCommands();
    $action   = (string) ($_GET['action'] ?? 'poll');

    if ($action === 'poll') {
        $wait = max(0, min(25, (int) ($_GET['wait'] ?? 20)));
        set_time_limit($wait + 15);
        $deadline = microtime(true) + $wait;
        do {
            $cmd = $commands->claimNext($userId);
            if ($cmd !== null) {
                reply(200, ['command' => $cmd]);
            }
            if (connection_aborted()) {
                exit;
            }
            usleep(200_000);
        } while (microtime(true) < $deadline);
        reply(200, ['command' => null]);
    }

    if ($action === 'result') {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            reply(405, ['error' => 'POST only']);
        }
        $msg = json_decode((string) file_get_contents('php://input', false, null, 0, 262144), true);
        if (!is_array($msg) || !isset($msg['id']) || !is_numeric($msg['id'])) {
            reply(400, ['error' => 'Body must be JSON with an "id"']);
        }
        $ok = $commands->complete(
            $userId,
            (int) $msg['id'],
            isset($msg['status']) && is_numeric($msg['status']) ? (int) $msg['status'] : null,
            isset($msg['body']) && is_string($msg['body']) ? $msg['body'] : null,
            isset($msg['error']) && is_string($msg['error']) ? $msg['error'] : null
        );
        reply(200, ['ok' => $ok]);
    }

    reply(400, ['error' => 'Unknown action']);
} catch (\Throwable $e) {
    error_log('agent.php: ' . $e->getMessage());
    reply(500, ['error' => 'Server error']);
}
