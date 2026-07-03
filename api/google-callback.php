<?php

declare(strict_types=1);

/**
 * OAuth redirect target for Google Calendar.
 *
 * Only ever reached via redirect from Google (never called by frontend JS). The
 * user must already be logged into the app; we attach the returned refresh token
 * to their account (encrypted, via GoogleOAuth -> Users) and bounce back to the
 * app with a status.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\GoogleOAuth;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\RememberTokens;
use App\Data\Users;

$users   = new Users();
$session = new Session($users);
$session->boot();

if (!$session->isLoggedIn()) {
    $rememberedId = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($rememberedId !== null) {
        $session->establish($rememberedId);
    }
}

function back(string $status): never
{
    header('Location: /index.php?google=' . rawurlencode($status));
    exit;
}

// Must be an authenticated app user to attach a calendar to.
if (!$session->isLoggedIn()) {
    header('Location: /index.php');
    exit;
}

// User declined consent, or Google returned an error.
if (isset($_GET['error'])) {
    back('denied');
}

$code          = (string) ($_GET['code'] ?? '');
$state         = (string) ($_GET['state'] ?? '');
$expectedState = (string) ($_SESSION['google_state'] ?? '');
unset($_SESSION['google_state']);

if ($code === '' || $state === '' || $expectedState === '' || !hash_equals($expectedState, $state)) {
    // Missing code or CSRF state mismatch.
    back('error');
}

try {
    GoogleOAuth::fromEnv($users)->handleCallback($code, (int) $session->userId());
    back('connected');
} catch (\Throwable $e) {
    error_log('google-callback.php: ' . $e->getMessage());
    back('error');
}
