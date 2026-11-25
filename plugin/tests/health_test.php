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

// --- Database checks (plugin tables, purge task), with doubles of GLPI's $DB and CronTask.
if (!defined('DAY_TIMESTAMP')) {
    define('DAY_TIMESTAMP', 86400);
}
final class CronTask
{
    public const STATE_DISABLE = 0;
    public const STATE_WAITING = 1;
    /** The task GLPI has, or null when it is not registered. */
    public static ?array $task = null;
    public array $fields = [];

    public function getFromDBbyName(string $itemtype, string $name): bool
    {
        if (self::$task === null || $itemtype !== \GlpiPlugin\Realtime\Inbox::class || $name !== 'inboxpurge') {
            return false;
        }
        $this->fields = self::$task;
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
        if (in_array($c['id'], ['tables', 'cron'], true)) {
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
Health::$http = null;
Health::$skipDatabase = true;

exit($GLOBALS['failures'] === 0 ? 0 : 1);
