<?php

declare(strict_types=1);

/**
 * "Leave a message for the owner" from the recruiter page — NO login (the link's token is the access). The message is SAVED FIRST; only then is the owner told by push
 * and email, and "ok" is answered once it is saved (a failing push or email never loses it: bin/recruiter-cron.php retries).
 *   POST {token, name, contact, message, website}   website = a honeypot that must stay empty
 */

require __DIR__ . '/../bootstrap.php';

use App\Recruiter\LeadDelivery;
use App\Recruiter\RecruiterLinks;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false]);
}
try {
    $in    = json_decode((string) file_get_contents('php://input'), true) ?: [];
    $links = new RecruiterLinks();
    $link  = $links->byToken((string) ($in['token'] ?? ''));
    if ($link === null) {
        out(404, ['ok' => false, 'error' => 'invalid']);
    }
    if (in_array(RecruiterLinks::state($link), ['revoked', 'expired'], true)) {
        out(410, ['ok' => false, 'error' => 'expired']);
    }
    if (trim((string) ($in['website'] ?? '')) !== '') {
        out(200, ['ok' => true]);   // a bot filled the hidden field: pretend it worked, store nothing
    }
    $name    = trim((string) ($in['name'] ?? ''));
    $contact = trim((string) ($in['contact'] ?? ''));
    $message = trim((string) ($in['message'] ?? ''));
    if ($name === '' || mb_strlen($name) > 120 || mb_strlen($contact) < 5 || mb_strlen($contact) > 200 || $message === '' || mb_strlen($message) > 4000) {
        out(400, ['ok' => false, 'error' => 'fields']);
    }
    if ($links->leadsToday((int) $link['id']) >= 5) {
        out(429, ['ok' => false, 'error' => 'many']);
    }
    $leadId = $links->addLead((int) $link['id'], $name, $contact, $message);   // saved FIRST
    LeadDelivery::fromEnv($links)->deliver($link, $leadId, $name, $contact, $message);

    out(200, ['ok' => true]);
} catch (\Throwable $e) {
    error_log('meet-lead.php: ' . $e->getMessage());
    out(500, ['ok' => false, 'error' => 'server']);
}
