<?php

declare(strict_types=1);

/**
 * Serves the service worker with a per-deploy version stamp prepended, so its
 * bytes change whenever the CSS/JS (or the SW itself) change. The browser then
 * detects a new service worker on its update check, activates it, and the page
 * reloads onto the fresh assets — even for an installed PWA that stayed open.
 *
 * The actual SW logic lives in sw.js; this only streams it with a comment stamp.
 */

header('Content-Type: application/javascript; charset=utf-8');
header('Service-Worker-Allowed: /');
header('Cache-Control: no-cache, no-store, must-revalidate');

$version = 0;
foreach (['assets/styles.css', 'assets/app.js', 'sw.js'] as $file) {
    $mtime = @filemtime(__DIR__ . '/' . $file);
    if ($mtime !== false && $mtime > $version) {
        $version = $mtime;
    }
}

echo "// build {$version}\n";       // changes each deploy → triggers a SW update
readfile(__DIR__ . '/sw.js');
