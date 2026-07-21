<?php

declare(strict_types=1);

/**
 * Returns a single card by key (authenticated session, JSON), so tapping a push
 * notification can open a fresh chat that already shows the relevant card. Own data
 * only. The `for` key comes from NotificationTypes::deepLink (`/?card=<key>`).
 *
 *   GET ?for=cycle | work_hours | work_week | work_log  → { card }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\CycleTracker;
use App\Data\RememberTokens;
use App\Data\Reminders;
use App\Data\Users;
use App\Data\WorkEvents;
use App\Data\WorkLog;

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

$for = isset($_GET['for']) ? (string) $_GET['for'] : '';

try {
    switch ($for) {
        case 'cycle':
            $card = (new CycleTracker())->card($userId);
            break;
        case 'work_hours':
            $card = (new WorkEvents())->summary($userId, 'today')['card'];
            break;
        case 'work_week':
            $card = (new WorkEvents())->summary($userId, 'lastweek')['card'];
            break;
        case 'work_log':
            $from = date('Y-m-d', strtotime('monday this week'));
            $to   = date('Y-m-d');
            $card = (new WorkLog())->card($userId, $from, $to, 'This week');
            break;
        case 'reminder':
            $rid = isset($_GET['rid']) ? (int) $_GET['rid'] : 0;
            $rem = $rid > 0 ? (new Reminders())->get($userId, $rid) : null;
            if ($rem === null) {
                out(404, ['error' => 'Reminder not found.']);
            }
            $when = (new DateTimeImmutable($rem['remind_at'], new DateTimeZone('UTC')))
                ->setTimezone(new DateTimeZone('Europe/Copenhagen'));
            $card = [
                'kind'   => 'notice',
                'tone'   => 'info',
                'title'  => '⏰ ' . $rem['text'],
                'detail' => 'Reminder · ' . $when->format('D j M, H:i'),
            ];
            break;
        default:
            out(404, ['error' => 'Unknown card.']);
    }

    out(200, ['ok' => true, 'card' => $card]);
} catch (\Throwable $e) {
    error_log('card.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not load the card.']);
}
