<?php

declare(strict_types=1);

/**
 * Export of what a read tool returns (authenticated session) — the link export_data hands out.
 *
 *   GET ?spec=<json: source, args, layout, columns, title, customer, round, lang>&format=csv|html
 *     → csv downloads a spreadsheet file (semicolon, UTF-8 BOM); html is a printable page ("save as PDF").
 * The spec is re-run as the logged-in user when the link is opened; only whitelisted read tools run (ExportData::SOURCES).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Memories;
use App\Data\RememberTokens;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Support\DataExport;
use App\Support\Timesheet;
use App\Tools\ExportData;
use App\Tools\RegistryFactory;

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

$raw  = (string) ($_GET['spec'] ?? '');
$spec = strlen($raw) <= 4000 ? json_decode($raw, true) : null;
if (!is_array($spec)) {
    http_response_code(400);
    header('Content-Type: text/plain');
    echo 'Bad export request.';
    exit;
}

$built = ExportData::build(RegistryFactory::standard($users, new Memories(), new UserInstructions()), $spec, $userId);
if (isset($built['error'])) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo (string) $built['error'];
    exit;
}

$csv   = ($_GET['format'] ?? 'html') === 'csv';
$stamp = date('Y-m-d');
$name  = preg_replace('/[^a-z0-9_-]+/i', '', (string) $spec['source']) . '_' . $stamp;
$lang  = ($spec['lang'] ?? 'da') === 'en' ? 'en' : 'da';
$title = trim((string) ($spec['title'] ?? ''));

if (isset($built['sheet'])) {
    if ($csv) {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="timesheet_' . $stamp . '.csv"');
        $out = fopen('php://output', 'w');
        fprintf($out, "\xEF\xBB\xBF");
        foreach (Timesheet::csvRows($built['sheet'], $lang, false) as $row) {
            fputcsv($out, $row, ';');
        }
        fclose($out);
        exit;
    }
    $days   = $built['sheet']['days'];
    $period = date('d.m.Y', strtotime($days[0]['date'])) . ' – ' . date('d.m.Y', strtotime($days[count($days) - 1]['date']));
    $args   = is_array($spec['args'] ?? null) ? $spec['args'] : [];
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    echo Timesheet::html($built['sheet'], $lang, [
        'person' => (string) (($users->findById($userId)['name'] ?? '') ?: ''), 'customer' => mb_substr((string) ($spec['customer'] ?? ''), 0, 120),
        'job' => mb_substr((string) ($args['place'] ?? ''), 0, 120), 'period' => $period, 'made' => date('d.m.Y'),
    ], false);
    exit;
}

if ($csv) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $name . '.csv"');
    $out = fopen('php://output', 'w');
    fprintf($out, "\xEF\xBB\xBF");
    fputcsv($out, array_map([DataExport::class, 'label'], $built['columns']), ';');
    foreach ($built['rows'] as $row) {
        fputcsv($out, $row, ';');
    }
    fclose($out);
    exit;
}

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
echo DataExport::html($title !== '' ? mb_substr($title, 0, 120) : DataExport::label((string) $spec['source']), ['columns' => $built['columns'], 'rows' => $built['rows']], ['Date' => date('d.m.Y')]);
