<?php

/**
 * Interop helper for the Rust test suite: issues a session token and a grant exactly
 * as the plugin does in GLPI, then prints {"token": "...", "uid": N} on stdout.
 * php ... issue_token.php <valkey-port> <uid> <name> <ticket-id>
 */

declare(strict_types=1);

ob_start();
require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\SessionToken;

test_valkey((string) $argv[1]);
session_start();
$uid = (int) $argv[2];
User::$db[$uid] = ['name' => strtolower($argv[3]), 'picture' => 'ab/' . $uid . '.png'];
Session::$uid = $uid;
$_SESSION['glpifriendlyname'] = $argv[3];

// Capture the cookie the browser would receive.
$cookie = null;
SessionToken::$cookieSink = function (string $name, string $value, array $options) use (&$cookie) {
    $cookie = ['name' => $name, 'token' => $value, 'options' => $options];
};
SessionToken::ensure($uid);
$t = new Ticket();
$t->fields['id'] = (int) $argv[4];
Grants::write($t);
ob_end_clean();

echo json_encode(['uid' => $uid, 'cookie' => $cookie, 'hash' => SessionToken::currentHash()]), "\n";
