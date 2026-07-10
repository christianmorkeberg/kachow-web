<?php

declare(strict_types=1);

/**
 * OAuth redirect target for Google — shared by two intents:
 *   - calendar: attaches the refresh token to the user (GoogleOAuth -> Users).
 *   - email:    connects a Gmail mailbox (GmailConnect -> email_accounts).
 *
 * Which one is decided by the CSRF state key present in the session
 * (google_state vs gmail_state), set when the consent URL was built in index.php.
 * Only ever reached via redirect from Google (never called by frontend JS).
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\GmailConnect;
use App\Auth\GoogleOAuth;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\EmailAccounts;
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

function back(string $key, string $status): never
{
    header('Location: /index.php?' . $key . '=' . rawurlencode($status));
    exit;
}

// Must be an authenticated app user to attach anything to.
if (!$session->isLoggedIn()) {
    header('Location: /index.php');
    exit;
}

$code  = (string) ($_GET['code'] ?? '');
$state = (string) ($_GET['state'] ?? '');

// Route by which flow started this (email takes precedence if both somehow set).
$isEmail       = isset($_SESSION['gmail_state']);
$statusKey     = $isEmail ? 'email' : 'google';
$expectedState = (string) ($_SESSION[$isEmail ? 'gmail_state' : 'google_state'] ?? '');
unset($_SESSION['gmail_state'], $_SESSION['google_state']);

// User declined consent, or Google returned an error.
if (isset($_GET['error'])) {
    back($statusKey, 'denied');
}

if ($code === '' || $state === '' || $expectedState === '' || !hash_equals($expectedState, $state)) {
    // Missing code or CSRF state mismatch.
    back($statusKey, 'error');
}

try {
    if ($isEmail) {
        GmailConnect::fromEnv(new EmailAccounts())->handleCallback($code, (int) $session->userId());
    } else {
        GoogleOAuth::fromEnv($users)->handleCallback($code, (int) $session->userId());
    }
    back($statusKey, 'connected');
} catch (\Throwable $e) {
    error_log('google-callback.php (' . $statusKey . '): ' . $e->getMessage());
    back($statusKey, 'error');
}
