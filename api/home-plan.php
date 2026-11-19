<?php

declare(strict_types=1);

/**
 * The Home card's floor plan (authenticated session). The image and the areas live in the DB (private), one per household: the user whose home agent it is.
 *
 *   GET                       → { ok, plan: { config, has_image, version } | null, can_edit }
 *   GET  ?image=1             → the image (private, cacheable by version)
 *   POST { config:{w,h,areas:[…]} }                 → save the areas
 *   POST multipart: image (file), config (JSON text, optional) → save the image (and the areas)
 *   POST { action:'remove' }  → delete the plan
 * Only the person whose home agent it is can change it; everyone in the household reads it.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\ApiTokens;
use App\Data\Connections;
use App\Data\HomePlan;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Home\HomeOwner;

function out(int $status, array $body): never
{
    header('Content-Type: application/json');
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
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
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

$owner   = (new HomeOwner(new ApiTokens(), new Connections()))->resolve($userId);
$ownerId = (int) $owner['owner_id'];
$canEdit = $ownerId === $userId;
$plans   = new HomePlan();

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        if (isset($_GET['image'])) {
            $img = $plans->image($ownerId);
            if ($img === null) {
                http_response_code(404);
                exit;
            }
            $etag = '"' . $img['version'] . '"';
            header('Content-Type: ' . $img['mime']);
            header('Cache-Control: private, max-age=86400');
            header('ETag: ' . $etag);
            if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
                http_response_code(304);
                exit;
            }
            echo $img['bytes'];
            exit;
        }
        out(200, ['ok' => true, 'plan' => $plans->get($ownerId), 'can_edit' => $canEdit]);
    }

    if (!$canEdit) {
        out(403, ['ok' => false, 'error' => 'Only the person whose home agent it is can change the floor plan.']);
    }
    $config = null;
    $bytes  = null;
    $mime   = null;
    if (str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'multipart/form-data')) {
        if (isset($_FILES['image']) && is_uploaded_file((string) $_FILES['image']['tmp_name'])) {
            $f = $_FILES['image'];
            if ($f['size'] > HomePlan::MAX_IMAGE) {
                out(413, ['ok' => false, 'error' => 'The image is too big (max 3 MB).']);
            }
            $bytes = (string) file_get_contents($f['tmp_name']);
            $mime  = (string) (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes);
            if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                out(415, ['ok' => false, 'error' => 'Use a JPEG, PNG or WebP image.']);
            }
        }
        if (isset($_POST['config']) && trim((string) $_POST['config']) !== '') {
            $config = json_decode((string) $_POST['config'], true);
        }
    } else {
        $in = json_decode((string) file_get_contents('php://input'), true);
        $in = is_array($in) ? $in : [];
        if (($in['action'] ?? '') === 'remove') {
            $plans->remove($ownerId);
            out(200, ['ok' => true, 'plan' => null]);
        }
        $config = $in['config'] ?? null;
    }
    if ($config !== null) {
        $config = HomePlan::clean($config);
        if (is_string($config)) {
            out(400, ['ok' => false, 'error' => $config]);
        }
    }
    if ($bytes === null && $config === null) {
        out(400, ['ok' => false, 'error' => 'Nothing to save: send an image and/or the areas.']);
    }
    $plans->save($ownerId, $bytes, $mime, $config);
    out(200, ['ok' => true, 'plan' => $plans->get($ownerId), 'can_edit' => true]);
} catch (\Throwable $e) {
    error_log('home-plan.php: ' . $e->getMessage());
    out(503, ['ok' => false, 'error' => 'The floor plan is not set up on the server yet (migration 2026-11-19_home_plan.sql).']);
}
