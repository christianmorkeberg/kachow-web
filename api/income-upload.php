<?php

declare(strict_types=1);

/**
 * Invoice upload → income draft (authenticated session, multipart). The income-side
 * sibling of receipt-upload.php.
 *
 *   POST (multipart/form-data) with file field "invoice" (image OR PDF)
 *     → stores the bilag outside the webroot, reads it with the AI, creates a draft
 *       income entry, and returns its editable card.
 */

require __DIR__ . '/../bootstrap.php';

use App\Assistant\GeminiClient;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\BookkeepingAudit;
use App\Data\Income;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Receipts\InvoiceReader;
use App\Receipts\ReceiptStorage;

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

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST' || !isset($_FILES['invoice'])) {
    out(400, ['error' => 'No invoice uploaded.']);
}
$file = $_FILES['invoice'];
if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
    out(400, ['error' => 'Upload failed. Please try again.']);
}

try {
    $storage = new ReceiptStorage();
    $stored  = $storage->store($userId, (string) $file['tmp_name'], (int) $file['size']);

    $income = new Income();
    $path   = $storage->pathFor($userId, $stored['file_ref']);
    $read   = $path !== null ? (new InvoiceReader(GeminiClient::fromEnv()))->read($path, $stored['mime']) : [];

    // Fill the moms triple from whatever the reader got (DK 25%).
    [$ex, $vat, $total] = Income::deriveVat(
        $read['amount_ex_vat'] ?? null,
        $read['vat'] ?? null,
        $read['total'] ?? null
    );

    $id = $income->create($userId, [
        'kind'          => 'invoice',
        'customer'      => $read['customer'] ?? null,
        'doc_number'    => $read['doc_number'] ?? null,
        'issued_at'     => $read['issued_at'] ?? Income::today(),
        'amount_ex_vat' => $ex,
        'vat'           => $vat,
        'total'         => $total,
        'currency'      => $read['currency'] ?? 'DKK',
        'file_ref'      => $stored['file_ref'],
        'mime'          => $stored['mime'],
    ], 'photo');
    (new BookkeepingAudit())->log($userId, 'income', $id, 'create', ['source' => 'upload', 'total' => $total]);

    $row = $income->get($userId, $id);
    out(200, ['ok' => true, 'card' => $row !== null ? $income->card($row) : null]);
} catch (\RuntimeException $e) {
    out(422, ['error' => $e->getMessage()]);
} catch (\Throwable $e) {
    error_log('income-upload.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong reading that invoice.']);
}
