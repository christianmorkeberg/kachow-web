<?php

declare(strict_types=1);

/**
 * Shared shopping-list widget backend.
 *
 *   GET  ?list=NAME        → card for that list (default list if omitted)
 *   POST { item_id, checked } → tick/untick an item, returns the fresh card
 *
 * Requires an authenticated session (or remember-me cookie). Toggling is
 * authorised by connection membership inside ShoppingLists::toggleItem.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Connections;
use App\Data\RememberTokens;
use App\Data\ShoppingLists;
use App\Data\Users;
use App\Tools\HouseholdAccess;

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

$lists  = new ShoppingLists();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    if ($method === 'POST') {
        $in = json_decode((string) file_get_contents('php://input'), true);
        if (!is_array($in) || !isset($in['item_id'])) {
            out(400, ['error' => 'item_id is required.']);
        }
        $res = $lists->toggleItem($userId, (int) $in['item_id'], !empty($in['checked']));
        if ($res === null) {
            out(404, ['error' => 'No such item, or not shared with you.']);
        }

        out(200, [
            'ok'      => true,
            'item_id' => (int) $in['item_id'],
            'checked' => !empty($in['checked']),
            'card'    => $lists->cardForList($res['connection_id'], $res['list_id'], $res['name']),
        ]);
    }

    // GET: resolve the household, then the named (or default) list.
    $access = HouseholdAccess::resolve(new Connections(), $userId);
    if (isset($access['error'])) {
        out(200, ['card' => null, 'error' => $access['error']]);
    }
    $list = $lists->resolve((int) $access['connection_id'], $_GET['list'] ?? null, $userId, false);
    if (isset($list['error'])) {
        out(200, ['card' => null, 'error' => $list['error']]);
    }

    out(200, ['card' => $lists->cardForList((int) $access['connection_id'], (int) $list['id'], (string) $list['name'])]);
} catch (\Throwable $e) {
    error_log('shopping-list.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
