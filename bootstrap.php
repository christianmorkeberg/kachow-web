<?php

declare(strict_types=1);

/**
 * Loads the out-of-webroot business-logic app (assistant-app) and its config.
 *
 * The spec bootstraps every webroot entry point with two hardcoded requires:
 *
 *     require '/home/kachowdk/assistant-app/vendor/autoload.php';
 *     require '/home/kachowdk/assistant-app/config.php';
 *
 * That path is correct in production but not in local dev, where the sibling
 * folder is named "kachow-app" (the repo) rather than "assistant-app" (the
 * server checkout). This resolver keeps the same effect while working in both:
 * production path first, then an env override, then local siblings.
 */

$candidates = [];

foreach (['ASSISTANT_APP_PATH'] as $var) {
    $fromEnv = getenv($var);
    if (is_string($fromEnv) && $fromEnv !== '') {
        $candidates[] = $fromEnv;
    }
}

$candidates[] = '/home/kachowdk/assistant-app';   // production (spec §3)
$candidates[] = __DIR__ . '/../assistant-app';     // server-style sibling
$candidates[] = __DIR__ . '/../kachow-app';        // local dev sibling (this workspace)

$appPath = null;
foreach ($candidates as $candidate) {
    if (is_file($candidate . '/vendor/autoload.php')) {
        $appPath = $candidate;
        break;
    }
}

if ($appPath === null) {
    http_response_code(500);
    if (!headers_sent()) {
        header('Content-Type: application/json');
    }
    echo json_encode(['error' => 'Server misconfiguration: business-logic app not found.']);
    exit;
}

require $appPath . '/vendor/autoload.php';
require $appPath . '/config.php';
