<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use Config;

final class Settings
{
    public const CONTEXT = 'plugin:realtime';

    /** Must match the Rust server configuration (valkey.*, security.cookie_name). */
    public const DEFAULTS = [
        'valkey_socket'      => '/run/valkey/valkey.sock',
        'valkey_db'          => '6',
        // Valkey ACL user and password (empty: no AUTH). The password is stored encrypted
        // with GLPI's key (secured config): set it with
        //   bin/console config:set --context=plugin:realtime valkey_password '...'
        'valkey_username'    => '',
        'valkey_password'    => '',
        'key_prefix'         => 'rt:',
        'cookie_name'        => 'glpi_rt',
        'ws_path'            => '/ws',
        // Valkey timeout for every plugin call, in seconds: GLPI must never wait on us.
        'valkey_timeout'     => '0.05',
        // Items with presence and the single editor of their fields (any GLPI item with a
        // standard form, custom assets included); tickets, changes and problems also get
        // the live timeline, drafts and notifications. The server must allow the same
        // ([security] allowed_itemtypes). Upgrades keep the list an install already has.
        'enabled_itemtypes'  => '["Ticket","Change","Problem","Project","ProjectTask","Computer","Monitor","NetworkEquipment","Peripheral","Phone","Printer"]',
    ];

    /** Default of versions before 0.3.0, replaced on upgrade (changes and problems). */
    public const OLD_ITEMTYPES = '["Ticket"]';

    private static ?array $values = null;

    public static function get(string $name): string
    {
        if (self::$values === null) {
            $stored = [];
            try {
                $stored = Config::getConfigurationValues(self::CONTEXT, array_keys(self::DEFAULTS));
            } catch (\Throwable) {
                // Not installed yet: defaults.
            }
            self::$values = array_merge(self::DEFAULTS, array_filter($stored, static fn($v) => $v !== null && $v !== ''));
        }
        return (string) self::$values[$name];
    }

    /** Settings stored encrypted by GLPI (secured configs). */
    public const SECURED = ['valkey_password'];

    /** Valkey password, decrypted (GLPI encrypts secured configs but returns them as stored). */
    public static function valkeyPassword(): string
    {
        $raw = self::get('valkey_password');
        if ($raw === '') {
            return '';
        }
        try {
            return (string) (new \GLPIKey())->decrypt($raw);
        } catch (\Throwable) {
            return '';
        }
    }

    /** @return list<string> */
    public static function enabledItemtypes(): array
    {
        $list = json_decode(self::get('enabled_itemtypes'), true);
        if (!is_array($list)) {
            return ['Ticket', 'Change', 'Problem'];
        }
        // Classes that exist and are GLPI items (a misspelt or removed one is ignored).
        return array_values(array_filter($list, static fn($t) => is_string($t) && is_a($t, \CommonDBTM::class, true)));
    }

    /** Lifetime of the token: the PHP session lifetime, slid on each GLPI request. */
    public static function sessionTtl(): int
    {
        return max(300, (int) ini_get('session.gc_maxlifetime'));
    }

    /** @internal tests */
    public static function reset(): void
    {
        self::$values = null;
    }
}
