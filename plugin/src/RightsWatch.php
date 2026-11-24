<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonDBTM;
use Redis;

/**
 * Rights changed during a session: grants computed earlier must not outlive them.
 *
 * - A user gains or loses a profile or a group (Profile_User, Group_User), or a profile's
 *   rights change (Profile, ProfileRight): the grants of every session of the users
 *   concerned are deleted, and their open tabs are asked to get new ones from GLPI
 *   (`regrant`, for those sessions only).
 * - A user is deactivated, trashed or purged: their sessions are revoked (connections
 *   closed by the server).
 *
 * Index keys: `rt:us:{uid}` (sessions of a user, SessionToken) and `rt:gs:{hash}` (rooms a
 * session has grants on, Grants).
 */
final class RightsWatch
{
    public const CLASSES = ['Profile_User', 'Group_User', 'Profile', 'ProfileRight', 'User'];

    /** @var array<int, true> users whose grants must go */
    private static array $regrant = [];
    /** @var array<int, true> users whose sessions must go */
    private static array $revoke = [];

    /** @internal tests: profile id => users having it */
    public static ?\Closure $usersOfProfile = null;

    public static function record(CommonDBTM $item, string $action): void
    {
        $f = $item->fields;
        switch ($item::class) {
            case 'Profile_User':
            case 'Group_User':
                self::regrant([(int) ($f['users_id'] ?? 0)]);
                return;
            case 'ProfileRight':
                self::regrant(self::usersOf((int) ($f['profiles_id'] ?? 0)));
                return;
            case 'Profile':
                if ($action === 'update' || $action === 'purge') {
                    self::regrant(self::usersOf((int) ($f['id'] ?? 0)));
                }
                return;
            case 'User':
                $gone = in_array($action, ['delete', 'purge'], true)
                    || ($action === 'update' && in_array('is_active', $item->updates, true) && empty($f['is_active']));
                if ($gone && (int) ($f['id'] ?? 0) > 0) {
                    self::$revoke[(int) $f['id']] = true;
                    Events::ensureFlush();
                }
                return;
        }
    }

    /** @param list<int> $uids */
    private static function regrant(array $uids): void
    {
        foreach ($uids as $u) {
            if ($u > 0) {
                self::$regrant[$u] = true;
            }
        }
        if (self::$regrant !== []) {
            Events::ensureFlush();
        }
    }

    /** @return list<int> */
    private static function usersOf(int $profiles_id): array
    {
        if ($profiles_id <= 0) {
            return [];
        }
        if (self::$usersOfProfile !== null) {
            return (self::$usersOfProfile)($profiles_id);
        }
        global $DB;
        $out = [];
        foreach ($DB->request([
            'SELECT'   => 'users_id',
            'DISTINCT' => true,
            'FROM'     => 'glpi_profiles_users',
            'WHERE'    => ['profiles_id' => $profiles_id],
        ]) as $row) {
            $out[] = (int) $row['users_id'];
        }
        return $out;
    }

    /**
     * Applies what the request recorded. Returns the batches to publish: room => session
     * hashes that must regrant.
     *
     * @return array<string, list<string>>
     */
    public static function flush(Redis $r): array
    {
        $regrant = array_keys(self::$regrant);
        $revoke = array_keys(self::$revoke);
        self::$regrant = self::$revoke = [];

        foreach ($revoke as $uid) {
            $index = Valkey::key('us:' . $uid);
            $hashes = $r->sMembers($index) ?: [];
            foreach ($hashes as $h) {
                $r->del(SessionToken::sessionKey($h), Valkey::key('gs:' . $h));
            }
            $r->del($index);
        }

        $rooms = [];
        foreach ($regrant as $uid) {
            foreach ($r->sMembers(Valkey::key('us:' . $uid)) ?: [] as $h) {
                foreach (Grants::revokeSession($r, $h) as $room) {
                    $rooms[$room][] = $h;
                }
            }
        }
        return $rooms;
    }

    /** @internal tests */
    public static function pending(): array
    {
        return ['regrant' => array_keys(self::$regrant), 'revoke' => array_keys(self::$revoke)];
    }
}
