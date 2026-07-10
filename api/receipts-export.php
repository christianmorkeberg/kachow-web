<?php

declare(strict_types=1);

/**
 * CSV export of the user's confirmed expenses (authenticated session).
 *
 *   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&category=…  (all optional)
 *     → downloads a CSV for the accountant.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\Users;

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

$from     = isset($_GET['from']) && $_GET['from'] !== '' ? date('Y-m-d', strtotime((string) $_GET['from']) ?: time()) : null;
$to       = isset($_GET['to']) && $_GET['to'] !== '' ? date('Y-m-d', strtotime((string) $_GET['to']) ?: time()) : null;
$category = isset($_GET['category']) && $_GET['category'] !== '' ? (string) $_GET['category'] : null;

$summary = (new Receipts())->summary($userId, $from, $to, $category, 'confirmed');

$fname = 'expenses_' . ($from ?? 'all') . '_' . ($to ?? 'all') . '.csv';
header('Content-Type: text/csv; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $fname . '"');

$out = fopen('php://output', 'w');
fprintf($out, "\xEF\xBB\xBF"); // UTF-8 BOM so Excel reads æøå correctly
fputcsv($out, ['Date', 'Vendor', 'Category', 'Total', 'VAT', 'Net', 'Currency']);
foreach ($summary['items'] as $i) {
    $net = round((float) $i['total'] - (float) $i['vat'], 2);
    fputcsv($out, [
        $i['date'],
        $i['vendor'],
        $i['category'],
        number_format((float) $i['total'], 2, '.', ''),
        number_format((float) $i['vat'], 2, '.', ''),
        number_format($net, 2, '.', ''),
        $i['currency'],
    ]);
}
fclose($out);
