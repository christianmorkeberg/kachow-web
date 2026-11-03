<?php

declare(strict_types=1);

/**
 * The bilag (receipt/invoice files) of one calendar year as a ZIP, each named after its kassekladde voucher number
 * (e.g. 2025-0003.jpg) so the files line up with the ledger in the loan pack. Authenticated session.
 *
 *   GET ?year=YYYY
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Ledger;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Receipts\ReceiptStorage;

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

$year = (int) ($_GET['year'] ?? 0);
if ($year < 2000 || $year > 2100) {
    http_response_code(400);
    header('Content-Type: text/plain');
    echo 'Bad year.';
    exit;
}
if (!class_exists('ZipArchive')) {
    http_response_code(501);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'ZIP is not available on this server (php-zip missing).';
    exit;
}

$storage = new ReceiptStorage();
$tmp     = tempnam(sys_get_temp_dir(), 'bilag');
$zip     = new ZipArchive();
$zip->open((string) $tmp, ZipArchive::OVERWRITE);
$added = 0;
foreach ((new Ledger())->rows($userId, $year . '-01-01', $year . '-12-31') as $r) {
    $ref = (string) ($r['file_ref'] ?? '');
    $path = $ref !== '' ? $storage->pathFor($userId, $ref) : null;
    if ($path === null) {
        continue;
    }
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION)) ?: 'bin';
    $zip->addFile($path, $r['voucher'] . '.' . $ext);
    $added++;
}
$zip->close();

if ($added === 0) {
    @unlink((string) $tmp);
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Ingen bilag i ' . $year . '.';
    exit;
}

header('Content-Type: application/zip');
header('Content-Disposition: attachment; filename="bilag_' . $year . '.zip"');
header('Content-Length: ' . (string) filesize((string) $tmp));
readfile((string) $tmp);
@unlink((string) $tmp);
