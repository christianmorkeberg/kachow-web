<?php

declare(strict_types=1);

/**
 * Push notification endpoint (authenticated session).
 *
 *   GET  → { supported, public_key, types:[{key,label,description,enabled}] }
 *   POST { action:'subscribe',   subscription:{endpoint,keys:{p256dh,auth}} }
 *   POST { action:'unsubscribe', endpoint }
 *   POST { action:'set_pref',    type, enabled }
 *   POST { action:'test' }        → sends a test push to this user's devices
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\NotificationPrefs;
use App\Data\PushSubscriptions;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Notify\Notifier;
use App\Notify\NotificationTypes;
use App\Notify\WebPush;

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

$prefs = new NotificationPrefs();
$subs  = new PushSubscriptions();

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        out(200, [
            'supported'  => WebPush::isConfigured(),
            'public_key' => WebPush::publicKey(),
            'types'      => $prefs->forUser($userId),
        ]);
    }

    $in     = json_decode((string) file_get_contents('php://input'), true);
    $action = is_array($in) ? (string) ($in['action'] ?? '') : '';

    switch ($action) {
        case 'subscribe':
            $sub      = $in['subscription'] ?? [];
            $endpoint = (string) ($sub['endpoint'] ?? '');
            $p256dh   = (string) ($sub['keys']['p256dh'] ?? '');
            $auth     = (string) ($sub['keys']['auth'] ?? '');
            if ($endpoint === '' || $p256dh === '' || $auth === '') {
                out(400, ['error' => 'Incomplete subscription.']);
            }
            $ua = substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255);
            $subs->save($userId, $endpoint, $p256dh, $auth, $ua);
            out(200, ['ok' => true]);

            // no break (out() exits)
        case 'unsubscribe':
            $endpoint = (string) ($in['endpoint'] ?? '');
            if ($endpoint !== '') {
                $subs->deleteByEndpoint($endpoint);
            }
            out(200, ['ok' => true]);

        case 'set_pref':
            $type = (string) ($in['type'] ?? '');
            if (!NotificationTypes::exists($type)) {
                out(400, ['error' => 'Unknown notification type.']);
            }
            $prefs->set($userId, $type, !empty($in['enabled']));
            out(200, ['ok' => true, 'type' => $type, 'enabled' => !empty($in['enabled'])]);

        case 'test':
            if (!WebPush::isConfigured()) {
                out(200, ['ok' => false, 'error' => 'Push is not configured on the server yet.']);
            }
            $sent = Notifier::fromEnv()->sendTest($userId);
            out(200, ['ok' => $sent > 0, 'sent' => $sent]);

        default:
            out(400, ['error' => 'Unknown action.']);
    }
} catch (\Throwable $e) {
    error_log('push.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
