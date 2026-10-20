<?php

declare(strict_types=1);

/**
 * Scheduled-tasks card (authenticated session, JSON).
 *
 *   GET                                           → { ok, card }   (your tasks; the developer also gets the system jobs)
 *   POST { id:int, action:pause|resume }          → { ok, card }   (your own task)
 *   POST { id:int, action:run }                   → starts it now (Run now)
 *   POST { id:int, action:save|discard }          → a routine draft: make it live / remove it
 *   POST { id:int, action:mode, value:auto|ask }  → a recurring task or routine: run by itself, or ask first
 *   POST { id:int, action:undo }                  → put the lights back as they were before its last run
 *   POST { id:int, action:forget }                → drop its recorded steps (the next run asks the assistant and records again)
 *   POST { action:build, ...fields }              → the card's builder: a new, live routine (fields as create_routine takes them)
 *   POST { id:int, action:edit, ...fields }       → the builder on an existing routine (fields as update_routine takes them)
 *   POST { request_id:int, action:answer, approve:bool } → an "ask first" question: run it / skip it
 *   POST { system_task:string, action:… }         → { ok, card }   (developer only)
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\AgentCommands;
use App\Data\ApiTokens;
use App\Data\Connections;
use App\Data\Conversations;
use App\Data\HomeDevices;
use App\Data\Places;
use App\Data\RememberTokens;
use App\Data\Routines;
use App\Support\BackgroundRun;
use App\Data\ScheduledTasks;
use App\Data\SystemTasks;
use App\Data\Users;
use App\Home\HomeOwner;
use App\Home\HueSync;
use App\Tools\CreateRoutine;
use App\Tools\HomeDeviceCall;
use App\Tools\ScheduleTask;
use App\Tools\UndoRoutine;
use App\Tools\UpdateRoutine;

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
        $routines = new Routines();
        $kick     = static fn (): bool => BackgroundRun::kick($appPath . '/bin/scheduled-tasks-cron.php', ['--requested-only']);
        if ($action === 'answer') {
            $res = $routines->decideRequest($userId, (int) ($in['request_id'] ?? 0), filter_var($in['approve'] ?? false, FILTER_VALIDATE_BOOLEAN));
            if ($res === null) {
                out(404, ['error' => 'That question is no longer open.']);
            }
            if ($res > 0) {
                $kick();
            }
            out(200, ['ok' => true, 'card' => $tasks->cardForUser($userId, new Places(), $isAdmin && isset($sysTasks) ? SystemTasks::cardRows($sysTasks->listAll()) : null)]);
        }
        if ($action === 'build' || $action === 'edit') {
            // The builder form sends the same fields the assistant's tools take, so the checks are the same ones.
            $fields = array_diff_key($in, ['action' => 1, 'id' => 1]);
            $places = new Places();
            if ($action === 'build') {
                $res = (new CreateRoutine($routines, $tasks, new Conversations(), $places))->execute($fields + ['save' => true], $userId);
            } else {
                $res = (new UpdateRoutine($routines, $tasks, $places))->execute($fields + ['routine' => (string) (int) ($in['id'] ?? 0)], $userId);
            }
            if (isset($res['error'])) {
                out(422, ['error' => (string) $res['error']]);
            }
            out(200, ['ok' => true, 'card' => $tasks->cardForUser($userId, $places, $isAdmin && isset($sysTasks) ? SystemTasks::cardRows($sysTasks->listAll()) : null)]);
        }
        if ($action === 'undo' || $action === 'forget') {
            $id = (int) ($in['id'] ?? 0);
            if ($routines->getAny($userId, $id) === null) {
                out(404, ['error' => 'No such task.']);
            }
            if ($action === 'forget') {
                $routines->saveSteps($id, null);
            } else {
                $agent = new AgentCommands();
                $tokens = new ApiTokens();
                $home  = new HomeDeviceCall($agent, $tokens, new HueSync(new HomeDevices(), HueSync::viaAgent($agent)), new HomeOwner($tokens, new Connections()));
                $res   = (new UndoRoutine($routines, $home))->execute(['routine' => (string) $id], $userId);
                if (empty($res['undone'])) {
                    out(409, ['error' => (string) ($res['note'] ?? 'Could not undo that.')]);
                }
            }
            out(200, ['ok' => true, 'card' => $tasks->cardForUser($userId, new Places(), $isAdmin && isset($sysTasks) ? SystemTasks::cardRows($sysTasks->listAll()) : null)]);
        }
        if (in_array($action, ['run', 'save', 'discard', 'mode'], true)) {
            $id = (int) ($in['id'] ?? 0);
            $ok = match ($action) {
                'run'     => $routines->requestRun($userId, $id, 'run now (card)'),
                'save'    => $routines->setStatus($userId, $id, 'active'),
                'discard' => $routines->setStatus($userId, $id, 'cancelled'),
                'mode'    => $routines->setRunMode($userId, $id, (string) ($in['value'] ?? '')),
            };
            if (!$ok) {
                out(409, ['error' => $action === 'run' ? 'It is not active, or a run is already waiting.' : 'That did not work.']);
            }
            if ($action === 'run') {
                $kick();
            }
        } elseif ($action !== 'pause' && $action !== 'resume') {
            out(400, ['error' => 'Unknown action.']);
        }
        if ($action === 'pause' || $action === 'resume') {
            $active = $action === 'resume';
            $name   = trim((string) ($in['system_task'] ?? ''));
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
    }

    if ($isAdmin && isset($sysTasks) && $sysTasks !== null) {
        $system = SystemTasks::cardRows($sysTasks->listAll());
    }
    out(200, ['ok' => true, 'card' => $tasks->cardForUser($userId, new Places(), $system)]);
} catch (\Throwable $e) {
    error_log('scheduled-tasks.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
