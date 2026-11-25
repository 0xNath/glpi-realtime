<?php

/**
 * A stand-in for glpi-realtime behind the web server, for health_test.php's real
 * requests (php -S): /ws without the upgrade headers is refused as the server does,
 * with them and GLPI's origin it asks for a session.
 */

declare(strict_types=1);

if (parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) !== '/ws') {
    http_response_code(404);
    echo '<html>GLPI</html>';
    return true;
}
$upgrade = strtolower($_SERVER['HTTP_UPGRADE'] ?? '') === 'websocket'
    && str_contains(strtolower($_SERVER['HTTP_CONNECTION'] ?? ''), 'upgrade');
if (!$upgrade) {
    http_response_code(400);
    echo "Connection header did not include 'upgrade'";
} elseif (($_SERVER['HTTP_ORIGIN'] ?? '') !== getenv('RT_ORIGIN')) {
    http_response_code(403);
} else {
    http_response_code(401);
}
return true;
