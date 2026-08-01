<?php

declare(strict_types=1);

/**
 * Export one feedback report as a self-contained Markdown bundle (ADMIN ONLY), so the
 * developer can hand Claude everything needed to diagnose in a single paste: the
 * reported message, the surrounding conversation, and the full diagnostics (routing,
 * tool calls, timing, thoughts) — plus a blank "what should have happened" section.
 *
 *   GET ?id=N  → downloads kachow-report-N.md
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\FeedbackReports;
use App\Data\RememberTokens;
use App\Data\Users;

function fail(int $code, string $msg): never
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $msg;
    exit;
}

$users   = new Users();
$session = new Session($users);
$session->boot();
if (!$session->isLoggedIn()) {
    $remembered = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($remembered !== null) {
        $session->establish($remembered);
    }
}
if (!$session->isLoggedIn()) {
    fail(401, 'Not authenticated.');
}
$userId = (int) $session->userId();
if (!$users->isAdmin($userId)) {
    fail(403, 'Feedback reports are only available to the developer/admin.');
}

$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
if ($id <= 0) {
    fail(400, 'A report id is required.');
}

$report = (new FeedbackReports())->find($id);
if ($report === null) {
    fail(404, 'Report not found.');
}

$snap     = json_decode((string) $report['snapshot'], true);
$snap     = is_array($snap) ? $snap : [];
$reported = is_array($snap['reported'] ?? null) ? $snap['reported'] : [];
$diag     = is_array($reported['diagnostics'] ?? null) ? $reported['diagnostics'] : [];
$context  = is_array($snap['context'] ?? null) ? $snap['context'] : [];

$nl    = "\n";
$quote = static fn (string $s): string => '> ' . str_replace($nl, $nl . '> ', trim($s));

$md  = '# Kachow error report #' . $id . $nl . $nl;
$md .= '- **From:** ' . ($report['reporter_name'] ?: $report['reporter_email']) . $nl;
$md .= '- **When:** ' . $report['created_at'] . $nl;
$md .= '- **Status:** ' . $report['status'] . $nl;
$md .= '- **Conversation:** ' . ($report['conversation_id'] ?? '—')
    . ' · **Message:** ' . ($report['message_id'] ?? '—') . $nl . $nl;

$note = (string) ($report['note'] ?? '');
$md  .= '## Reporter’s note' . $nl . ($note !== '' ? $note : '_(none)_') . $nl . $nl;

$md  .= '## Developer notes — what should have happened' . $nl
    . '_(fill this in before sending to Claude: what you expected vs. what happened)_' . $nl . $nl;

$md .= '## Reported message (' . ($reported['role'] ?? '?') . ')' . $nl;
$md .= $quote((string) ($reported['content'] ?? '')) . $nl;
if (!empty($reported['card_kind'])) {
    $md .= $nl . '_[card shown: ' . $reported['card_kind'] . ']_' . $nl;
}
$md .= $nl;

$md    .= '## Diagnostics' . $nl;
$routing = isset($diag['routing']) ? implode(', ', (array) $diag['routing']) : '—';
$md    .= '- **Routing:** ' . $routing . $nl;
$md    .= '- **Model:** ' . ($diag['model'] ?? '—') . $nl;
if (isset($diag['tools_sent'])) {
    $md .= '- **Tools sent:** ' . $diag['tools_sent'] . $nl;
}
if (isset($diag['timing']) && is_array($diag['timing'])) {
    $t   = $diag['timing'];
    $md .= '- **Timing:** total ' . ($t['total_ms'] ?? '?') . 'ms · gemini ' . ($t['gemini_ms'] ?? '?')
        . 'ms (' . ($t['gemini_calls'] ?? '?') . ' calls) · tools ' . ($t['tools_ms'] ?? '?')
        . 'ms · app ' . ($t['app_ms'] ?? '?') . 'ms' . $nl;
}
$md .= $nl;

if (!empty($diag['calls']) && is_array($diag['calls'])) {
    $md .= '### Tool calls' . $nl;
    foreach ($diag['calls'] as $c) {
        if (!is_array($c)) {
            continue;
        }
        $line = '- `' . ($c['name'] ?? '?') . '`';
        if (isset($c['args']) && $c['args'] !== '') {
            $line .= ' args=`' . (is_string($c['args']) ? $c['args'] : json_encode($c['args'])) . '`';
        }
        $line .= ($c['ok'] ?? true) ? ' → ok' : ' → **ERROR:** ' . ($c['error'] ?? '');
        if (isset($c['ms'])) {
            $line .= ' _(' . $c['ms'] . 'ms)_';
        }
        $md .= $line . $nl;
    }
    $md .= $nl;
}

if (!empty($diag['thoughts']) && is_array($diag['thoughts'])) {
    $md .= '### Model thoughts' . $nl;
    foreach ($diag['thoughts'] as $th) {
        $md .= $quote((string) $th) . $nl . $nl;
    }
}

$md .= '## Conversation leading up to it' . $nl;
$n   = count($context);
foreach ($context as $i => $m) {
    if (!is_array($m)) {
        continue;
    }
    $role = (string) ($m['role'] ?? '?');
    $who  = ($role === 'tool' || !empty($m['tool_name']))
        ? '**[tool: ' . ($m['tool_name'] ?? 'result') . ']**'
        : '**' . ucfirst($role) . '**';
    $marker = ($i === $n - 1) ? '  ⟵ REPORTED' : '';
    $text   = trim((string) ($m['content'] ?? ($m['text'] ?? '')));
    $md    .= $who . $marker . $nl . ($text !== '' ? $text : '_(empty)_') . $nl . $nl;
}

$md .= '---' . $nl . '_Kachow report export · ' . date('c') . '_' . $nl;

$filename = 'kachow-report-' . $id . '.md';
header('Content-Type: text/markdown; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $filename . '"');
header('Cache-Control: no-store');
echo $md;
