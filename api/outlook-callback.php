<?php

declare(strict_types=1);

/**
 * OAuth redirect target for Microsoft (Outlook/Hotmail email connect).
 *
 * Only ever reached via redirect from Microsoft. The user must already be logged
 * into the app; we store the returned refresh token as an email account
 * (encrypted, via OutlookConnect -> email_accounts) and bounce back with a status.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\OutlookConnect;
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

function back(string $status): never
{
    header('Location: /index.php?email=' . rawurlencode($status));
    exit;
}

if (!$session->isLoggedIn()) {
    header('Location: /index.php');
    exit;
}

if (isset($_GET['error'])) {
    back('denied');
}

$code          = (string) ($_GET['code'] ?? '');
$state         = (string) ($_GET['state'] ?? '');
$expectedState = (string) ($_SESSION['outlook_state'] ?? '');
unset($_SESSION['outlook_state']);

if ($code === '' || $state === '' || $expectedState === '' || !hash_equals($expectedState, $state)) {
    back('error');
}

try {
    OutlookConnect::fromEnv(new EmailAccounts())->handleCallback($code, (int) $session->userId());
    back('connected');
} catch (\Throwable $e) {
    error_log('outlook-callback.php: ' . $e->getMessage());
    // Surface the real reason (Microsoft's error text carries no secrets) so a
    // failed connect is diagnosable without digging through server logs.
    header('Location: /index.php?email=error&detail=' . rawurlencode($e->getMessage()));
    exit;
}
