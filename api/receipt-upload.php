<?php

declare(strict_types=1);

/**
 * Receipt photo upload (authenticated session, multipart).
 *
 *   POST (multipart/form-data) with file field "photo"
 *     → stores the normalised image outside the webroot, reads it with the AI,
 *       creates a draft receipt, and returns its editable card.
 */

require __DIR__ . '/../bootstrap.php';

use App\Assistant\GeminiClient;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Receipts\ReceiptReader;
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

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST' || !isset($_FILES['photo'])) {
    out(400, ['error' => 'No photo uploaded.']);
}
$file = $_FILES['photo'];
if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
    out(400, ['error' => 'Upload failed. Please try again.']);
}

try {
    $storage = new ReceiptStorage();
    $stored  = $storage->store($userId, (string) $file['tmp_name'], (int) $file['size']);

    $receipts = new Receipts();
    $path     = $storage->pathFor($userId, $stored['file_ref']);
    $read     = $path !== null ? (new ReceiptReader(GeminiClient::fromEnv()))->read($path, $stored['mime']) : [];

    $id  = $receipts->create($userId, $read + ['file_ref' => $stored['file_ref'], 'mime' => $stored['mime']], 'photo');
    $row = $receipts->get($userId, $id);

    out(200, ['ok' => true, 'card' => $row !== null ? $receipts->cardWithChecks($userId, $row) : null]);
} catch (\RuntimeException $e) {
    // Friendly, user-facing (bad type / too large / unreadable image).
    out(422, ['error' => $e->getMessage()]);
} catch (\Throwable $e) {
    error_log('receipt-upload.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong reading that receipt.']);
}
