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
     * @internal tests: HTTP client of the command line checks,
     * fn(string $url, array<string, string> $headers): array{0: int, 1: string} (status, body).
     */
    public static ?\Closure $http = null;

    /** What the checks do not explain, in detail. */
    public const TROUBLESHOOTING = 'https://github.com/0xNath/glpi-realtime/blob/master/docs/troubleshooting.md';

    /** Groups of checks: those of the command line add the web server. */
    public const GROUPS = ['glpi', 'valkey', 'server', 'web'];

    /**
     * @return list<array{group: string, id: string, label: string, status: string, detail: string, fix: string}>
     */
    public static function run(bool $cli = false): array
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
        if (!$cli) {
            $add('glpi', self::opcache()); // the command line's PHP is not the web server's
        }

        // --- Valkey -----------------------------------------------------------------
        [$r, $check] = self::connect();
        $add('valkey', $check);
        if ($r !== null) {
            $add('valkey', self::version($r));
            $add('valkey', self::permissions($r));
            if (!$cli) {
                $add('glpi', self::sessionToken($r)); // no GLPI session on the command line
            }
            // --- Server -------------------------------------------------------------
            foreach (self::servers($r) as $check) {
                $add('server', $check);
            }
            if ($r !== Valkey::$override) {
                $r->close(); // ours only (tests pass their client)
            }
        }
        // --- Web server: what the browser checks on the configuration page -------------
        if ($cli) {
            foreach (self::webServer() as $check) {
                $add('web', $check);
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

    /** The address browsers use: this request's, else (command line) GLPI's URL setting. */
    public static function browserOrigin(): string
    {
        return self::requestOrigin() ?: self::origin(self::urlBase());
    }

    private static function https(): array
    {
        $label = __('HTTPS', 'realtime');
        $origin = self::browserOrigin();
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
                __('GLPI\'s automatic actions do not seem to run: add a system cron job running "php front/cron.php" (in GLPI\'s directory) every minute as the user running GLPI (see GLPI\'s documentation).', 'realtime')
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
                [$host, $port] = Valkey::target($target);
                if ($port === 0) {
                    if (!file_exists($target)) {
                        return [null, self::check('valkey', $label, self::ERROR, sprintf(__('No socket at %s.', 'realtime'), $target), __('Check that Valkey runs and that its "unixsocket" (valkey.conf) is the plugin setting valkey_socket (bin/console config:set --context=plugin:realtime valkey_socket ...).', 'realtime'))];
                    }
                }
                $r->connect($host, $port, 1.0);
            }
            $password = Settings::valkeyPassword();
            if ($password !== '') {
                $name = Settings::get('valkey_username');
                if (!$r->auth($name !== '' ? [$name, $password] : $password)) {
                    return [null, self::check('valkey', $label, self::ERROR, __('Valkey refused the user name or password.', 'realtime'), __('Check valkey_username and valkey_password (bin/console config:set --context=plugin:realtime valkey_password ...) against the ACL user of valkey.conf.', 'realtime'))];
                }
            }
            $r->ping();
            $r->select((int) Settings::get('valkey_db'));
        } catch (Throwable $e) {
            $msg = $e->getMessage();
            $fix = match (true) {
                stripos($msg, 'permission denied') !== false => sprintf(__('The user running PHP (%s) cannot open Valkey\'s socket: add it to the socket\'s group (valkey or redis, see "unixsocketperm" in valkey.conf) and restart PHP.', 'realtime'), $user),
                stripos($msg, 'NOAUTH') !== false => __('Valkey requires a password: set valkey_username and valkey_password (bin/console config:set --context=plugin:realtime valkey_password ...).', 'realtime'),
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

        $origin = self::browserOrigin();
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
        // Types of the default list this install does not have (upgrades keep their list).
        $available = array_values(array_diff(json_decode(Settings::DEFAULTS['enabled_itemtypes'], true), $enabled));
        $all = json_encode([...$enabled, ...$available]);
        $out[] = $missing === [] && $available !== []
            ? self::check(
                'itemtypes',
                __('Item types', 'realtime'),
                self::INFO,
                sprintf(__('Enabled: %s. Also available (presence and a single editor of their form): %s.', 'realtime'), implode(', ', $enabled), implode(', ', $available)),
                sprintf(
                    __('To enable them, on both sides: bin/console config:set --context=plugin:realtime enabled_itemtypes \'%s\' (as the user running GLPI), and allowed_itemtypes = %s in [security] of config.toml, then restart the server.', 'realtime'),
                    $all,
                    '["' . implode('", "', [...$enabled, ...$available]) . '"]'
                )
            )
            : ($missing === []
            ? self::check('itemtypes', __('Item types', 'realtime'), self::OK, implode(', ', $enabled))
            : self::check(
                'itemtypes',
                __('Item types', 'realtime'),
                self::WARNING,
                sprintf(__('Enabled in GLPI but refused by the server: %s.', 'realtime'), implode(', ', $missing)),
                sprintf(__('Add them to [security] allowed_itemtypes in config.toml (%s), then restart the server.', 'realtime'), '"' . implode('", "', $missing) . '"')
            ));

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
    // ------------------------------------------------------------------ web server

    /** @return array{0: int, 1: string} HTTP status (0: no answer) and body, or the error */
    private static function fetch(string $url, array $headers): array
    {
        if (self::$http !== null) {
            return (self::$http)($url, $headers);
        }
        if (!function_exists('curl_init')) {
            return [0, 'PHP curl extension missing'];
        }
        $ch = curl_init($url);
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "$k: $v";
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTP_VERSION   => CURL_HTTP_VERSION_1_1, // WebSocket upgrades are HTTP/1.1
            CURLOPT_HTTPHEADER     => $lines,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        return $body === false ? [0, $error] : [$status, (string) $body];
    }

    /**
     * The /ws location of the web server, from GLPI's URL: a plain request must reach the
     * server (which answers 400, not GLPI's 404), and a WebSocket upgrade without session
     * must get the server's 401 (upgrade passed, origin accepted), not its 403 (origin) nor
     * a 400 (upgrade headers lost by the proxy).
     *
     * @return list<array>
     */
    public static function webServer(): array
    {
        $origin = self::browserOrigin();
        $path = Settings::get('ws_path');
        $label = __('Web server forwards /ws', 'realtime');
        if ($origin === '') {
            return [self::check('ws_location', $label, self::ERROR, __('GLPI\'s URL is not set.', 'realtime'), __('Set it in Setup > General > General setup ("URL of the application").', 'realtime'))];
        }
        $url = $origin . $path;
        [$status, $body] = self::fetch($url, []);
        $glpiPage = stripos($body, '<html') !== false;
        if ($status === 0) {
            return [self::check('ws_location', $label, self::ERROR, sprintf(__('No answer from %s: %s', 'realtime'), $url, $body), __('Check that GLPI\'s URL can be reached from this machine (DNS, firewall, certificate).', 'realtime'))];
        }
        if ($status === 404 || (($status === 400 || $status === 426) && $glpiPage)) {
            return [self::check('ws_location', $label, self::ERROR, sprintf(__('%s is answered by GLPI itself (HTTP %d): the web server does not forward it.', 'realtime'), $url, $status), __('Add the /ws location to the GLPI vhost (README, "Web server": nginx location or Apache ProxyPass), then reload the web server.', 'realtime'))];
        }
        if ($status >= 502 && $status <= 504) {
            return [self::check('ws_location', $label, self::ERROR, sprintf(__('The web server cannot reach glpi-realtime (HTTP %s).', 'realtime'), $status), __('Start the server (systemctl status glpi-realtime). With a unix socket, the web server\'s user must be in the socket\'s group: [listen] group in config.toml, and the service\'s SupplementaryGroups.', 'realtime'))];
        }
        if ($status !== 400 && $status !== 426) {
            return [self::check('ws_location', $label, self::WARNING, sprintf(__('Unexpected answer from %s: HTTP %d.', 'realtime'), $url, $status))];
        }
        $out = [self::check('ws_location', $label, self::OK, sprintf(__('%s reaches glpi-realtime (HTTP %d).', 'realtime'), $url, $status))];

        $label = __('WebSocket upgrade', 'realtime');
        [$status, $body] = self::fetch($url, [
            'Connection'            => 'Upgrade',
            'Upgrade'               => 'websocket',
            'Sec-WebSocket-Version' => '13',
            'Sec-WebSocket-Key'     => base64_encode(random_bytes(16)),
            'Origin'                => $origin,
        ]);
        $out[] = match (true) {
            $status === 401 => self::check('ws_upgrade', $label, self::OK, __('The upgrade reaches the server, which accepts GLPI\'s origin (and asks for a session: expected here).', 'realtime')),
            $status === 403 => self::check('ws_upgrade', $label, self::ERROR, sprintf(__('The server refuses the origin %s.', 'realtime'), $origin), sprintf(__('Add "%s" to [security] allowed_origins in config.toml, then restart the server.', 'realtime'), $origin)),
            $status === 400 || $status === 426 => self::check('ws_upgrade', $label, self::ERROR, sprintf(__('The upgrade headers do not reach the server (HTTP %d: %s).', 'realtime'), $status, trim(substr($body, 0, 120))), __('nginx: proxy_http_version 1.1, proxy_set_header Upgrade $http_upgrade and Connection "upgrade"; Apache: upgrade=websocket on the ProxyPass (README, "Web server").', 'realtime')),
            $status === 429 => self::check('ws_upgrade', $label, self::WARNING, __('Rate-limited by the web server (HTTP 429): try again in a minute.', 'realtime')),
            default => self::check('ws_upgrade', $label, self::WARNING, sprintf(__('Unexpected answer: HTTP %d.', 'realtime'), $status)),
        };
        return $out;
    }
}
