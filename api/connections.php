<?php

declare(strict_types=1);

/**
 * The People panel of the Settings card (authenticated session, JSON): the people the user shares with. Every action goes through the same tools the assistant uses
 * (so the rules, the notification email and the checks are identical) or the Connections table directly; the answer is always the fresh panel.
 *
 *   GET                                            → { ok, people }
 *   POST { action:'request', email, share[] }       → send a connection request
 *   POST { action:'accept', connection_id, share[] }→ accept an incoming request, sharing `share` back
 *   POST { action:'remove', connection_id }         → decline a request / end a connection
 *   POST { action:'sharing', connection_id, share[] } → change what YOU share with them
 *   POST { action:'invite', email }                 → (admin) invite someone without an account; returns invite_url
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Connections;
use App\Data\Memories;
use App\Data\RememberTokens;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Support\SettingsPanels;
use App\Tools\RegistryFactory;

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
$userId      = (int) $session->userId();
$connections = new Connections();
$panel       = static fn (): array => SettingsPanels::people($connections, $userId, $users->isAdmin($userId));

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        out(200, ['ok' => true, 'people' => $panel()]);
    }
    $in     = json_decode((string) file_get_contents('php://input'), true);
    $in     = is_array($in) ? $in : [];
    $action = (string) ($in['action'] ?? '');
    $share  = is_array($in['share'] ?? null) ? $in['share'] : [];
    $cid    = (int) ($in['connection_id'] ?? 0);
    $mine   = static function (int $id) use ($connections, $userId): ?array {
        foreach ($connections->listForUser($userId) as $c) {
            if ($c['connection_id'] === $id) {
                return $c;
            }
        }

        return null;
    };
    $registry = static fn () => RegistryFactory::standard($users, new Memories(), new UserInstructions());
    $extra    = [];

    switch ($action) {
        case 'request':
            $r = $registry()->dispatch('send_connection_request', ['email' => (string) ($in['email'] ?? ''), 'share' => $share], $userId, 'card');
            if (isset($r['error'])) {
                out(400, ['error' => (string) $r['error']]);
            }
            break;
        case 'accept':
            $c = $mine($cid);
            if ($c === null) {
                out(404, ['error' => 'No such request.']);
            }
            $r = $registry()->dispatch('accept_connection_request', ['from' => (string) $c['person']['email'], 'share' => $share], $userId, 'card');
            if (isset($r['error'])) {
                out(400, ['error' => (string) $r['error']]);
            }
            break;
        case 'remove':
            if (!$connections->remove($userId, $cid)) {
                out(404, ['error' => 'No such connection.']);
            }
            break;
        case 'sharing':
            if ($mine($cid) === null || !$connections->updateScopes($userId, $cid, Connections::normalizeScopes($share))) {
                out(404, ['error' => 'No such connection.']);
            }
            break;
        case 'invite':
            $r = $registry()->dispatch('create_invite', ['email' => (string) ($in['email'] ?? '')], $userId, 'card');
            if (isset($r['error'])) {
                out(400, ['error' => (string) $r['error']]);
            }
            $extra = ['invite_url' => (string) ($r['invite_url'] ?? $r['url'] ?? ''), 'email_sent' => (bool) ($r['email_sent'] ?? false)];
            break;
        default:
            out(400, ['error' => 'Unknown action.']);
    }
    out(200, ['ok' => true, 'people' => $panel()] + $extra);
} catch (\Throwable $e) {
    error_log('connections.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
