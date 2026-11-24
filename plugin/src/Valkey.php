<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use Redis;
use Throwable;

/**
 * Fail-open access to Valkey.
 *
 * - Dedicated persistent connection (own persistent id): never shares the connection
 *   GLPI uses for its cache, so SELECT cannot interfere with it.
 * - 50 ms timeouts; after one failure, Valkey is skipped for the rest of the request.
 * - Errors are logged at most once per minute.
 */
final class Valkey
{
    private static ?Redis $client = null;
    private static bool $down = false;

    /** @internal tests */
    public static ?Redis $override = null;

    public static function client(): ?Redis
    {
        if (self::$override !== null) {
            return self::$override;
        }
        if (self::$down) {
            return null;
        }
        if (self::$client !== null) {
            return self::$client;
        }
        try {
            $timeout = (float) Settings::get('valkey_timeout');
            $r = new Redis();
            $r->pconnect(Settings::get('valkey_socket'), 0, $timeout, 'glpi-realtime');
            $r->setOption(Redis::OPT_READ_TIMEOUT, $timeout);
            $r->select((int) Settings::get('valkey_db'));
            return self::$client = $r;
        } catch (Throwable $e) {
            self::fail($e);
            return null;
        }
    }

    /**
     * Runs $fn with the client; returns $fallback when Valkey is unavailable.
     *
     * @template T
     * @param callable(Redis): T $fn
     * @param T $fallback
     * @return T
     */
    public static function run(callable $fn, mixed $fallback = null): mixed
    {
        $r = self::client();
        if ($r === null) {
            return $fallback;
        }
        try {
            return $fn($r);
        } catch (Throwable $e) {
            self::fail($e);
            return $fallback;
        }
    }

    public static function key(string $suffix): string
    {
        return Settings::get('key_prefix') . $suffix;
    }

    private static function fail(Throwable $e): void
    {
        self::$down = true;
        self::$client = null;
        $throttled = function_exists('apcu_add') && !apcu_add('plugin_realtime_valkey_error', 1, 60);
        if (!$throttled) {
            \Toolbox::logInFile('realtime', 'Valkey unavailable, real-time features disabled for this request: ' . $e->getMessage() . "\n");
        }
    }

    /** @internal tests */
    public static function reset(): void
    {
        self::$client = null;
        self::$down = false;
    }
}
