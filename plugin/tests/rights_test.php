<?php

/**
 * Rights changed during a session: grants deleted, sessions revoked.
 * php -d extension=igbinary -d extension=redis plugin/tests/rights_test.php <valkey-port>
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Events;
use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\Inbox;
use GlpiPlugin\Realtime\RightsWatch;
use GlpiPlugin\Realtime\SessionToken;
use GlpiPlugin\Realtime\Valkey;

$r = test_valkey((string) ($argv[1] ?? '6379'));
$r->flushDB();
session_start();
Events::$autoFlush = false;
Inbox::$directory = new FakeDirectory();
Inbox::$writer = static function (): void {};
SessionToken::$cookieSink = static function (): void {};
User::$db = [7 => ['name' => 'alice', 'picture' => null]];
Session::$uid = 7;

SessionToken::ensure(7);
$h = SessionToken::currentHash();
check($r->sIsMember(Valkey::key('us:7'), $h) === true && $r->ttl(Valkey::key('us:7')) > 0, 'sessions indexed per user');
Grants::write(new Ticket(['id' => 5]));
Grants::write(new Ticket(['id' => 6]));
$rooms = $r->sMembers(Valkey::key('gs:' . $h));
sort($rooms);
check($rooms === ['Ticket:5', 'Ticket:6'], 'grants indexed per session');

// A profile given to the user: their grants go.
Events::onAdd(new Profile_User(['id' => 1, 'users_id' => 7, 'profiles_id' => 4]));
Events::flush();
check($r->exists(Valkey::key('g:' . $h . ':Ticket:5'), Valkey::key('g:' . $h . ':Ticket:6'), Valkey::key('gs:' . $h)) === 0, 'profile change: every grant of the user\'s sessions deleted');
check($r->sIsMember(Valkey::key('gi:Ticket:5'), $h) === false, 'and unindexed from the items');
check($r->exists(SessionToken::sessionKey($h)) === 1, 'the session itself stays');

// A profile's rights change: its users.
Grants::write(new Ticket(['id' => 5]));
RightsWatch::$usersOfProfile = static fn(int $p) => $p === 4 ? [7] : [];
Events::onUpdate(new ProfileRight(['id' => 9, 'profiles_id' => 4, 'name' => 'ticket'], ['rights']));
Events::flush();
check($r->exists(Valkey::key('g:' . $h . ':Ticket:5')) === 0, 'profile rights changed: grants of its users deleted');

// Deactivated: sessions revoked (the server closes the connections).
Events::onUpdate(new User(['id' => 7, 'is_active' => 0], ['is_active']));
Events::flush();
check($r->exists(SessionToken::sessionKey($h)) === 0 && $r->exists(Valkey::key('us:7')) === 0, 'user deactivated: sessions revoked');
Events::onUpdate(new User(['id' => 7, 'is_active' => 1, 'realname' => 'x'], ['realname']));
check(RightsWatch::pending()['revoke'] === [], 'other user updates: nothing');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
