<?php

declare(strict_types=1);

/**
 * The Calendar card (authenticated session, JSON) — the card picker's "Calendar", its view switch and its prev/next buttons.
 *
 *   GET ?month=YYYY-MM                                → { ok, card }   month view (default: the current month)
 *   GET ?view=day|3day|week|month&date=YYYY-MM-DD     → { ok, card }   that view anchored at the date (default today)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\GoogleOAuth;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Calendar;
use App\Data\RememberTokens;
use App\Data\Users;

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

$view = (string) ($_GET['view'] ?? '');
$date = (string) ($_GET['date'] ?? '');
if ($view !== '' && !in_array($view, Calendar::VIEWS, true)) {
    out(400, ['error' => 'view must be day, 3day, week or month.']);
}
if ($date !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) !== 1) {
    out(400, ['error' => 'date must look like 2026-11-13.']);
}
if ($view !== '' && $view !== 'month' || ($view === 'month' && $date !== '')) {
    $view = $view !== '' ? $view : 'month';
    $date = $date !== '' ? $date : (new DateTimeImmutable('now', new DateTimeZone('Europe/Copenhagen')))->format('Y-m-d');
    try {
        $calendar = new Calendar(GoogleOAuth::fromEnv($users));
        [$vf, $vt] = Calendar::viewRange($view, $date);
        [$from, $to] = Calendar::rangeUtc($vf, $vt);
        out(200, ['ok' => true, 'card' => $calendar->buildViewCard($calendar->getEvents($userId, $from, $to), $view, $date)]);
    } catch (\Throwable $e) {
        error_log('calendar-month.php: ' . $e->getMessage());
        out(500, ['error' => 'Could not read your calendar right now.']);
    }
}

$month = (string) ($_GET['month'] ?? '');
if ($month === '') {
    $month = (new DateTimeImmutable('now', new DateTimeZone('Europe/Copenhagen')))->format('Y-m');
}
if (preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month) !== 1) {
    out(400, ['error' => 'month must look like 2026-11.']);
}

try {
    $calendar = new Calendar(GoogleOAuth::fromEnv($users));
    [$from, $to] = Calendar::monthRangeUtc($month);
    out(200, ['ok' => true, 'card' => $calendar->buildMonthCard($calendar->getEvents($userId, $from, $to), $month)]);
} catch (\Throwable $e) {
    error_log('calendar-month.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not read your calendar right now.']);
}
