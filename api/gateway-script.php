<?php

declare(strict_types=1);

/**
 * The Shelly BLU gateway script as PLAIN TEXT, to be opened in a browser and copied from there (menu: "give me the gateway script"). It used to be pasted into the chat,
 * where the formatting ate the underscores of names like `target_C` and `packet_id` and the script silently did nothing — a text/plain page cannot be reformatted.
 * No login session: the user's private 'shelly' token (the same one the script itself carries) opens it.
 *
 *   GET ?t=<token>  ->  the script (text/plain)
 */

require __DIR__ . '/../bootstrap.php';

use App\Data\ApiTokens;
use App\Home\GatewayScript;

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

$token = (string) ($_GET['t'] ?? '');
try {
    $userId = $token === '' ? null : (new ApiTokens())->userForToken($token, GatewayScript::SCOPE);
} catch (\Throwable $e) {
    error_log('gateway-script.php: ' . $e->getMessage());
    $userId = null;
}
if ($userId === null) {
    http_response_code(401);
    echo "Invalid or missing token. Ask Kachow for the gateway script link.\n";
    exit;
}

echo GatewayScript::code('https://' . ($_SERVER['HTTP_HOST'] ?? 'assistant.kachow.dk'), $token), "\n";
