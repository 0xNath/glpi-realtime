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
        'key_prefix'         => 'rt:',
        'cookie_name'        => 'glpi_rt',
        'ws_path'            => '/ws',
        // Valkey timeout for every plugin call, in seconds: GLPI must never wait on us.
        'valkey_timeout'     => '0.05',
        'enabled_itemtypes'  => '["Ticket"]',
    ];

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

    /** @return list<string> */
    public static function enabledItemtypes(): array
    {
        $list = json_decode(self::get('enabled_itemtypes'), true);
        return is_array($list) ? array_values(array_filter($list, 'is_string')) : ['Ticket'];
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
