<?php

declare(strict_types=1);

/**
 * Timesheet (hours per day) from the work clock (authenticated session).
 *
 *   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&place=…&customer=…&round=15&notes=1&lang=da|en&format=csv|html
 *     → format=csv downloads a spreadsheet file; format=html (default) is a printable page ("save as PDF").
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\WorkEvents;
use App\Data\WorkLog;
use App\Support\Timesheet;

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
    http_response_code(401);
    header('Content-Type: text/plain');
    echo 'Not authenticated.';
    exit;
}
$userId = (int) $session->userId();

$date = static fn (string $k, string $default): string => isset($_GET[$k]) && $_GET[$k] !== '' ? date('Y-m-d', strtotime((string) $_GET[$k]) ?: time()) : $default;
$from = $date('from', date('Y-m-01'));
$to   = $date('to', date('Y-m-d'));
$text = static fn (string $k): ?string => isset($_GET[$k]) && trim((string) $_GET[$k]) !== '' ? mb_substr(trim((string) $_GET[$k]), 0, 120) : null;
$place = $text('place');
$lang  = ($_GET['lang'] ?? 'da') === 'en' ? 'en' : 'da';
$notes = !empty($_GET['notes']);

$built = Timesheet::forRange(new WorkEvents(), new WorkLog(), $userId, $from, $to, $place, (int) ($_GET['round'] ?? 0), $notes);
$sheet = $built['sheet'];

if (($_GET['format'] ?? 'html') === 'csv') {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="timesheet_' . $from . '_' . $to . '.csv"');
    $out = fopen('php://output', 'w');
    fprintf($out, "\xEF\xBB\xBF"); // UTF-8 BOM so Excel reads æøå correctly
    foreach (Timesheet::csvRows($sheet, $lang, $notes) as $row) {
        fputcsv($out, $row, ';');
    }
    fclose($out);
    exit;
}

$person = (string) (($users->findById($userId)['name'] ?? '') ?: '');
$period = date('d.m.Y', strtotime($from)) . ' – ' . date('d.m.Y', strtotime($to));
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
echo Timesheet::html($sheet, $lang, [
    'person' => $person, 'customer' => (string) $text('customer'), 'job' => (string) $place, 'period' => $period, 'made' => date('d.m.Y'),
], $notes);
