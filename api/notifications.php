<?php

declare(strict_types=1);

/**
 * Notification history (the bell): every push the app has sent this user, newest first.
 * Authenticated session, JSON. Own data only.
 *
 *   GET [?before=ID&limit=N]              → { ok, unread, items:[{id,type,title,body,url,at,read}] }
 *   GET ?count=1                          → { ok, unread }                (cheap, for the badge)
 *   POST { action:'read', id }            → { ok, unread }
 *   POST { action:'read_all' }            → { ok, unread }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\NotificationHistory;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Notify\NotificationTypes;

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
$userId  = (int) $session->userId();
$history = new NotificationHistory();

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $in     = is_array($in) ? $in : [];
        $action = (string) ($in['action'] ?? '');
        if ($action === 'read') {
            $history->markRead($userId, (int) ($in['id'] ?? 0));
        } elseif ($action === 'read_all') {
            $history->markAllRead($userId);
        } else {
            out(400, ['error' => 'Unknown action.']);
        }
        out(200, ['ok' => true, 'unread' => $history->unreadCount($userId)]);
    }

    if (isset($_GET['count'])) {
        out(200, ['ok' => true, 'unread' => $history->unreadCount($userId)]);
    }

    // Opportunistic retention sweep (about one list view in twenty).
    if (random_int(1, 20) === 1) {
        $history->purgeOld($userId);
    }
    $before = isset($_GET['before']) ? (int) $_GET['before'] : null;
    $items  = $history->list($userId, (int) ($_GET['limit'] ?? 50), $before > 0 ? $before : null);
    // The labels come from the catalogue, so a new notification type needs no change here.
    $labels = array_column(NotificationTypes::all(), 'label', 'key');
    foreach ($items as &$it) {
        $it['label'] = $labels[$it['type']] ?? $it['type'];
    }
    unset($it);
    out(200, ['ok' => true, 'unread' => $history->unreadCount($userId), 'items' => $items]);
} catch (\Throwable $e) {
    error_log('notifications.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
