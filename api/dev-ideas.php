<?php

declare(strict_types=1);

/**
 * Dev-ideas card (authenticated session, JSON).
 *
 *   GET                                  → { ok, card }   (admin: every idea; others: their own)
 *   POST { id:int, status:new|in_progress|done } → { ok, card }   (admin only)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\DevIdeas;
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
$userId  = (int) $session->userId();
$isAdmin = $users->isAdmin($userId);
$ideas   = new DevIdeas();

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!$isAdmin) {
            out(403, ['error' => 'Only the developer can change the status of ideas.']);
        }
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $in     = is_array($in) ? $in : [];
        $id     = (int) ($in['id'] ?? 0);
        $status = (string) ($in['status'] ?? '');
        if ($id <= 0 || !isset(DevIdeas::STATUSES[$status])) {
            out(400, ['error' => 'An idea id and a valid status are required.']);
        }
        if (!$ideas->setStatus($id, $status)) {
            out(404, ['error' => 'No such idea.']);
        }
    }

    $list = $isAdmin ? $ideas->listAll() : $ideas->listForUser($userId);
    out(200, ['ok' => true, 'card' => DevIdeas::card($list, $isAdmin, $userId, (string) ($_GET['filter'] ?? 'open'))]);
} catch (\Throwable $e) {
    error_log('dev-ideas.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
