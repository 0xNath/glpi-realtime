<?php

/**
 * Alerts of tickets nearing or past their time to resolve (Inbox::slaAlerts, the
 * "slaalert" cron task): who, when, once.
 * php -d extension=igbinary -d extension=redis plugin/tests/sla_test.php
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Events;
use GlpiPlugin\Realtime\Inbox;

if (!defined('DAY_TIMESTAMP')) {
    define('DAY_TIMESTAMP', 86400);
}
Events::$autoFlush = false;
Session::$uid = 7; // a cron run inside someone's web request: they are warned too
$dir = new FakeDirectory();
Inbox::$directory = $dir;
$prefs = [];
Inbox::$preferencesReader = static function (int $uid) use (&$prefs): array {
    return $prefs[$uid] ?? [];
};
const A = CommonITILActor::ASSIGN;
const R = CommonITILActor::REQUESTER;
$now = 1_800_000_000;

/** One cron run: the notifications it adds, as "uid ticket event channel". */
$run = static function () use ($now, &$prefs): array {
    Inbox::reset();
    Inbox::slaAlerts($now);
    $out = [];
    foreach (Inbox::pendingRows() as $r) {
        $out[] = "{$r['users_id']} {$r['itemtype']}:{$r['items_id']} {$r['event']} {$r['channel']}";
    }
    sort($out);
    Inbox::reset();
    return $out;
};

$dir->actors['Ticket:1'] = [
    7  => ['channel' => 'direct', 'types' => [A]],   // assigned (and the session's user)
    11 => ['channel' => 'direct', 'types' => [R]],   // requester: never
    21 => ['channel' => 'group', 'types' => [A]],    // assigned group
];
$dir->actors['Ticket:2'] = [13 => ['channel' => 'direct', 'types' => [A]]];
$dir->actors['Ticket:3'] = [13 => ['channel' => 'direct', 'types' => [A]]];
$dir->actors['Ticket:4'] = [13 => ['channel' => 'direct', 'types' => [A]]];
$dir->due = [
    1 => $now + 45 * 60,          // in 45 min: within the default hour
    2 => $now + 3 * 3600,         // in 3 h: only for whoever chose 4 h
    3 => $now - 600,              // 10 min late
    4 => $now - 2 * DAY_TIMESTAMP, // late for days: an old backlog, not announced
];

check($run() === [
    '13 Ticket:3 ttr_late direct',
    '21 Ticket:1 ttr_soon group',
    '7 Ticket:1 ttr_soon direct',
], 'assignees only (direct and group), within an hour by default; late tickets; not the old backlog');

$prefs[13] = ['sla_alert' => '240'];
check(in_array('13 Ticket:2 ttr_soon direct', $run(), true), '4 h before when chosen');
$prefs[21] = ['sla_alert' => '0'];
check(!in_array('21 Ticket:1 ttr_soon group', $run(), true), 'never when turned off');
$prefs[7] = ['sla_alert' => '30'];
check(!in_array('7 Ticket:1 ttr_soon direct', $run(), true), 'not yet with 30 min');
$prefs = [];

// Once: a notification already there (same event and time to resolve) is not repeated.
$detail = json_encode(['ttr' => $dir->due[1]]);
$dir->notifiedRows = [['Ticket', 1, 'ttr_soon', $detail, 7]];
$res = $run();
check(!in_array('7 Ticket:1 ttr_soon direct', $res, true) && in_array('21 Ticket:1 ttr_soon group', $res, true), 'once per user');
// A new time to resolve (the SLA changed) warns again.
$dir->due[1] = $now + 50 * 60;
check(in_array('7 Ticket:1 ttr_soon direct', $run(), true), 'again after a new time to resolve');
$dir->notifiedRows = [];

// The rows carry the time to resolve; nothing is announced for tickets not due.
Inbox::reset();
Inbox::slaAlerts($now);
$rows = Inbox::pendingRows();
check(json_decode((string) $rows[0]['detail'], true) === ['ttr' => $dir->due[(int) $rows[0]['items_id']]], 'detail: the time to resolve');
Inbox::reset();
$dir->due = [];
check($run() === [], 'no ticket due: nothing');

// Published without author: the server withholds a notification from its author, and
// the cron task may run inside rt-7's own request.
$msgs = array_map(fn($m) => json_decode($m, true), Events::notices(['id' => 7, 'name' => 'Seven'], [
    ['Ticket:1', 'ttr_soon', [7, 21], false],
    ['Ticket:5', 'assigned', [7, 13], false],
]));
$byKind = [];
foreach ($msgs as $m) {
    foreach ($m['notify'] as $n) {
        $byKind[$n['kind']] = $m['by']['id'];
    }
}
check($byKind === ['ttr_soon' => 0, 'assigned' => 7], 'alerts published by GLPI (id 0), other notifications by their author');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
