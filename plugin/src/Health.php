<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use Redis;
use Throwable;

/**
 * Checks shown on the plugin's configuration page: is everything the real-time layer needs
 * available, and if not, what to do. GLPI side, Valkey (with the plugin's own settings, on a
 * dedicated connection with a 1 s timeout: the plugin's usual one fails open in 50 ms and
 * hides errors), and the server instances through the status they publish in Valkey
 * (`rt:srv:*`, see server/src/status.rs). The browser checks the web server (`/ws`) itself.
 */
final class Health
{
    public const OK = 'ok';
    public const WARNING = 'warning';
    public const ERROR = 'error';
    public const INFO = 'info';

    /** Oldest Valkey and Redis versions with hash field TTLs (HEXPIRE). */
    private const MIN_VALKEY = '9.0.0';
    private const MIN_REDIS = '7.4.0';

    /** @internal tests: GLPI's URL, the plugin's version, and checks needing GLPI's database. */
    public static ?string $urlBase = null;
    /** @internal tests: scheme://host[:port] of the current request. */
    public static ?string $requestOrigin = null;
    public static ?string $version = null;
    public static bool $skipDatabase = false;

    /**
     * @return list<array{group: string, id: string, label: string, status: string, detail: string, fix: string}>
     */
    public static function run(): array
    {
        $out = [];
        $add = static function (string $group, array $check) use (&$out) {
            $out[] = ['group' => $group] + $check + ['detail' => '', 'fix' => ''];
        };

        // --- GLPI -------------------------------------------------------------------
        $add('glpi', self::phpRedis());
        $add('glpi', self::https());
        $add('glpi', self::urlSetting());
        if (!self::$skipDatabase) {
            $add('glpi', self::tables());
            $add('glpi', self::cron());
        }
        $add('glpi', self::bundle());
        $add('glpi', self::opcache());

        // --- Valkey -----------------------------------------------------------------
        [$r, $check] = self::connect();
        $add('valkey', $check);
        if ($r !== null) {
            $add('valkey', self::version($r));
            $add('valkey', self::permissions($r));
            $add('glpi', self::sessionToken($r));
            // --- Server -------------------------------------------------------------
            foreach (self::servers($r) as $check) {
                $add('server', $check);
            }
            if ($r !== Valkey::$override) {
                $r->close(); // ours only (tests pass their client)
            }
        }
        return $out;
    }

    private static function check(string $id, string $label, string $status, string $detail = '', string $fix = ''): array
    {
        return compact('id', 'label', 'status', 'detail', 'fix');
    }

    // ------------------------------------------------------------------ GLPI

    private static function phpRedis(): array
    {
        $label = __('PHP redis extension', 'realtime');
        if (extension_loaded('redis')) {
            return self::check('php_redis', $label, self::OK, sprintf(__('Version %s, for %s.', 'realtime'), phpversion('redis'), PHP_SAPI));
        }
        return self::check(
            'php_redis',
            $label,
            self::ERROR,
            sprintf(__('Not loaded by the PHP that runs GLPI (%s).', 'realtime'), PHP_SAPI),
            __('Install the "redis" extension (phpredis) for this PHP (Debian/Ubuntu: php-redis, Arch: php-redis or php-legacy-redis, RHEL: php-pecl-redis), enable it, and restart PHP (PHP-FPM, uWSGI or Apache).', 'realtime')
        );
    }

    private static function urlBase(): string
    {
        global $CFG_GLPI;
        return rtrim((string) (self::$urlBase ?? $CFG_GLPI['url_base'] ?? ''), '/');
    }

    /** scheme://host[:port] of GLPI's URL, as browsers send it in `Origin`. */
    public static function origin(string $url): string
    {
        $p = parse_url($url);
        if (!is_array($p) || empty($p['scheme']) || empty($p['host'])) {
            return '';
        }
        return strtolower($p['scheme']) . '://' . strtolower($p['host']) . (isset($p['port']) ? ':' . $p['port'] : '');
    }

    /**
     * What browsers really use: the origin of this request (behind a proxy too), which is
     * what they send in `Origin` when they open the WebSocket.
     */
    public static function requestOrigin(): string
    {
        if (self::$requestOrigin !== null) {
            return self::$requestOrigin;
        }
        $https = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off')
            || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https'
            || strtolower((string) ($_SERVER['REQUEST_SCHEME'] ?? '')) === 'https'
            || (string) ($_SERVER['SERVER_PORT'] ?? '') === '443';
        $host = (string) ($_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? '');
        return $host === '' ? '' : self::origin(($https ? 'https' : 'http') . '://' . explode(',', $host)[0]);
    }

    private static function https(): array
    {
        $label = __('HTTPS', 'realtime');
        $origin = self::requestOrigin();
        if (str_starts_with($origin, 'https://')) {
            return self::check('https', $label, self::OK, $origin);
        }
        return self::check(
            'https',
            $label,
            self::ERROR,
            sprintf(__('This page is served over %s: the WebSocket cookie is "Secure" and browsers only send it over HTTPS.', 'realtime'), $origin),
            __('Serve GLPI over HTTPS (and set its URL in Setup > General > General setup, "URL of the application").', 'realtime')
        );
    }

    /** GLPI's URL setting (links in notifications) should be the address people use. */
    private static function urlSetting(): array
    {
        $label = __('GLPI\'s URL', 'realtime');
        $url = self::urlBase();
        $origin = self::requestOrigin();
        if ($origin === '' || self::origin($url) === $origin) {
            return self::check('url_base', $label, self::OK, $url);
        }
        return self::check(
            'url_base',
            $label,
            self::WARNING,
            sprintf(__('GLPI\'s URL is "%s" while this page is used at %s: links in GLPI\'s notifications point there, and the real-time server would refuse browsers coming from it.', 'realtime'), $url, $origin),
            sprintf(__('Set "%s" in Setup > General > General setup ("URL of the application").', 'realtime'), $origin)
        );
    }

    private static function tables(): array
    {
        global $DB;
        $label = __('Plugin tables', 'realtime');
        $missing = array_values(array_filter([Inbox::TABLE, Inbox::PREFS_TABLE], static fn($t) => !$DB->tableExists($t)));
        if ($missing === []) {
            return self::check('tables', $label, self::OK);
        }
        return self::check(
            'tables',
            $label,
            self::ERROR,
            sprintf(__('Missing: %s.', 'realtime'), implode(', ', $missing)),
            __('Run the plugin upgrade: deploy/install.sh, or bin/console plugin:install --force realtime then bin/console plugin:activate realtime (as the user running GLPI).', 'realtime')
        );
    }

    private static function cron(): array
    {
        $label = __('Notification purge task', 'realtime');
        $task = new \CronTask();
        if (!$task->getFromDBbyName(Inbox::class, 'inboxpurge')) {
            return self::check('cron', $label, self::WARNING, __('The task is not registered.', 'realtime'), __('Run the plugin upgrade (deploy/install.sh) to register it.', 'realtime'));
        }
        if ((int) $task->fields['state'] === \CronTask::STATE_DISABLE) {
            return self::check('cron', $label, self::WARNING, __('The task is disabled: read notifications are never purged.', 'realtime'), __('Enable it in Setup > Automatic actions ("inboxpurge").', 'realtime'));
        }
        $last = (string) ($task->fields['lastrun'] ?? '');
        if ($last === '' || strtotime($last) < time() - 3 * DAY_TIMESTAMP) {
            return self::check(
                'cron',
                $label,
                self::WARNING,
                $last === '' ? __('Never run.', 'realtime') : sprintf(__('Last run: %s.', 'realtime'), $last),
                __('GLPI\'s automatic actions do not seem to run: add a system cron job running "php bin/console glpi:cron" every minute as the user running GLPI (see GLPI\'s documentation).', 'realtime')
            );
        }
        return self::check('cron', $label, self::OK, sprintf(__('Last run: %s.', 'realtime'), $last));
    }

    private static function bundle(): array
    {
        $label = __('Browser client', 'realtime');
        $file = dirname(__DIR__) . '/public/realtime.js';
        if (is_file($file) && filesize($file) > 0) {
            return self::check('bundle', $label, self::OK, sprintf(__('%d KiB, built %s.', 'realtime'), (int) round(filesize($file) / 1024), date('Y-m-d H:i', (int) filemtime($file))));
        }
        return self::check('bundle', $label, self::ERROR, __('public/realtime.js is missing.', 'realtime'), __('Build it (cd client && npm ci && npm run build) and run deploy/install.sh, or install a release archive.', 'realtime'));
    }

    private static function opcache(): array
    {
        $label = __('PHP opcache and upgrades', 'realtime');
        if (!function_exists('opcache_get_status') || !ini_get('opcache.enable')) {
            return self::check('opcache', $label, self::OK, __('opcache is off.', 'realtime'));
        }
        if (!ini_get('opcache.validate_timestamps')) {
            return self::check('opcache', $label, self::WARNING, __('opcache never revalidates files: after an upgrade, PHP keeps serving the old plugin files.', 'realtime'), __('Reload PHP after every upgrade: deploy/install.sh with RELOAD_PHP (e.g. "systemctl reload php-fpm").', 'realtime'));
        }
        $freq = (int) ini_get('opcache.revalidate_freq');
        return self::check('opcache', $label, self::INFO, sprintf(__('Files are revalidated every %d s.', 'realtime'), $freq), $freq > 2 ? __('When upgrading, pass RELOAD_PHP to deploy/install.sh (otherwise it waits for opcache).', 'realtime') : '');
    }

    private static function sessionToken(Redis $r): array
    {
        $label = __('Your WebSocket session', 'realtime');
        $hash = SessionToken::currentHash();
        if ($hash === null) {
            return self::check('session', $label, self::WARNING, __('No token was issued for your GLPI session (Valkey was probably unavailable when you logged in).', 'realtime'), __('Once the Valkey checks pass, log out and in again.', 'realtime'));
        }
        if ((int) $r->exists(SessionToken::sessionKey($hash)) === 0) {
            return self::check('session', $label, self::WARNING, __('Your token is not in Valkey any more (Valkey restarted, or another database/prefix).', 'realtime'), __('Reload the page: a new token is issued. If it keeps happening, check valkey_db and key_prefix.', 'realtime'));
        }
        return self::check('session', $label, self::OK);
    }

    // ------------------------------------------------------------------ Valkey

    /** @return array{0: ?Redis, 1: array} */
    private static function connect(): array
    {
        $label = __('Valkey connection', 'realtime');
        $target = Settings::get('valkey_socket');
        $user = (string) (function_exists('posix_geteuid') && function_exists('posix_getpwuid') ? (posix_getpwuid(posix_geteuid())['name'] ?? '?') : '?');
        if (!extension_loaded('redis')) {
            return [null, self::check('valkey', $label, self::ERROR, __('Cannot try without the PHP redis extension.', 'realtime'))];
        }
        try {
            $r = Valkey::$override ?? new Redis();
            if (Valkey::$override === null) {
                if (str_starts_with($target, '/')) {
                    if (!file_exists($target)) {
                        return [null, self::check('valkey', $label, self::ERROR, sprintf(__('No socket at %s.', 'realtime'), $target), __('Check that Valkey runs and that its "unixsocket" (valkey.conf) is the plugin setting valkey_socket (bin/console glpi:config:set --context=plugin:realtime valkey_socket ...).', 'realtime'))];
                    }
                    $r->connect($target, 0, 1.0);
                } else {
                    [$host, $port] = array_pad(explode(':', $target, 2), 2, '6379');
                    $r->connect($host, (int) $port, 1.0);
                }
            }
            $password = Settings::valkeyPassword();
            if ($password !== '') {
                $name = Settings::get('valkey_username');
                if (!$r->auth($name !== '' ? [$name, $password] : $password)) {
                    return [null, self::check('valkey', $label, self::ERROR, __('Valkey refused the user name or password.', 'realtime'), __('Check valkey_username and valkey_password (bin/console glpi:config:set --context=plugin:realtime valkey_password ...) against the ACL user of valkey.conf.', 'realtime'))];
                }
            }
            $r->ping();
            $r->select((int) Settings::get('valkey_db'));
        } catch (Throwable $e) {
            $msg = $e->getMessage();
            $fix = match (true) {
                stripos($msg, 'permission denied') !== false => sprintf(__('The user running PHP (%s) cannot open Valkey\'s socket: add it to the socket\'s group (valkey or redis, see "unixsocketperm" in valkey.conf) and restart PHP.', 'realtime'), $user),
                stripos($msg, 'NOAUTH') !== false => __('Valkey requires a password: set valkey_username and valkey_password (bin/console glpi:config:set --context=plugin:realtime valkey_password ...).', 'realtime'),
                stripos($msg, 'WRONGPASS') !== false => __('Wrong user name or password: check valkey_username and valkey_password against valkey.conf.', 'realtime'),
                default => __('Check that Valkey runs, and the plugin settings valkey_socket and valkey_db.', 'realtime'),
            };
            return [null, self::check('valkey', $label, self::ERROR, sprintf(__('%s (as %s): %s', 'realtime'), $target, $user, $msg), $fix)];
        }
        return [$r, self::check('valkey', $label, self::OK, sprintf(__('%s, database %d.', 'realtime'), $target, (int) Settings::get('valkey_db')))];
    }

    /** @param array<string, string> $info INFO server */
    public static function versionOk(array $info): array
    {
        if (isset($info['valkey_version'])) {
            return ['Valkey', $info['valkey_version'], version_compare($info['valkey_version'], self::MIN_VALKEY, '>=')];
        }
        $v = (string) ($info['redis_version'] ?? '0');
        return ['Redis', $v, version_compare($v, self::MIN_REDIS, '>=')];
    }

    private static function version(Redis $r): array
    {
        $label = __('Valkey version', 'realtime');
        try {
            [$name, $v, $ok] = self::versionOk((array) $r->info('server'));
        } catch (Throwable $e) {
            return self::check('valkey_version', $label, self::WARNING, $e->getMessage());
        }
        if ($ok) {
            return self::check('valkey_version', $label, self::OK, "$name $v");
        }
        return self::check(
            'valkey_version',
            $label,
            self::ERROR,
            sprintf(__('%s %s does not expire hash fields (presence needs HEXPIRE).', 'realtime'), $name, $v),
            sprintf(__('Upgrade to Valkey %s or later (or Redis %s or later).', 'realtime'), self::MIN_VALKEY, self::MIN_REDIS)
        );
    }

    /** What the plugin does with Valkey, on a probe key: write, read, index, publish, delete. */
    private static function permissions(Redis $r): array
    {
        $label = __('Valkey permissions', 'realtime');
        $key = Valkey::key('check:' . bin2hex(random_bytes(6)));
        try {
            foreach ([
                'HSET'    => fn() => $r->hSet($key, 'probe', '1'),
                'EXPIRE'  => fn() => $r->expire($key, 60),
                'HGETALL' => fn() => $r->hGetAll($key),
                'SADD'    => fn() => $r->sAdd($key . ':s', 'x'),
                'PUBLISH' => fn() => $r->publish(Valkey::key('check'), '{}'),
                'DEL'     => fn() => $r->del($key, $key . ':s'),
            ] as $cmd => $call) {
                if ($call() === false) {
                    throw new \RuntimeException("$cmd: " . ($r->getLastError() ?? 'refused'));
                }
            }
        } catch (Throwable $e) {
            return self::check(
                'valkey_acl',
                $label,
                self::ERROR,
                $e->getMessage(),
                sprintf(__('Valkey\'s ACL must allow the plugin\'s user the keys and channels "%s*" (see deploy/examples/valkey.conf.example).', 'realtime'), Settings::get('key_prefix'))
            );
        }
        return self::check('valkey_acl', $label, self::OK, __('Read, write, publish and delete allowed.', 'realtime'));
    }

    // ------------------------------------------------------------------ server

    /** @return list<array<string, mixed>> statuses published by the running instances */
    public static function statuses(Redis $r): array
    {
        $out = [];
        $it = null;
        $r->setOption(Redis::OPT_SCAN, Redis::SCAN_RETRY);
        while (($keys = $r->scan($it, Valkey::key('srv:*'), 100)) !== false) {
            foreach ($keys as $k) {
                $s = json_decode((string) $r->get($k), true);
                if (is_array($s)) {
                    $out[] = $s;
                }
            }
        }
        usort($out, static fn($a, $b) => strcmp((string) ($a['instance'] ?? ''), (string) ($b['instance'] ?? '')));
        return $out;
    }

    /** @return list<array> */
    public static function servers(Redis $r): array
    {
        $label = __('glpi-realtime server', 'realtime');
        try {
            $statuses = self::statuses($r);
        } catch (Throwable $e) {
            return [self::check('server', $label, self::ERROR, $e->getMessage())];
        }
        if ($statuses === []) {
            return [self::check(
                'server',
                $label,
                self::ERROR,
                __('No server instance reports to this Valkey database.', 'realtime'),
                sprintf(
                    __('Start it (systemctl start glpi-realtime; journalctl -u glpi-realtime shows why it stopped). Its config.toml must use the same Valkey as GLPI: [valkey] url, db = %d, key_prefix = "%s".', 'realtime'),
                    (int) Settings::get('valkey_db'),
                    Settings::get('key_prefix')
                )
            )];
        }

        $out = [];
        $count = count($statuses);
        $conns = array_sum(array_map(static fn($s) => (int) ($s['connections'] ?? 0), $statuses));
        $out[] = self::check('server', $label, self::OK, sprintf(__('Instances: %d, connections: %d.', 'realtime'), $count, $conns));

        $plugin = self::$version ?? (defined('PLUGIN_REALTIME_VERSION') ? PLUGIN_REALTIME_VERSION : '');
        $versions = array_values(array_unique(array_map(static fn($s) => (string) ($s['version'] ?? '?'), $statuses)));
        $out[] = $versions === [$plugin]
            ? self::check('server_version', __('Server version', 'realtime'), self::OK, $plugin)
            : self::check(
                'server_version',
                __('Server version', 'realtime'),
                self::WARNING,
                sprintf(__('Plugin %s, server %s.', 'realtime'), $plugin, implode(', ', $versions)),
                __('Install the same version of both: deploy/install.sh installs the binary and the plugin together.', 'realtime')
            );

        $cookie = Settings::get('cookie_name');
        $bad = array_values(array_filter($statuses, static fn($s) => ($s['cookie_name'] ?? '') !== $cookie));
        $out[] = $bad === []
            ? self::check('cookie', __('Session cookie name', 'realtime'), self::OK, $cookie)
            : self::check(
                'cookie',
                __('Session cookie name', 'realtime'),
                self::ERROR,
                sprintf(__('The plugin sets "%s", the server reads "%s": every connection is refused (401).', 'realtime'), $cookie, (string) $bad[0]['cookie_name']),
                __('Use the same name: [security] cookie_name in config.toml, plugin setting cookie_name.', 'realtime')
            );

        // The address browsers use (this request), else GLPI's URL setting.
        $origin = self::requestOrigin() ?: self::origin(self::urlBase());
        $bad = array_values(array_filter($statuses, static function ($s) use ($origin) {
            $allowed = array_map(static fn($o) => strtolower(rtrim((string) $o, '/')), (array) ($s['allowed_origins'] ?? []));
            return !in_array($origin, $allowed, true);
        }));
        $out[] = $bad === []
            ? self::check('origin', __('Allowed origin', 'realtime'), self::OK, $origin)
            : self::check(
                'origin',
                __('Allowed origin', 'realtime'),
                self::ERROR,
                sprintf(__('Browsers open the WebSocket from %s, the server only accepts %s: every connection is refused (403).', 'realtime'), $origin, implode(', ', (array) ($bad[0]['allowed_origins'] ?? [])) ?: '—'),
                sprintf(__('Add "%s" to [security] allowed_origins in config.toml, then restart the server.', 'realtime'), $origin)
            );

        $enabled = Settings::enabledItemtypes();
        $missing = [];
        foreach ($statuses as $s) {
            $missing = [...$missing, ...array_diff($enabled, (array) ($s['allowed_itemtypes'] ?? []))];
        }
        $missing = array_values(array_unique($missing));
        $out[] = $missing === []
            ? self::check('itemtypes', __('Item types', 'realtime'), self::OK, implode(', ', $enabled))
            : self::check(
                'itemtypes',
                __('Item types', 'realtime'),
                self::WARNING,
                sprintf(__('Enabled in GLPI but refused by the server: %s.', 'realtime'), implode(', ', $missing)),
                sprintf(__('Add them to [security] allowed_itemtypes in config.toml (%s), then restart the server.', 'realtime'), '"' . implode('", "', $missing) . '"')
            );

        $s = $statuses[0];
        if (empty($s['keyspace_events'])) {
            $out[] = self::check('keyspace', __('Instant logout', 'realtime'), self::INFO, __('Off ([revocation] keyspace_events = false): a closed GLPI session is noticed within 15 s.', 'realtime'), __('For instant revocation: notify-keyspace-events Kgx in valkey.conf, and keyspace_events = true in config.toml.', 'realtime'));
        } elseif (($s['keyspace_config'] ?? '') === 'ok') {
            $out[] = self::check('keyspace', __('Instant logout', 'realtime'), self::OK, __('Keyspace notifications are on.', 'realtime'));
        } elseif (str_starts_with((string) ($s['keyspace_config'] ?? ''), 'missing')) {
            $out[] = self::check('keyspace', __('Instant logout', 'realtime'), self::WARNING, sprintf(__('Valkey\'s notify-keyspace-events is %s: logouts are only noticed within 15 s.', 'realtime'), substr((string) $s['keyspace_config'], 8)), __('Set "notify-keyspace-events Kgx" in valkey.conf (or CONFIG SET notify-keyspace-events Kgx) and restart Valkey.', 'realtime'));
        } else {
            $out[] = self::check('keyspace', __('Instant logout', 'realtime'), self::INFO, __('Cannot be verified: Valkey refuses CONFIG GET to the server (ACL). Make sure notify-keyspace-events contains K, g and x.', 'realtime'));
        }
        return $out;
    }
}
