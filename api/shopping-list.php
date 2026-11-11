<?php

declare(strict_types=1);

/**
 * Shared shopping-list widget backend.
 *
 *   GET  ?list=NAME             → card for that list (default list if omitted)
 *   POST { item_id, checked }  → tick/untick an item, returns the fresh card
 *   POST { action:'add', list_id, item } → add an item, returns the fresh card
 *   POST { action:'grouping', list_id, grouping:'auto'|'none' } → group or flatten, returns the fresh card
 *   GET  ?all=1                                               → the Lists card (every list; create / rename / delete live there)
 *   POST { action:'create_list', name } | { action:'rename_list', list_id, name } | { action:'delete_list', list_id } → the fresh Lists card
 *   POST { action:'rename_item', item_id, item } | { action:'delete_item', item_id } | { action:'clear_checked', list_id } → the fresh list card
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
        $in = is_array($in) ? $in : [];

        // Managing the lists themselves (the Lists card) and single items (the list card): all scoped to the household the user belongs to.
        $act = (string) ($in['action'] ?? '');
        if (in_array($act, ['create_list', 'rename_list', 'delete_list', 'clear_checked'], true)) {
            $access = HouseholdAccess::resolve(new Connections(), $userId);
            if (isset($access['error'])) {
                out(200, ['card' => null, 'error' => $access['error']]);
            }
            $cid = (int) $access['connection_id'];
            if ($act === 'create_list') {
                $name = trim((string) ($in['name'] ?? ''));
                if ($name === '') {
                    out(400, ['error' => 'A list needs a name.']);
                }
                if ($lists->findByName($cid, $name) !== null) {
                    out(409, ['error' => 'There is already a list with that name.']);
                }
                $lists->create($cid, mb_substr($name, 0, 120), $userId);
            } elseif ($act === 'rename_list') {
                $r = $lists->byId($cid, (int) ($in['list_id'] ?? 0)) === null ? 'missing' : $lists->rename($cid, (int) $in['list_id'], (string) ($in['name'] ?? ''));
                if ($r !== true) {
                    out($r === 'exists' ? 409 : 400, ['error' => $r === 'exists' ? 'There is already a list with that name.' : ($r === 'empty' ? 'A list needs a name.' : 'No such list.')]);
                }
            } elseif ($act === 'delete_list') {
                $row = $lists->byId($cid, (int) ($in['list_id'] ?? 0));
                if ($row === null) {
                    out(404, ['error' => 'No such list.']);
                }
                $lists->delete($cid, (int) $row['id']);
            } else {   // clear_checked: returns that list's card
                $row = $lists->byId($cid, (int) ($in['list_id'] ?? 0));
                if ($row === null) {
                    out(404, ['error' => 'No such list.']);
                }
                $lists->clearChecked((int) $row['id']);
                out(200, ['ok' => true, 'card' => $lists->cardForList($cid, (int) $row['id'], $row['name'])]);
            }
            out(200, ['ok' => true, 'card' => $lists->overviewCard($cid)]);
        }
        if ($act === 'delete_item' || $act === 'rename_item') {
            $itemId = (int) ($in['item_id'] ?? 0);
            $res    = $act === 'delete_item' ? $lists->deleteItemForUser($userId, $itemId) : $lists->renameItemForUser($userId, $itemId, (string) ($in['item'] ?? ''));
            if ($res === null) {
                out(404, ['error' => 'No such item, or not shared with you.']);
            }
            out(200, ['ok' => true, 'card' => $lists->cardForList($res['connection_id'], $res['list_id'], $res['name'])]);
        }

        // Add an item straight from the card (no chat round-trip).
        if (($in['action'] ?? '') === 'add') {
            $listId = (int) ($in['list_id'] ?? 0);
            $item   = trim((string) ($in['item'] ?? ''));
            if ($listId <= 0 || $item === '') {
                out(400, ['error' => 'list_id and item are required.']);
            }
            $res = $lists->addItemForUser($userId, $listId, $item);
            if ($res === null) {
                out(404, ['error' => 'No such list, or not shared with you.']);
            }
            out(200, [
                'ok'   => true,
                'card' => $lists->cardForList($res['connection_id'], $res['list_id'], $res['name']),
            ]);
        }

        // The grouping switch on the card: grouped ('auto') or flat ('none').
        if (($in['action'] ?? '') === 'grouping') {
            $listId = (int) ($in['list_id'] ?? 0);
            $mode   = (string) ($in['grouping'] ?? '');
            if ($listId <= 0 || !in_array($mode, ['auto', 'none'], true)) {
                out(400, ['error' => 'list_id and grouping (auto|none) are required.']);
            }
            $res = $lists->setGroupingForUser($userId, $listId, $mode);
            if ($res === null) {
                out(404, ['error' => 'No such list, or not shared with you.']);
            }
            out(200, [
                'ok'   => true,
                'card' => $lists->cardForList($res['connection_id'], $res['list_id'], $res['name']),
            ]);
        }

        if (!isset($in['item_id'])) {
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
    if (isset($_GET['all'])) {
        out(200, ['card' => $lists->overviewCard((int) $access['connection_id'])]);
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
