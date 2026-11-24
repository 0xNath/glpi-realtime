<?php

/**
 * The client's token is unknown to the server (Valkey restarted without persistence, or
 * cleared): any GLPI request issues a new one (post_init), this one says whether it did.
 * Without GLPI session, GLPI refuses the request: the tab stays disconnected.
 *
 * GET  →  {"ok": true|false}
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\SessionToken;

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// post_init ran already; again in case this request's session was opened late.
SessionToken::ensure((int) Session::getLoginUserID());
echo json_encode(['ok' => SessionToken::currentHash() !== null]);
