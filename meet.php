<?php

declare(strict_types=1);

/**
 * The recruiter page — "Kachow, the owner's assistant". Reached as /meet/<token> (error.php hands that path here, and the Caddy/Apache rewrite sends it here directly)
 * or as /meet.php?t=<token>. No login: the unguessable token in the link is the access. Shows a chat, a "leave a message" form and a notice about what this is.
 * The page never lists anything and never exposes anything but what the link's own chat can say.
 */

require __DIR__ . '/bootstrap.php';

use App\Recruiter\LeadDelivery;
use App\Recruiter\RecruiterLinks;

header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow, noarchive');
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');

$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');

$token = (string) ($_GET['t'] ?? '');
$state = 'invalid';
$link  = null;
try {
    $links = new RecruiterLinks();
    $link  = $links->byToken($token);
    if ($link !== null) {
        $state = RecruiterLinks::state($link);
        if ($state === 'ok' || $state === 'full') {
            if ($links->recordOpen((int) $link['id'])) {
                LeadDelivery::fromEnv($links)->opened($link);   // the first open: a push to the owner (best effort)
            }
        }
    }
} catch (\Throwable $ex) {
    error_log('meet.php: ' . $ex->getMessage());
    $state = 'error';
}

$owner   = 'the owner';
if ($link !== null) {
    try {
        $owner = trim((string) ((new \App\Data\Users())->findById((int) $link['user_id'])['name'] ?? '')) ?: $owner;
    } catch (\Throwable $ex) {
        // the name is only for the page text
    }
}
$role    = $link !== null ? trim((string) ($link['role_title'] ?? '')) : '';
$company = $link !== null ? trim((string) ($link['company'] ?? '')) : '';
$cfg = [
    'token'     => $state === 'ok' || $state === 'full' ? $token : '',
    'state'     => $state,
    'owner'     => $owner,
    'role'      => $role,
    'company'   => $company,
    'remaining' => $link !== null ? max(0, (int) $link['message_cap'] - (int) $link['messages_used']) : 0,
];
if ($state !== 'ok' && $state !== 'full') {
    http_response_code($state === 'error' ? 500 : 404);
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="robots" content="noindex, nofollow, noarchive">
    <title>Kachow · <?= $e($owner) ?>'s assistant</title>
    <link rel="icon" href="/assets/icon-192.png">
    <link rel="stylesheet" href="/assets/meet.css">
</head>
<body>
<main class="meet" id="meet" data-config="<?= $e((string) json_encode($cfg, JSON_UNESCAPED_UNICODE)) ?>">
    <header class="meet-head">
        <img class="meet-bird" src="/assets/hummingbird_still.png" alt="" width="44" height="44">
        <div class="meet-title">
            <div class="meet-name">Kachow</div>
            <div class="meet-sub" id="sub"><?= $e($owner) ?>'s assistant</div>
        </div>
        <button type="button" class="meet-lang" id="lang" aria-label="Language">DA</button>
    </header>

<?php if ($state !== 'ok' && $state !== 'full'): ?>
    <section class="meet-card meet-gone">
        <h1 id="goneTitle"><?= $state === 'expired' || $state === 'revoked' ? 'This link is no longer active' : ($state === 'error' ? 'Something went wrong' : 'This link is not valid') ?></h1>
        <p id="goneText">Please contact the owner directly — they will be glad to hear from you.</p>
    </section>
<?php else: ?>
    <section class="meet-note" id="note">
        You are chatting with <strong>Kachow, an AI assistant</strong> that <?= $e($owner) ?> built.
    </section>
    <details class="meet-about">
        <summary id="aboutSummary">About this assistant</summary>
        <p id="aboutBody">I'm an AI assistant that <?= $e($owner) ?> built, and I only know what <?= $e($owner) ?> has chosen to tell me. This chat is stored for 14 days.</p>
    </details>

    <section class="meet-chat" id="chat" aria-live="polite"></section>

    <div class="meet-chips" id="chips"></div>

    <form class="meet-form" id="form" autocomplete="off">
        <textarea id="input" rows="1" maxlength="1500" placeholder="Ask about <?= $e($owner) ?>…" aria-label="Your question"></textarea>
        <button type="submit" id="send" aria-label="Send">➤</button>
    </form>
    <div class="meet-left" id="left"></div>

    <details class="meet-card" id="leave">
        <summary id="leaveSummary">Leave a message</summary>
        <form id="leaveForm" class="meet-lead">
            <input type="text" id="leadName" maxlength="120" placeholder="Your name" required>
            <input type="text" id="leadContact" maxlength="200" placeholder="Email or phone" required>
            <textarea id="leadMessage" rows="4" maxlength="4000" placeholder="Your message" required></textarea>
            <input type="text" id="leadWebsite" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" class="meet-hp">
            <button type="submit" id="leadSend">Send</button>
            <div id="leadStatus" role="status"></div>
        </form>
    </details>
<?php endif; ?>
</main>
<script src="/assets/meet.js" defer></script>
</body>
</html>
