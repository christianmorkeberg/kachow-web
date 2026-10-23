<?php

declare(strict_types=1);

/**
 * Export of what a read tool returns (authenticated session) — the link export_data hands out.
 *
 *   GET ?spec=<json: source, args, layout, columns, title, customer, round, lang, …>&format=pdf|csv|html
 *     → pdf and csv download as files (csv: semicolon, UTF-8 BOM); html is the printable page (embed=1: for the preview card).
 * The spec is re-run as the logged-in user when the link is opened; only whitelisted read tools run (ExportData::SOURCES).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Memories;
use App\Data\RememberTokens;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Support\ExportPage;
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

$format = in_array($_GET['format'] ?? 'html', ['csv', 'pdf'], true) ? (string) $_GET['format'] : 'html';
// embed=1: the page inside a card — no print button, tighter padding.
$person = (string) (($users->findById($userId)['name'] ?? '') ?: '');
$file   = ExportPage::render($built, $spec, $format, $person);

header('Content-Type: ' . $file['mime']);
if ($format === 'html') {
    header('Cache-Control: no-store');
    $body = $file['body'];
    if (!empty($_GET['embed'])) {
        $body = str_replace('</head>', '<style>.bar{display:none}body{padding:14px;max-width:none}</style></head>', $body);
    }
    echo $body;
    exit;
}
header('Content-Disposition: ' . (!empty($_GET['inline']) && $format === 'pdf' ? 'inline' : 'attachment') . '; filename="' . $file['filename'] . '"');
echo $file['body'];
