<?php

declare(strict_types=1);

/**
 * CSV export of the user's work log (authenticated session).
 *
 *   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&job=…  (all optional)
 *     → downloads a CSV: date, job, hours, description.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\WorkLog;

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

$from = isset($_GET['from']) && $_GET['from'] !== '' ? date('Y-m-d', strtotime((string) $_GET['from']) ?: time()) : '2000-01-01';
$to   = isset($_GET['to']) && $_GET['to'] !== '' ? date('Y-m-d', strtotime((string) $_GET['to']) ?: time()) : date('Y-m-d');
$job  = isset($_GET['job']) && $_GET['job'] !== '' ? (string) $_GET['job'] : null;

$items = (new WorkLog())->listForUser($userId, $from, $to, $job);

$fname = 'work-log_' . $from . '_' . $to . '.csv';
header('Content-Type: text/csv; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $fname . '"');

$out = fopen('php://output', 'w');
fprintf($out, "\xEF\xBB\xBF"); // UTF-8 BOM so Excel reads æøå correctly
fputcsv($out, ['Date', 'Job', 'Hours', 'What I did']);
foreach (array_reverse($items) as $i) { // oldest first for a report
    fputcsv($out, [
        $i['date'],
        $i['job'],
        $i['hours'] !== null ? number_format((float) $i['hours'], 2, '.', '') : '',
        $i['description'],
    ]);
}
fclose($out);
