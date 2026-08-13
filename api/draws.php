<?php

declare(strict_types=1);

/**
 * Owner-draw card actions (authenticated session, JSON).
 *
 *   POST { action:'create', amount[, note, date] }  → record a drawing, returns its id
 *   POST { action:'discard', id }                    → delete a drawing (trailed)
 *
 * Drawings are a plain equity/cash record (no draft/booked lifecycle), so a mistaken
 * entry can simply be removed — the deletion is still written to bookkeeping_audit.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\BookkeepingAudit;
use App\Data\OwnerDraws;
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

$in     = json_decode((string) file_get_contents('php://input'), true);
$action = is_array($in) ? (string) ($in['action'] ?? '') : '';
$id     = (int) ($in['id'] ?? 0);

try {
    // Record a drawing straight away (no draft/confirm lifecycle for draws).
    if ($action === 'create') {
        $amount = isset($in['amount']) && $in['amount'] !== '' ? (float) $in['amount'] : 0.0;
        if ($amount <= 0) {
            out(400, ['error' => 'An amount is required.']);
        }
        $note = isset($in['note']) ? (string) $in['note'] : null;
        $date = isset($in['date']) && (string) $in['date'] !== '' ? (string) $in['date'] : null;
        $newId = (new OwnerDraws())->add($userId, $amount, $date, 'DKK', $note);
        (new BookkeepingAudit())->log($userId, 'draw', $newId, 'create', ['amount' => round($amount, 2)]);
        out(200, ['ok' => true, 'id' => $newId]);
    }

    if ($id <= 0) {
        out(400, ['error' => 'A draw id is required.']);
    }

    if ($action === 'discard') {
        $ok = (new OwnerDraws())->delete($userId, $id);
        if ($ok) {
            (new BookkeepingAudit())->log($userId, 'draw', $id, 'delete');
        }
        out(200, ['ok' => true, 'deleted' => $ok]);
    }

    out(400, ['error' => 'Unknown action.']);
} catch (\Throwable $e) {
    error_log('draws.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
