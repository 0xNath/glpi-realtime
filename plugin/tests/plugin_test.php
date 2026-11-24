<?php

/**
 * Plugin behaviour against a real Valkey.
 * php -d extension=igbinary -d extension=redis plugin/tests/plugin_test.php <valkey-port>
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\SessionToken;
use GlpiPlugin\Realtime\Settings;
use GlpiPlugin\Realtime\Valkey;

$r = test_valkey((string) ($argv[1] ?? '6379'));
$r->flushDB();
session_start();
$ttl = Settings::sessionTtl();

User::$db = [
    7 => ['name' => 'alice', 'picture' => null],
    9 => ['name' => 'bob', 'picture' => 'ab/bob.png'],
];

// --- Token issuance --------------------------------------------------------------
$cookies = [];
SessionToken::$cookieSink = function (string $name, string $value, array $options) use (&$cookies) {
    $cookies[] = [$name, $value, $options];
};
Session::$uid = 7;
$_SESSION['glpifriendlyname'] = 'Alice Martin';
SessionToken::ensure(7);
$h1 = SessionToken::currentHash();
[$cname, $cvalue, $copts] = $cookies[0] ?? ['', '', []];
check($cname === 'glpi_rt' && preg_match('/^[0-9a-f]{64}$/', $cvalue) === 1, 'cookie carries a 64-hex token');
check(hash('sha256', $cvalue) === $h1, 'only the sha256 of the token is kept server-side');
check(
    $copts['httponly'] === true && $copts['secure'] === true && $copts['samesite'] === 'Strict'
        && $copts['path'] === '/ws' && $copts['expires'] === 0,
    'cookie is HttpOnly, Secure, SameSite=Strict, limited to /ws, session-only'
);
check($r->keys('*' . $cvalue . '*') === [], 'clear token never written to Valkey');
check(is_string($h1) && strlen($h1) === 64, 'token hash stored in the PHP session');
$k1 = SessionToken::sessionKey($h1);
$stored = $r->hGetAll($k1);
check($stored['uid'] === '7' && $stored['name'] === 'Alice Martin', 'session key holds uid and name');
check(
    json_decode($stored['avatar'], true) === ['picture' => '', 'initials' => 'AL', 'color' => '#5a7f9e', 'fg' => '#ffffff'],
    'avatar without picture: GLPI initials and colors'
);
check($r->ttl($k1) > 0 && $r->ttl($k1) <= $ttl, 'session key has the PHP session TTL');

// --- Sliding, no re-issue ---------------------------------------------------------
$r->expire($k1, 10);
SessionToken::ensure(7);
check(SessionToken::currentHash() === $h1, 'same token on following requests');
check(count($cookies) === 1, 'no new cookie while the token is alive');
check($r->ttl($k1) > 10, 'TTL slid by the request');

// --- Key vanished: a new token is issued ------------------------------------------
$r->del($k1);
SessionToken::ensure(7);
$h2 = SessionToken::currentHash();
check($h2 !== null && $h2 !== $h1 && $r->exists(SessionToken::sessionKey($h2)) === 1, 're-issued after the key vanished');

// --- Impersonation: identity change revokes the old token -------------------------
SessionToken::ensure(9);
$h3 = SessionToken::currentHash();
check($h3 !== $h2, 'new token for the new identity');
check($r->exists(SessionToken::sessionKey($h2)) === 0, 'old identity token revoked');
check($r->hGet(SessionToken::sessionKey($h3), 'uid') === '9', 'new token carries the new uid');
check(
    json_decode($r->hGet(SessionToken::sessionKey($h3), 'avatar'), true)['picture'] === '/front/document.send.php?file=_pictures/ab/bob.png',
    'avatar with picture: GLPI thumbnail URL'
);
Entity::$initials = false;
check(SessionToken::avatar(7)['picture'] === '/pics/picture.png', 'initials disabled by the entity: default picture');
Entity::$initials = true;
check(SessionToken::avatar(12345) === [], 'unknown user: no avatar');

// --- Sessions opened before avatars existed get one on their next request -----------
$r->hDel(SessionToken::sessionKey($h3), 'avatar');
unset($_SESSION['plugin_realtime']['avatar']);
SessionToken::ensure(9);
check(SessionToken::currentHash() === $h3 && $r->hExists(SessionToken::sessionKey($h3), 'avatar'), 'avatar added to an existing session');

// --- Grants -------------------------------------------------------------------------
$t = new Ticket();
$t->fields['id'] = 42;
$t->updatable = true;
Session::$rights = ['followup' => ITILFollowup::SEEPRIVATE, 'task' => 0];
check(Grants::write($t), 'grant written for a readable ticket');
$g = $r->hGetAll(Valkey::key('g:' . $h3 . ':Ticket:42'));
check(($g['read'] ?? null) === '1' && ($g['update'] ?? null) === '1', 'grant flags read/update');
check(($g['see_private_followup'] ?? null) === '1' && ($g['see_private_task'] ?? null) === '0', 'private visibility flags follow GLPI rights');
check(($g['see_private_followup_groups'] ?? null) === '0', 'group private flag');
$gttl = $r->ttl(Valkey::key('g:' . $h3 . ':Ticket:42'));
check($gttl > 0 && $gttl <= $r->ttl(SessionToken::sessionKey($h3)), 'grant expires with the session');

$t->updatable = false;
Grants::write($t);
check($r->hGet(Valkey::key('g:' . $h3 . ':Ticket:42'), 'update') === '0', 'grant rewritten, stale flags replaced');

$hidden = new Ticket();
$hidden->fields['id'] = 43;
$hidden->readable = false;
check(!Grants::write($hidden) && $r->exists(Valkey::key('g:' . $h3 . ':Ticket:43')) === 0, 'no grant without READ');

$pc = new Computer();
$pc->fields['id'] = 1;
check(!Grants::write($pc), 'no grant for item types that are not enabled');

ob_start();
Grants::onPostItemForm(['item' => $t, 'options' => []]);
$html = ob_get_clean();
check(str_contains($html, 'data-glpi-realtime-room="Ticket:42"'), 'room marker printed in the form');
ob_start();
Grants::onPostItemForm(['item' => new Ticket(), 'options' => []]);
check(ob_get_clean() === '', 'nothing printed on the creation form');

// --- Anonymized support agents -----------------------------------------------------
$k = SessionToken::sessionKey($h3);
check($r->hGet($k, 'anon') === '' && $r->hGet($k, 'anon_view') === '0', 'no anonymization by default');
Entity::$anonymize = Entity::ANONYMIZE_USE_GENERIC;
SessionToken::ensure(9);
$anon = json_decode((string) $r->hGet($k, 'anon'), true);
check(($anon['name'] ?? '') === 'Helpdesk user' && $anon['avatar']['picture'] === '' && $anon['avatar']['initials'] === 'HE', 'technician: generic name, no picture');
Session::$interface = 'helpdesk';
SessionToken::ensure(9);
check($r->hGet($k, 'anon_view') === '1' && $r->hGet($k, 'anon') === '', 'self-service session: sees agents anonymized, is not anonymized itself');
Session::$interface = 'central';
Entity::$anonymize = Entity::ANONYMIZE_DISABLED;
SessionToken::ensure(9);

// --- Logout ------------------------------------------------------------------------
SessionToken::revoke();
check($r->exists(SessionToken::sessionKey($h3)) === 0 && SessionToken::currentHash() === null, 'logout revokes the token');

// --- valkey_socket: a socket path or host[:port] -----------------------------------
check(Valkey::target('/run/valkey/valkey.sock') === ['/run/valkey/valkey.sock', 0], 'unix socket');
check(Valkey::target('valkey:6380') === ['valkey', 6380] && Valkey::target('127.0.0.1') === ['127.0.0.1', 6379], 'host:port, default port');
check(Valkey::target('redis://valkey:6379') === ['valkey', 6379] && Valkey::target('[::1]:6390') === ['::1', 6390], 'URL scheme and IPv6');

// --- Valkey down: fail open ---------------------------------------------------------
Valkey::$override = null;
Config::$values = ['valkey_socket' => '/nonexistent/valkey.sock', 'valkey_timeout' => '0.05'];
Settings::reset();
Valkey::reset();
$start = microtime(true);
SessionToken::ensure(7);
Grants::write($t);
SessionToken::ensure(7);
$elapsed = microtime(true) - $start;
check(SessionToken::currentHash() === null, 'no token when Valkey is down');
check($elapsed < 0.5, sprintf('Valkey down costs %.0f ms for the whole request', $elapsed * 1000));
check(count(Toolbox::$logs) <= 1, 'failure logged at most once');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
