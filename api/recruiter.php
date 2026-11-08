<?php

declare(strict_types=1);

/**
 * The owner's Recruiter card (authenticated session, JSON) — admin only.
 *   GET                         → { ok, card }                       the links, left messages and facts as they are now
 *   GET  ?export=1              → the facts as a JSON file download  (the backup: commit it to the private docs repo)
 *   POST { action:'import', json:string, mode:'replace'|'add', dry?:bool }  → { ok, counts, errors, card }   dry = only check the text, write nothing
 *   POST { action:'revoke'|'reactivate', id }           → { ok, card }
 *   POST { action:'set_visibility', id, visibility }    → { ok, card }   public | summary | private
 *   POST { action:'mark_read' }                         → { ok, card }   all left messages read
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Recruiter\AboutEntries;
use App\Recruiter\RecruiterCard;
use App\Recruiter\RecruiterLinks;

function out(int $status, array $body): never
{
    header('Content-Type: application/json');
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
    out(403, ['error' => 'Only the owner can use the recruiter card.']);
}

try {
    $links   = new RecruiterLinks();
    $entries = new AboutEntries();
    $host    = (string) ($_SERVER['HTTP_HOST'] ?? 'assistant.kachow.dk');
    $card    = static fn (): array => RecruiterCard::build($userId, $links, $entries, $host);

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        if (!empty($_GET['export'])) {
            header('Content-Type: application/json; charset=utf-8');
            header('Content-Disposition: attachment; filename="entries-' . gmdate('Y-m-d') . '.json"');
            header('Cache-Control: no-store');
            echo json_encode($entries->export($userId), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            exit;
        }
        out(200, ['ok' => true, 'card' => $card()]);
    }

    $in     = json_decode((string) file_get_contents('php://input'), true);
    $in     = is_array($in) ? $in : [];
    $action = (string) ($in['action'] ?? '');

    switch ($action) {
        case 'import':
            $parsed = AboutEntries::parseImport((string) ($in['json'] ?? ''));
            $blocking = array_filter($parsed['errors'], static fn (string $e): bool => !str_contains($e, 'summary-only but has no summary'));
            if ($parsed['entries'] === [] || $blocking !== []) {
                out(422, ['ok' => false, 'counts' => $parsed['counts'], 'errors' => $parsed['errors'] ?: ['Nothing to import.']]);
            }
            if (!empty($in['dry'])) {
                out(200, ['ok' => true, 'dry' => true, 'counts' => $parsed['counts'], 'errors' => $parsed['errors'], 'total' => count($parsed['entries']), 'existing' => count($entries->all($userId))]);
            }
            $mode = ($in['mode'] ?? 'replace') === 'add' ? 'add' : 'replace';
            $n    = $entries->import($userId, $parsed['entries'], $mode);
            out(200, ['ok' => true, 'imported' => $n, 'mode' => $mode, 'counts' => $parsed['counts'], 'errors' => $parsed['errors'], 'card' => $card()]);

        case 'revoke':
            $links->revoke($userId, (int) ($in['id'] ?? 0));
            out(200, ['ok' => true, 'card' => $card()]);

        case 'reactivate':
            $id = (int) ($in['id'] ?? 0);
            if (($l = $links->byId($id)) !== null && (int) $l['user_id'] === $userId) {
                $links->update($userId, $id, ['reactivate' => true]);
            }
            out(200, ['ok' => true, 'card' => $card()]);

        case 'set_visibility':
            if (!in_array((string) ($in['visibility'] ?? ''), ['public', 'summary', 'private'], true)) {
                out(400, ['error' => 'Visibility is public, summary or private.']);
            }
            $entries->setVisibility($userId, (int) ($in['id'] ?? 0), (string) $in['visibility']);
            out(200, ['ok' => true, 'card' => $card()]);

        case 'mark_read':
            $links->markLeadsRead($userId);
            out(200, ['ok' => true, 'card' => $card()]);
    }
    out(400, ['error' => 'Unknown action.']);
} catch (\Throwable $e) {
    error_log('recruiter.php: ' . $e->getMessage());
    out(500, ['error' => 'Something went wrong.']);
}
