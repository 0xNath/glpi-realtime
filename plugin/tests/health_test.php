<?php

/**
 * Health checks of the configuration page, against a real Valkey.
 * php -d extension=igbinary -d extension=redis plugin/tests/health_test.php <valkey-port>
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Health;
use GlpiPlugin\Realtime\Valkey;

$r = test_valkey((string) ($argv[1] ?? '6379'));
$r->flushDB();
session_start();
Health::$skipDatabase = true;
Health::$urlBase = 'https://glpi.example.org/';
Health::$requestOrigin = 'https://glpi.example.org';
Health::$version = '0.4.0';

/** id => [status, detail] of a run. */
function results(): array
{
    $out = [];
    foreach (Health::run() as $c) {
        $out[$c['id']] = [$c['status'], $c['detail'], $c['fix']];
    }
    return $out;
}

check(Health::origin('https://GLPI.example.org/glpi/') === 'https://glpi.example.org', 'origin of GLPI\'s URL');
check(Health::origin('https://glpi.example.org:8443') === 'https://glpi.example.org:8443', 'origin keeps a port');
check(Health::versionOk(['valkey_version' => '9.2.0'])[2] === true && Health::versionOk(['valkey_version' => '8.1.1'])[2] === false, 'Valkey 9.0 needed');
check(Health::versionOk(['redis_version' => '7.4.2'])[2] === true && Health::versionOk(['redis_version' => '7.2.0'])[2] === false, 'or Redis 7.4');

$res = results();
check($res['php_redis'][0] === Health::OK && $res['https'][0] === Health::OK, 'PHP redis, HTTPS');
check($res['valkey'][0] === Health::OK && $res['valkey_acl'][0] === Health::OK, 'Valkey reachable, permissions');
check($r->keys('rt:check*') === [], 'the probe key is removed');
check($res['server'][0] === Health::ERROR && str_contains($res['server'][2], 'key_prefix'), 'no server: error, says how to start it and what must match');

// A misconfigured server.
$r->set(Valkey::key('srv:a'), json_encode([
    'version' => '0.3.0', 'instance' => 'a', 'connections' => 3, 'cookie_name' => 'other',
    'allowed_origins' => ['https://old.example.org'], 'allowed_itemtypes' => ['Ticket'],
    'keyspace_events' => true, 'keyspace_config' => 'missing (Ex)',
]));
$res = results();
check($res['server'][0] === Health::OK && str_contains($res['server'][1], '3'), 'one instance, its connections');
check($res['server_version'][0] === Health::WARNING, 'version mismatch: warning');
check($res['cookie'][0] === Health::ERROR && str_contains($res['cookie'][2], 'cookie_name'), 'cookie name mismatch: error');
check($res['origin'][0] === Health::ERROR && str_contains($res['origin'][2], 'https://glpi.example.org'), 'origin not allowed: says which one to add');
check($res['itemtypes'][0] === Health::WARNING && str_contains($res['itemtypes'][1], 'Change'), 'item types refused by the server');
check($res['keyspace'][0] === Health::WARNING && str_contains($res['keyspace'][2], 'Kgx'), 'keyspace notifications missing');

// A good one.
$r->set(Valkey::key('srv:a'), json_encode([
    'version' => '0.4.0', 'instance' => 'a', 'connections' => 0, 'cookie_name' => 'glpi_rt',
    'allowed_origins' => ['https://glpi.example.org/'], 'allowed_itemtypes' => GlpiPlugin\Realtime\Settings::enabledItemtypes(),
    'keyspace_events' => true, 'keyspace_config' => 'ok',
]));
$res = results();
$bad = array_filter($res, static fn($c, $id) => in_array($c[0], [Health::ERROR, Health::WARNING], true) && $id !== 'session', ARRAY_FILTER_USE_BOTH);
check($bad === [], 'everything right: no error nor warning (' . implode(', ', array_keys($bad)) . ')');

// GLPI's URL setting differs from the address people use (here: still the installer's).
Health::$urlBase = 'http://localhost';
$res = results();
check($res['https'][0] === Health::OK && $res['origin'][0] === Health::OK, 'what browsers use decides: HTTPS and origin are fine');
check($res['url_base'][0] === Health::WARNING && str_contains($res['url_base'][2], 'https://glpi.example.org'), 'the URL setting is a warning, with the value to set');
Health::$requestOrigin = 'http://glpi.example.org';
$res = results();
check($res['https'][0] === Health::ERROR, 'page served over plain HTTP: error');

// An install that kept its item types on upgrade: told what else is available, and how.
Health::$urlBase = 'https://glpi.example.org/';
Health::$requestOrigin = 'https://glpi.example.org';
Config::$values = ['enabled_itemtypes' => '["Ticket","Change","Problem"]'];
GlpiPlugin\Realtime\Settings::reset();
$res = results();
check($res['itemtypes'][0] === Health::INFO && str_contains($res['itemtypes'][1], 'Computer'), 'other item types available: info, naming them');
check(str_contains($res['itemtypes'][2], 'settings'), 'and where to enable them');

// A server that follows GLPI's list (no allowed_itemtypes): nothing to keep in sync.
$r->set(Valkey::key('srv:a'), json_encode(['allowed_itemtypes' => []] + json_decode((string) $r->get(Valkey::key('srv:a')), true)));
Config::$values = ['enabled_itemtypes' => '["Ticket","Glpi\\\\CustomAsset\\\\NoSuchAsset"]'];
GlpiPlugin\Realtime\Settings::reset();
$res = results();
check($res['itemtypes'][0] !== Health::WARNING, 'server following GLPI: no warning');
Config::$values = [];
GlpiPlugin\Realtime\Settings::reset();

// The tab's own WebSocket session (web only): no token, or a token Valkey lost.
unset($_SESSION['plugin_realtime']);
$res = results();
check($res['session'][0] === Health::WARNING && str_contains($res['session'][2], 'log out and in again'), 'no token for this GLPI session: warning, log in again');
$_SESSION['plugin_realtime'] = ['hash' => 'health-test'];
$res = results();
check($res['session'][0] === Health::WARNING && str_contains($res['session'][1], 'not in Valkey'), 'token lost by Valkey: warning, reload');
$r->set(GlpiPlugin\Realtime\SessionToken::sessionKey('health-test'), '{}');
check(results()['session'][0] === Health::OK, 'token in Valkey: ok');
$r->del(GlpiPlugin\Realtime\SessionToken::sessionKey('health-test'));
unset($_SESSION['plugin_realtime']);

// A Valkey too old for presence (no hash field expiry).
final class OldValkey extends Redis
{
    public function info(string ...$sections): Redis|array|false
    {
        return ['valkey_version' => '8.1.1'];
    }
}
$old = new OldValkey();
$old->connect('127.0.0.1', (int) ($argv[1] ?? 6379), 1.0);
$old->select(6);
Valkey::$override = $old;
$res = results();
check($res['valkey_version'][0] === Health::ERROR && str_contains($res['valkey_version'][1], 'HEXPIRE') && str_contains($res['valkey_version'][2], 'Valkey 9.0'), 'Valkey 8.1: error, which version is needed');
$old->close();
Valkey::$override = $r;

// Valkey unreachable: why, and nothing that needs it is checked.
Valkey::$override = null;
Config::$values = ['valkey_socket' => '/tmp/rt-health-no-such.sock'];
GlpiPlugin\Realtime\Settings::reset();
$res = results();
check($res['valkey'][0] === Health::ERROR && str_contains($res['valkey'][1], 'No socket at /tmp/rt-health-no-such.sock') && str_contains($res['valkey'][2], 'unixsocket'), 'no socket: error, where Valkey\'s socket must be');
check(!isset($res['valkey_version']) && !isset($res['valkey_acl']) && !isset($res['server']), 'nothing else checked without Valkey');
Config::$values = ['valkey_socket' => '127.0.0.1:1'];
GlpiPlugin\Realtime\Settings::reset();
$res = results();
check($res['valkey'][0] === Health::ERROR && str_contains($res['valkey'][1], '127.0.0.1:1') && str_contains($res['valkey'][2], 'Check that Valkey runs'), 'nothing listening: error, with the target and the reason');
Config::$values = [];
GlpiPlugin\Realtime\Settings::reset();
Valkey::$override = $r;

// Command line: no request, GLPI's URL is what browsers use; the web server is requested.
Health::$requestOrigin = '';
Health::$urlBase = 'https://glpi.example.org/';
$requests = [];
$answers = [];
Health::$http = static function (string $url, array $headers) use (&$requests, &$answers): array {
    $requests[] = [$url, $headers];
    return array_shift($answers) ?? [0, 'no answer'];
};
$cli = static function () {
    $out = [];
    foreach (Health::run(cli: true) as $c) {
        $out[$c['id']] = [$c['status'], $c['detail'], $c['fix'], $c['group']];
    }
    return $out;
};
$answers = [[400, 'Connection header did not include \'upgrade\''], [401, 'unauthorized']];
$res = $cli();
check(!isset($res['session']) && !isset($res['opcache']), 'command line: no session nor opcache check');
check($res['https'][0] === Health::OK && $res['origin'][0] === Health::OK, 'command line: GLPI\'s URL is the origin');
check($res['ws_location'][0] === Health::OK && $res['ws_upgrade'][0] === Health::OK && $res['ws_upgrade'][3] === 'web', 'web server forwards /ws and the upgrade');
check($requests[0][0] === 'https://glpi.example.org/ws' && ($requests[1][1]['Origin'] ?? '') === 'https://glpi.example.org' && ($requests[1][1]['Upgrade'] ?? '') === 'websocket', 'requests: /ws at GLPI\'s URL, then an upgrade with GLPI\'s origin');

$answers = [[404, '<html>GLPI</html>']];
$res = $cli();
check($res['ws_location'][0] === Health::ERROR && str_contains($res['ws_location'][2], 'location') && !isset($res['ws_upgrade']), 'no /ws location: error, upgrade not tried');
$answers = [[502, 'Bad Gateway']];
check($cli()['ws_location'][0] === Health::ERROR, 'server down behind the proxy: error');
$answers = [[0, 'Could not resolve host']];
check(str_contains($cli()['ws_location'][1], 'Could not resolve host'), 'no answer: the reason is shown');
$answers = [[400, 'Connection header did not include \'upgrade\''], [400, '`Upgrade` header did not include \'websocket\'']];
$res = $cli();
check($res['ws_upgrade'][0] === Health::ERROR && str_contains($res['ws_upgrade'][2], 'proxy_http_version'), 'upgrade headers lost by the proxy: error, how to pass them');
$answers = [[400, ''], [403, 'origin']];
$res = $cli();
check($res['ws_upgrade'][0] === Health::ERROR && str_contains($res['ws_upgrade'][2], 'allowed_origins'), 'origin refused: error');
Health::$http = null;

// The same through real HTTP requests (curl): a stand-in server (ws_router.php) that
// tells whether the upgrade headers and GLPI's origin arrived.
$sock = stream_socket_server('tcp://127.0.0.1:0');
$port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
fclose($sock);
$origin = "http://127.0.0.1:$port";
$srv = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/ws_router.php'],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    null,
    ['RT_ORIGIN' => $origin]
);
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
    usleep(100_000);
}
Health::$urlBase = "$origin/";
$res = $cli();
check($res['ws_location'][0] === Health::OK && str_contains($res['ws_location'][1], '(HTTP 400)'), 'real request: /ws reaches the server');
check($res['ws_upgrade'][0] === Health::OK, 'real request: the upgrade headers and the origin are sent');
proc_terminate($srv);
proc_close($srv);
$res = $cli();
check($res['ws_location'][0] === Health::ERROR && str_contains($res['ws_location'][1], "No answer from $origin/ws"), 'nothing listening: no answer, with curl\'s reason');
Health::$urlBase = 'https://glpi.example.org/';

// --- Database checks (plugin tables, purge task), with doubles of GLPI's $DB and CronTask.
if (!defined('DAY_TIMESTAMP')) {
    define('DAY_TIMESTAMP', 86400);
}
final class CronTask
{
    public const STATE_DISABLE = 0;
    public const STATE_WAITING = 1;
    public const MODE_INTERNAL = 1;
    public const MODE_EXTERNAL = 2;
    /** The purge task GLPI has, or null when it is not registered. */
    public static ?array $task = null;
    /** The alerts task (slaalert), or null. */
    public static ?array $sla = null;
    public array $fields = [];

    public function getFromDBbyName(string $itemtype, string $name): bool
    {
        $task = $itemtype !== \GlpiPlugin\Realtime\Inbox::class ? null : match ($name) {
            'inboxpurge' => self::$task,
            'slaalert'   => self::$sla,
            default      => null,
        };
        if ($task === null) {
            return false;
        }
        $this->fields = $task;
        return true;
    }
}
$GLOBALS['DB'] = new class () {
    /** @var list<string> */
    public array $tables = [];

    public function tableExists(string $t): bool
    {
        return in_array($t, $this->tables, true);
    }
};
Health::$skipDatabase = false;
$db = static function (): array {
    $out = [];
    foreach (Health::run(cli: true) as $c) {
        if (in_array($c['id'], ['tables', 'cron', 'cron_sla'], true)) {
            $out[$c['id']] = [$c['status'], $c['detail'], $c['fix']];
        }
    }
    return $out;
};
$answers = [[400, ''], [401, 'unauthorized']];
Health::$http = static function (string $url, array $headers) use (&$answers): array {
    return array_shift($answers) ?? [0, 'no answer'];
};

$DB->tables = [\GlpiPlugin\Realtime\Inbox::TABLE];
$res = $db();
check($res['tables'][0] === Health::ERROR && str_contains($res['tables'][1], \GlpiPlugin\Realtime\Inbox::PREFS_TABLE) && !str_contains($res['tables'][1], \GlpiPlugin\Realtime\Inbox::TABLE . ','), 'a missing table: error, named');
check(str_contains($res['tables'][2], 'plugin:install --force realtime'), 'a missing table: how to create it');
$DB->tables = [\GlpiPlugin\Realtime\Inbox::TABLE, \GlpiPlugin\Realtime\Inbox::PREFS_TABLE];
check($db()['tables'][0] === Health::OK, 'both tables: ok');

CronTask::$task = null;
$res = $db();
check($res['cron'][0] === Health::WARNING && str_contains($res['cron'][2], 'deploy/install.sh'), 'purge task not registered: warning, upgrade');
CronTask::$task = ['state' => CronTask::STATE_DISABLE, 'lastrun' => date('Y-m-d H:i:s')];
$res = $db();
check($res['cron'][0] === Health::WARNING && str_contains($res['cron'][1], 'disabled') && str_contains($res['cron'][2], 'inboxpurge'), 'purge task disabled: warning, where to enable it');
CronTask::$task = ['state' => CronTask::STATE_WAITING, 'lastrun' => null];
$res = $db();
check($res['cron'][0] === Health::WARNING && $res['cron'][1] === 'Never run.' && str_contains($res['cron'][2], 'front/cron.php'), 'purge task never run: warning, the system cron job');
CronTask::$task = ['state' => CronTask::STATE_WAITING, 'lastrun' => date('Y-m-d H:i:s', time() - 4 * DAY_TIMESTAMP)];
check($db()['cron'][0] === Health::WARNING, 'purge task last run 4 days ago: warning (GLPI\'s cron does not run)');
CronTask::$task = ['state' => CronTask::STATE_WAITING, 'lastrun' => date('Y-m-d H:i:s', time() - 3600)];
$res = $db();
check($res['cron'][0] === Health::OK && str_starts_with($res['cron'][1], 'Last run: '), 'purge task run an hour ago: ok');

// The alerts task, every 5 minutes: whether GLPI's cron runs often enough.
if (!defined('MINUTE_TIMESTAMP')) {
    define('MINUTE_TIMESTAMP', 60);
}
CronTask::$sla = null;
$res = $db();
check($res['cron_sla'][0] === Health::WARNING && str_contains($res['cron_sla'][2], 'deploy/install.sh'), 'alerts task not registered: warning, upgrade');
CronTask::$sla = ['state' => CronTask::STATE_DISABLE, 'lastrun' => null, 'mode' => CronTask::MODE_EXTERNAL];
$res = $db();
check($res['cron_sla'][0] === Health::INFO && str_contains($res['cron_sla'][2], 'slaalert'), 'alerts task disabled: info (a choice), how to enable it');
CronTask::$sla = ['state' => CronTask::STATE_WAITING, 'lastrun' => null, 'mode' => CronTask::MODE_EXTERNAL];
$res = $db();
check($res['cron_sla'][0] === Health::WARNING && str_contains($res['cron_sla'][1], 'mail collector') && str_contains($res['cron_sla'][2], 'front/cron.php'), 'never run: warning, what is missing, the system cron job');
CronTask::$sla = ['state' => CronTask::STATE_WAITING, 'lastrun' => date('Y-m-d H:i:s', time() - 40 * 60), 'mode' => CronTask::MODE_EXTERNAL];
$res = $db();
check($res['cron_sla'][0] === Health::WARNING && str_contains($res['cron_sla'][1], 'not often enough'), 'last run 40 min ago: warning, the cron does not run often enough');
CronTask::$sla = ['state' => CronTask::STATE_WAITING, 'lastrun' => date('Y-m-d H:i:s', time() - 120), 'mode' => CronTask::MODE_INTERNAL];
$res = $db();
check($res['cron_sla'][0] === Health::INFO && str_contains($res['cron_sla'][1], 'while someone browses'), 'run by GLPI\'s pages: info, set it to CLI');
CronTask::$sla = ['state' => CronTask::STATE_WAITING, 'lastrun' => date('Y-m-d H:i:s', time() - 120), 'mode' => CronTask::MODE_EXTERNAL];
$res = $db();
check($res['cron_sla'][0] === Health::OK, 'run 2 min ago from the command line: ok');

Health::$http = null;
Health::$skipDatabase = true;

// --- What browsers use behind a reverse proxy: the forwarded scheme and host.
$server = $_SERVER;
Health::$requestOrigin = null;
$origin = static function (array $headers): string {
    $_SERVER = $headers;
    return Health::requestOrigin();
};
check($origin(['HTTP_X_FORWARDED_PROTO' => 'https', 'HTTP_X_FORWARDED_HOST' => 'glpi.example.org, proxy.local', 'HTTP_HOST' => 'backend:8080']) === 'https://glpi.example.org', 'behind a proxy: its forwarded scheme and first forwarded host');
check($origin(['HTTP_HOST' => 'GLPI.Example.org', 'SERVER_PORT' => '443']) === 'https://glpi.example.org', 'port 443: https, host lowercased');
check($origin(['HTTP_HOST' => 'glpi.example.org:8080']) === 'http://glpi.example.org:8080', 'plain HTTP keeps the port');
check($origin(['HTTPS' => 'off', 'HTTP_HOST' => 'glpi.example.org']) === 'http://glpi.example.org', 'HTTPS=off is plain HTTP');
check($origin([]) === '', 'no host (command line): none');
Health::$urlBase = 'https://glpi.example.org/';
check(Health::browserOrigin() === 'https://glpi.example.org', 'then GLPI\'s URL setting');
$_SERVER = $server;
Health::$requestOrigin = 'https://glpi.example.org';

// --- Instant logout off, or not verifiable (Valkey refuses CONFIG GET to the server).
$status = json_decode((string) $r->get(Valkey::key('srv:a')), true);
$r->set(Valkey::key('srv:a'), json_encode(['keyspace_events' => false] + $status));
$res = results();
check($res['keyspace'][0] === Health::INFO && str_contains($res['keyspace'][1], 'keyspace_events = false'), 'keyspace events off: info');
$r->set(Valkey::key('srv:a'), json_encode(['keyspace_events' => true, 'keyspace_config' => 'unknown (NOPERM)'] + $status));
check(results()['keyspace'][0] === Health::INFO, 'keyspace configuration unknown: info');
$r->set(Valkey::key('srv:a'), json_encode($status));

// --- Valkey refuses one of the plugin's commands (ACL).
final class NoPublishValkey extends Redis
{
    public function publish(string $channel, string $message): Redis|int|false
    {
        return false;
    }
}
$acl = new NoPublishValkey();
$acl->connect('127.0.0.1', (int) ($argv[1] ?? 6379), 1.0);
$acl->select(6);
Valkey::$override = $acl;
$res = results();
check($res['valkey_acl'][0] === Health::ERROR && str_starts_with($res['valkey_acl'][1], 'PUBLISH') && str_contains($res['valkey_acl'][2], 'valkey.conf.example'), 'a command refused: error naming it, where the ACL is');
$acl->close();
Valkey::$override = $r;

// --- Valkey fails a read (connection lost meanwhile, ACL on INFO or SCAN): the check says
// why instead of breaking the page.
final class FailingValkey extends Redis
{
    public function info(string ...$sections): Redis|array|false
    {
        throw new RedisException('NOPERM info');
    }

    public function scan(null|int|string &$iterator, ?string $pattern = null, int $count = 0, ?string $type = null): array|false
    {
        throw new RedisException('NOPERM scan');
    }
}
$failing = new FailingValkey();
$failing->connect('127.0.0.1', (int) ($argv[1] ?? 6379), 1.0);
$failing->select(6);
Valkey::$override = $failing;
$res = results();
check($res['valkey_version'][0] === Health::WARNING && $res['valkey_version'][1] === 'NOPERM info', 'INFO refused: a warning with the reason');
check($res['server'][0] === Health::ERROR && $res['server'][1] === 'NOPERM scan', 'servers unreadable: an error with the reason');
$failing->close();
Valkey::$override = $r;

// --- The web server's answers on /ws not covered above.
$answers = [];
Health::$http = static function (string $url, array $headers) use (&$answers): array {
    return array_shift($answers) ?? [0, 'no answer'];
};
$answers = [[200, 'hello']];
$res = $cli();
check($res['ws_location'][0] === Health::WARNING && str_contains($res['ws_location'][1], 'HTTP 200') && !isset($res['ws_upgrade']), '/ws answers 200: unexpected, warning');
$answers = [[400, ''], [429, 'slow down']];
$res = $cli();
check($res['ws_upgrade'][0] === Health::WARNING && str_starts_with($res['ws_upgrade'][1], 'Rate-limited by the web server'), 'rate-limited upgrade: warning, says so');
$answers = [[400, ''], [418, '']];
$res = $cli();
check($res['ws_upgrade'][0] === Health::WARNING && str_contains($res['ws_upgrade'][1], 'HTTP 418'), 'unexpected upgrade answer: warning, the status');
Health::$requestOrigin = '';
Health::$urlBase = '';
$res = $cli();
check($res['ws_location'][0] === Health::ERROR && str_contains($res['ws_location'][2], 'URL of the application'), 'no GLPI URL at all: error, where to set it');
Health::$urlBase = 'https://glpi.example.org/';
Health::$requestOrigin = 'https://glpi.example.org';
Health::$http = null;

exit($GLOBALS['failures'] === 0 ? 0 : 1);
