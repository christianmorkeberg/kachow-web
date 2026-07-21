<?php

declare(strict_types=1);

/**
 * Feedback card actions (authenticated session, JSON) — admin only. The resolve button
 * on the feedback card.
 *
 *   POST { action:'resolve'|'seen'|'new', id:int } → { ok:true, status:string }
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\FeedbackReports;
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
if (!$users->isAdmin($userId)) {
    out(403, ['error' => 'Only the developer can update reports.']);
}

$in     = json_decode((string) file_get_contents('php://input'), true);
$in     = is_array($in) ? $in : [];
$action = (string) ($in['action'] ?? 'resolve');
$id     = (int) ($in['id'] ?? 0);

// The button sends the action verb "resolve"; map actions to the stored status values.
$statusFor = ['resolve' => 'resolved', 'resolved' => 'resolved', 'seen' => 'seen', 'new' => 'new'];
if ($id <= 0 || !isset($statusFor[$action])) {
    out(400, ['error' => 'A report id and a valid action are required.']);
}
$status = $statusFor[$action];

try {
    $ok = (new FeedbackReports())->setStatus($id, $status);
    $ok ? out(200, ['ok' => true, 'status' => $status]) : out(404, ['error' => 'No such report.']);
} catch (\Throwable $e) {
    error_log('feedback.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
