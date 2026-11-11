<?php

declare(strict_types=1);

/**
 * Returns a single card by key (authenticated session, JSON), so tapping a push
 * notification can open a fresh chat that already shows the relevant card. Own data
 * only. The `for` key comes from NotificationTypes::deepLink (`/?card=<key>`).
 *
 *   GET ?for=cycle | work_hours | work_week | work_log | feedback | power_prices | weather  → { card }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\CycleTracker;
use App\Data\FeedbackReports;
use App\Data\Income;
use App\Data\Moms;
use App\Data\NotificationHistory;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\Reminders;
use App\Data\Users;
use App\Data\WorkEvents;
use App\Data\WorkLog;
use App\Tools\ListFeedback;

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
            $card = (new WorkEvents())->overview($userId, ['period' => 'today']);
            break;
        case 'work_yesterday':
            $yesterday = (new DateTimeImmutable('yesterday', new DateTimeZone('Europe/Copenhagen')))->format('Y-m-d');
            $card = (new WorkEvents())->overview($userId, ['scope' => 'today', 'date' => $yesterday]);
            break;
        case 'work_week':
            $card = (new WorkEvents())->overview($userId, ['scope' => 'lastweek']);
            break;
        case 'work_log':
            $from = date('Y-m-d', strtotime('monday this week'));
            $to   = date('Y-m-d');
            $card = (new WorkLog())->card($userId, $from, $to, 'This week');
            break;
        case 'moms':
            // The quarter awaiting filing (previous quarter) — what the nudge is about.
            $card = (new Moms(new Income(), new Receipts()))->card($userId, -1);
            break;
        case 'routines':
            // The routines card, with any "ask first" question waiting (the routine_ask push opens this).
            $card = (new \App\Data\ScheduledTasks())->cardForUser($userId, new \App\Data\Places());
            break;
        case 'feedback':
            // The developer's open reports (the "new feedback report" push). Admin only.
            if (!$users->isAdmin($userId)) {
                out(404, ['error' => 'Unknown card.']);
            }
            $card = ListFeedback::build(new FeedbackReports(), 'open')['card'];
            break;
        case 'reminder':
            // The Reminders card, with the one the push was about in focus (an old or unknown id just shows the card).
            $rid  = isset($_GET['rid']) ? (int) $_GET['rid'] : 0;
            $card = (new Reminders())->card($userId, $rid > 0 ? $rid : null);
            break;
        case 'power_prices':
            // The card picker's "Power prices": the next hours of the Danish spot price (the same card get_power_prices shows).
            $res  = (new \App\Tools\GetPowerPrices(new \App\Energy\PowerPrices(new \App\Energy\EnergiDataService())))->execute([], $userId);
            $card = $res['_render'] ?? null;
            if ($card === null) {
                out(200, ['ok' => false, 'card' => null, 'error' => (string) ($res['error'] ?? 'No prices right now.')]);
            }
            break;
        case 'weather':
            // The card picker's "Weather": the weather at the user's Home place (Copenhagen when none is saved), the same card get_current_weather shows.
            $lat = 55.68;
            $lon = 12.57;
            $label = 'Copenhagen';
            foreach ((new \App\Data\Places())->list($userId) as $pl) {
                if ((string) ($pl['type'] ?? '') === 'home' && isset($pl['lat'], $pl['lon']) && $pl['lat'] !== null) {
                    $lat = (float) $pl['lat'];
                    $lon = (float) $pl['lon'];
                    $label = (string) $pl['name'];
                    break;
                }
            }
            $res  = (new \App\Tools\GetCurrentWeather(\App\Weather\WeatherService::fromEnv()))->execute(['latitude' => $lat, 'longitude' => $lon, 'place' => $label], $userId);
            $card = $res['_render'] ?? null;
            if ($card === null) {
                out(200, ['ok' => false, 'card' => null, 'error' => (string) ($res['error'] ?? 'No weather right now.')]);
            }
            break;
        default:
            out(404, ['error' => 'Unknown card.']);
    }

    // Opening what a notification points to counts as reading it.
    try {
        $rid = isset($_GET['rid']) ? (int) $_GET['rid'] : 0;
        (new NotificationHistory())->markReadByUrl($userId, '/?card=' . $for . ($rid > 0 ? '&rid=' . $rid : ''));
    } catch (\Throwable $e) {
        error_log('card.php markReadByUrl: ' . $e->getMessage());
    }

    out(200, ['ok' => true, 'card' => $card]);
} catch (\Throwable $e) {
    error_log('card.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not load the card.']);
}
