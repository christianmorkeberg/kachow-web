<?php

declare(strict_types=1);

/**
 * Scheduled-tasks card (authenticated session, JSON).
 *
 *   GET                                           → { ok, card }   (your tasks; the developer also gets the system jobs)
 *   POST { id:int, action:pause|resume }          → { ok, card }   (your own task)
 *   POST { system_task:string, action:… }         → { ok, card }   (developer only)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\ScheduledTasks;
use App\Data\SystemTasks;
use App\Data\Users;
use App\Tools\ScheduleTask;

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
$tasks   = new ScheduledTasks();

try {
    $system = null;
    if ($isAdmin) {
        $sysTasks = new SystemTasks();
        try {
            $sysTasks->ensureRows();
        } catch (\Throwable $e) {
            $sysTasks = null;   // migration not run yet: the card just has no system section
            error_log('scheduled-tasks.php system tasks: ' . $e->getMessage());
        }
    }

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $in     = json_decode((string) file_get_contents('php://input'), true);
        $in     = is_array($in) ? $in : [];
        $action = (string) ($in['action'] ?? '');
        if ($action !== 'pause' && $action !== 'resume') {
            out(400, ['error' => 'action must be pause or resume.']);
        }
        $active = $action === 'resume';

        $name = trim((string) ($in['system_task'] ?? ''));
        if ($name !== '') {
            if (!$isAdmin || $sysTasks === null) {
                out(403, ['error' => 'Only the developer can change the system jobs.']);
            }
            $key = SystemTasks::resolveKey($name);
            if ($key === null || !$sysTasks->setActive($key, $active)) {
                out(404, ['error' => 'No such system job.']);
            }
        } else {
            $id = (int) ($in['id'] ?? 0);
            if ($id <= 0) {
                out(400, ['error' => 'A task id is required.']);
            }
            if ($active) {
                $t = $tasks->find($userId, $id);
                if ($t !== null && $t['status'] === 'paused' && $tasks->countActive($userId) >= ScheduleTask::MAX_ACTIVE_PER_USER) {
                    out(409, ['error' => 'You already have ' . ScheduleTask::MAX_ACTIVE_PER_USER . ' scheduled tasks running — pause or cancel one first.']);
                }
            }
            $why = $tasks->setActive($userId, $id, $active);
            if ($why !== null) {
                out(409, ['error' => $why]);
            }
        }
    }

    if ($isAdmin && isset($sysTasks) && $sysTasks !== null) {
        $system = SystemTasks::cardRows($sysTasks->listAll());
    }
    out(200, ['ok' => true, 'card' => ScheduledTasks::card($tasks->listForCard($userId), $system)]);
} catch (\Throwable $e) {
    error_log('scheduled-tasks.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
