<?php

declare(strict_types=1);

/**
 * Self-service registration via an admin-issued invite link
 * (/register.php?token=...). The token is a single-use secret; the email is
 * fixed by the invite (not user-editable). On success the new account is created
 * and logged in.
 */

require __DIR__ . '/bootstrap.php';

use App\Auth\Session;
use App\Data\Invites;
use App\Data\Users;

$users   = new Users();
$session = new Session($users);
$session->boot();

$invites = new Invites();

$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');

function redirect(string $to): never
{
    header('Location: ' . $to);
    exit;
}

$token  = (string) ($_GET['token'] ?? $_POST['token'] ?? '');
$invite = $token !== '' ? $invites->findValid(hash('sha256', $token)) : null;
$error  = null;

if ($invite === null) {
    $error = 'This invitation link is invalid, already used, or expired. Ask an admin for a new one.';
}

if ($invite !== null && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $name = trim((string) ($_POST['name'] ?? ''));
    $pw   = (string) ($_POST['password'] ?? '');
    $pw2  = (string) ($_POST['password_confirm'] ?? '');

    if ($name === '') {
        $error = 'Please enter your name.';
    } elseif (strlen($pw) < 8) {
        $error = 'Password must be at least 8 characters.';
    } elseif ($pw !== $pw2) {
        $error = 'Passwords do not match.';
    } elseif ($users->findByEmail((string) $invite['email']) !== null) {
        $error = 'An account already exists for this email.';
    } else {
        $uid = $users->create((string) $invite['email'], password_hash($pw, PASSWORD_DEFAULT), 'user', $name);
        $invites->markUsed((int) $invite['id']);
        $session->establish($uid);
        redirect('index.php');
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#0f172a">
    <title>Create your Kachow account</title>
    <link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
    <main class="auth">
        <?php if ($invite === null): ?>
            <div class="card">
                <h1 class="brand">⚡ Kachow</h1>
                <p class="error"><?= $e((string) $error) ?></p>
                <a class="link" href="index.php">Back to sign in</a>
            </div>
        <?php else: ?>
            <form class="card" method="post" action="register.php" autocomplete="on">
                <h1 class="brand">⚡ Kachow</h1>
                <p class="muted">Create your account</p>
                <?php if ($error !== null): ?>
                    <p class="error"><?= $e($error) ?></p>
                <?php endif; ?>
                <input type="hidden" name="token" value="<?= $e($token) ?>">
                <label>Email
                    <input type="email" value="<?= $e((string) $invite['email']) ?>" disabled>
                </label>
                <label>Your name
                    <input type="text" name="name" required autofocus autocomplete="name">
                </label>
                <label>Password
                    <input type="password" name="password" required minlength="8" autocomplete="new-password">
                </label>
                <label>Confirm password
                    <input type="password" name="password_confirm" required minlength="8" autocomplete="new-password">
                </label>
                <button type="submit">Create account</button>
            </form>
        <?php endif; ?>
    </main>
</body>
</html>
