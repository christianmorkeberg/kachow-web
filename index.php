<?php

declare(strict_types=1);

/**
 * App shell: login page when logged out, chat UI when logged in.
 * Also handles login/logout and kicking off the Google Calendar OAuth flow.
 */

require __DIR__ . '/bootstrap.php';

use App\Auth\GoogleOAuth;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Connections;
use App\Data\RememberTokens;
use App\Data\Users;

$users   = new Users();
$session = new Session($users);
$session->boot();

// Remember-me auto-login.
if (!$session->isLoggedIn()) {
    $rememberedId = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($rememberedId !== null) {
        $session->establish($rememberedId);
    }
}

if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
}
$csrf = (string) $_SESSION['csrf'];

function redirect(string $to): never
{
    header('Location: ' . $to);
    exit;
}

function csrf_ok(string $expected): bool
{
    $given = $_POST['csrf'] ?? '';
    return is_string($given) && hash_equals($expected, $given);
}

$action = (string) ($_GET['action'] ?? $_POST['action'] ?? '');
$isPost = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST';
$loginError = null;

if ($action === 'logout') {
    (new RememberMe(new RememberTokens()))->forget();
    $session->logout();
    redirect('index.php');
}

if ($action === 'login' && $isPost) {
    if (!csrf_ok($csrf)) {
        $loginError = 'Your session expired. Please try again.';
    } else {
        $email    = trim((string) ($_POST['email'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        if ($session->login($email, $password)) {
            if (!empty($_POST['remember'])) {
                (new RememberMe(new RememberTokens()))->remember((int) $session->userId());
            }
            redirect('index.php');
        }
        $loginError = 'Invalid email or password.';
    }
}

if ($action === 'connect_google' && $session->isLoggedIn()) {
    $state = bin2hex(random_bytes(16));
    $_SESSION['google_state'] = $state;
    try {
        redirect(GoogleOAuth::fromEnv($users)->consentUrl($state));
    } catch (\Throwable $e) {
        redirect('index.php?google=error');
    }
}

$loggedIn    = $session->isLoggedIn();
$currentUser = $loggedIn ? $users->findById((int) $session->userId()) : null;

$calendarConnected = false;
if ($loggedIn) {
    try {
        $calendarConnected = GoogleOAuth::fromEnv($users)->isConnected((int) $session->userId());
    } catch (\Throwable $e) {
        $calendarConnected = false;
    }
}

// Incoming pending connection requests, to surface as a banner.
$pendingRequests = [];
if ($loggedIn) {
    try {
        foreach ((new Connections())->listForUser((int) $session->userId()) as $c) {
            if ($c['status'] === 'pending' && $c['direction'] === 'incoming') {
                $pendingRequests[] = $c;
            }
        }
    } catch (\Throwable $e) {
        $pendingRequests = [];
    }
}

$googleStatus = (string) ($_GET['google'] ?? '');
$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');

$displayName    = (string) ($currentUser['name'] ?? '') ?: (string) ($currentUser['email'] ?? '');
$displayInitial = $displayName !== '' ? mb_strtoupper(mb_substr($displayName, 0, 1)) : '?';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#0f172a">
    <title>Kachow Assistant</title>
    <link rel="manifest" href="/assets/manifest.json">
    <link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/assets/icon-192.png">
    <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<?php if (!$loggedIn): ?>
    <main class="auth">
        <form class="card" method="post" action="index.php" autocomplete="on">
            <h1 class="brand">⚡ Kachow :)</h1>
            <p class="muted">Sign in to your assistant</p>
            <?php if ($loginError !== null): ?>
                <p class="error"><?= $e($loginError) ?></p>
            <?php endif; ?>
            <input type="hidden" name="action" value="login">
            <input type="hidden" name="csrf" value="<?= $e($csrf) ?>">
            <label>Email
                <input type="email" name="email" required autofocus autocomplete="username">
            </label>
            <label>Password
                <input type="password" name="password" required autocomplete="current-password">
            </label>
            <label class="checkbox">
                <input type="checkbox" name="remember" value="1"> Remember me
            </label>
            <button type="submit">Sign in</button>
        </form>
    </main>
<?php else: ?>
    <div class="app">
        <header class="topbar">
            <span class="brand">⚡ Kachow</span>
            <div class="topbar-actions">
                <button type="button" id="notifBtn" class="badge iconbtn" title="Notifications" aria-label="Notifications" hidden>🔔</button>
                <button type="button" id="ttsToggle" class="badge iconbtn" title="Read replies aloud" aria-pressed="false" hidden>🔊</button>
                <?php if ($calendarConnected): ?>
                    <span class="badge ok" title="Google Calendar connected">📅<span class="label"> Connected</span></span>
                <?php else: ?>
                    <a class="badge" href="index.php?action=connect_google" title="Connect Google Calendar">📅<span class="label"> Connect Calendar</span></a>
                <?php endif; ?>
                <span class="who muted" title="<?= $e($displayName) ?>">
                    <span class="who-full"><?= $e($displayName) ?></span>
                    <span class="who-initial"><?= $e($displayInitial) ?></span>
                </span>
                <a class="link logout" href="index.php?action=logout" title="Log out" aria-label="Log out">
                    <span class="label">Log out</span>
                    <span class="icon" aria-hidden="true">🚪</span>
                </a>
            </div>
        </header>

        <?php if ($googleStatus === 'denied' || $googleStatus === 'error'): ?>
            <div class="banner warn">
                <?php if ($googleStatus === 'denied'): ?>
                    Calendar connection was cancelled.
                <?php else: ?>
                    Couldn't connect Google Calendar. Please try again.
                <?php endif; ?>
            </div>
        <?php endif; ?>
        <?php /* Success is shown by the "Connected" badge in the top bar — no banner. */ ?>

        <?php foreach ($pendingRequests as $req):
            $who = (string) ($req['person']['name'] ?? '') ?: (string) ($req['person']['email'] ?? 'Someone');
        ?>
            <div class="banner info">
                <strong><?= $e($who) ?></strong> wants to connect<?php if (!empty($req['they_share'])): ?>
                    and share their <?= $e(implode(', ', $req['they_share'])) ?><?php endif; ?>.
                Say &ldquo;accept <?= $e($who) ?>&rsquo;s request&rdquo; below to connect.
            </div>
        <?php endforeach; ?>

        <div id="notifModal" class="modal" hidden>
            <div class="modal-card" role="dialog" aria-modal="true" aria-label="Notification settings">
                <div class="modal-head">
                    <strong>Notifications</strong>
                    <button type="button" class="modal-close" id="notifClose" aria-label="Close">✕</button>
                </div>
                <div id="notifBody" class="modal-body"></div>
            </div>
        </div>

        <main id="messages" class="messages" aria-live="polite"></main>

        <form id="composer" class="composer">
            <button type="button" id="newChat" class="ghost" title="Start a new conversation">＋</button>
            <textarea id="input" rows="1" placeholder="Message your assistant…" autocomplete="off"></textarea>
            <button type="button" id="mic" class="ghost mic" title="Dictate a message" aria-label="Dictate a message" hidden>🎤</button>
            <button type="submit" id="send">Send</button>
        </form>
    </div>
    <script src="/assets/app.js" defer></script>
<?php endif; ?>
</body>
</html>
