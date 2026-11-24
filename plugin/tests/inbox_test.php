<?php

/**
 * Who gets a notification (rules ported from Notifier+), and the bell's queues.
 * php -d extension=igbinary -d extension=redis plugin/tests/inbox_test.php
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Events;
use GlpiPlugin\Realtime\Inbox;
use GlpiPlugin\Realtime\InboxView;

Events::$autoFlush = false;
Session::$uid = 7; // the author of every change below
$dir = new FakeDirectory();
Inbox::$directory = $dir;
$written = [];
Inbox::$writer = static function (array $rows, array $cleanups) use (&$written): void {
    $written = ['rows' => $rows, 'cleanups' => $cleanups];
};

const R = CommonITILActor::REQUESTER;
const A = CommonITILActor::ASSIGN;
const O = CommonITILActor::OBSERVER;

$dir->actors['Ticket:5'] = [
    7  => ['channel' => 'direct', 'types' => [A]],  // the author
    11 => ['channel' => 'direct', 'types' => [R]],
    12 => ['channel' => 'direct', 'types' => [O]],
    13 => ['channel' => 'direct', 'types' => [A]],
    21 => ['channel' => 'group', 'types' => [A]],   // assigned group
    22 => ['channel' => 'group', 'types' => [A]],
    23 => ['channel' => 'group', 'types' => [R]],   // requester group
];
$dir->others[0] = [30, 13];

/** Runs one "request": the hooks, then the end-of-request flush. Returns [rows, pushes]. */
function request(callable $hooks): array
{
    global $written;
    $written = ['rows' => [], 'cleanups' => []];
    $hooks();
    $pushes = Inbox::flush();
    return [$written['rows'], $pushes, $written['cleanups']];
}

/** "uid:event:channel" for each row, sorted. */
function summary(array $rows): array
{
    $out = array_map(fn($r) => "{$r['users_id']}:{$r['event']}:{$r['channel']}", $rows);
    sort($out);
    return $out;
}

// --- Followups --------------------------------------------------------------------------
[$rows, $pushes] = request(fn() => Events::onAdd(new ITILFollowup(['id' => 1, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 0])));
check(summary($rows) === [
    '11:commented:direct', '12:commented:direct', '13:commented:direct',
    '21:commented:group', '22:commented:group', '23:commented:group', '30:commented:other',
], 'public followup: every actor, then "others" who asked (actors are not counted twice), never the author');
check($pushes === [['Ticket:5', 'commented', [11, 12, 13, 21, 22, 23, 30], false]], 'one live push per item and event');

[$rows] = request(fn() => Events::onAdd(new ITILFollowup(['id' => 2, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 1])));
check(summary($rows) === ['13:commented:direct', '21:commented:group', '22:commented:group'], 'private followup: assigned technicians only');

// --- Creation -------------------------------------------------------------------------------
$dir->technicians[3] = [40, 41, 7];
[$rows, $pushes] = request(fn() => Events::onAdd(new Ticket(['id' => 6, 'entities_id' => 3])));
check($rows === [], 'unassigned ticket: no row per technician (listed when the bell is read)');
check($pushes === [['Ticket:6', 'created', [40, 41], false]], 'but every technician of the entity is told live');

$dir->actors['Ticket:8'] = [11 => ['channel' => 'direct', 'types' => [R]], 13 => ['channel' => 'direct', 'types' => [A]]];
[$rows] = request(function () {
    Events::onAdd(new Ticket_User(['tickets_id' => 8, 'users_id' => 13, 'type' => A]));
    Events::onAdd(new Ticket(['id' => 8, 'entities_id' => 0]));
});
check(summary($rows) === ['11:created:direct', '13:assigned:direct'], 'created with an assignee: "assigned" supersedes "created"');

// --- Ticket updates ---------------------------------------------------------------------------
[$rows] = request(fn() => Events::onUpdate(new Ticket(['id' => 5, 'status' => 4], ['status', 'date_mod'])));
check(count($rows) === 7 && $rows[0]['event'] === 'status_changed' && $rows[0]['detail'] === '{"status":4}', 'status change with the new status');
[$rows] = request(fn() => Events::onUpdate(new Ticket(['id' => 5], ['priority', 'date_mod', 'urgency'])));
check($rows[0]['event'] === 'updated' && json_decode($rows[0]['detail'], true) === ['fields' => ['priority', 'urgency']], 'watched fields only');
[$rows] = request(fn() => Events::onUpdate(new Ticket(['id' => 5], ['date_mod', 'actiontime'])));
check($rows === [], 'nothing worth telling');
$dir->technicians[9] = [60];
[$rows, $pushes] = request(fn() => Events::onUpdate(new Ticket(['id' => 6, 'entities_id' => 9], ['entities_id'])));
check($pushes === [['Ticket:6', 'transferred', [60], false]], 'unassigned ticket moved: technicians of the new entity');
[$rows] = request(fn() => Events::onUpdate(new Ticket(['id' => 5, 'entities_id' => 9], ['entities_id'])));
check(in_array('13:transferred:direct', summary($rows), true), 'assigned ticket moved: its actors');

// --- Solutions ---------------------------------------------------------------------------------
[$rows] = request(fn() => Events::onAdd(new ITILSolution(['id' => 3, 'itemtype' => 'Ticket', 'items_id' => 5])));
check(count($rows) === 7 && $rows[0]['event'] === 'solution', 'solution: actors and others');
[$rows] = request(function () {
    Events::onUpdate(new ITILSolution(['id' => 3, 'itemtype' => 'Ticket', 'items_id' => 5, 'status' => CommonITILValidation::REFUSED], ['status']));
    Events::onUpdate(new Ticket(['id' => 5, 'status' => 2], ['status']));
});
$s = summary($rows);
check(in_array('13:solution_refused:direct', $s, true) && !in_array('13:status_changed:direct', $s, true), 'refused solution: technicians, instead of the status change');
check(in_array('11:status_changed:direct', $s, true), 'the requester still sees the status change');

// --- Validations -------------------------------------------------------------------------------
$dir->groups[9] = [70, 71, 7];
[$rows] = request(fn() => Events::onAdd(new TicketValidation(['id' => 4, 'tickets_id' => 5, 'itemtype_target' => 'Group', 'items_id_target' => 9, 'status' => 2])));
check(summary($rows) === ['70:validation_asked:group', '71:validation_asked:group'], 'approval asked to a group');
[$rows] = request(fn() => Events::onAdd(new TicketValidation(['id' => 5, 'tickets_id' => 5, 'itemtype_target' => 'User', 'items_id_target' => 72])));
check(summary($rows) === ['72:validation_asked:direct'], 'approval asked to a user');
[$rows] = request(fn() => Events::onUpdate(new TicketValidation(['id' => 4, 'tickets_id' => 5, 'status' => CommonITILValidation::ACCEPTED], ['status'])));
check(count($rows) === 6 && $rows[0]['detail'] === '{"status":3}', 'approval answered: actors (GLPI 12 statuses)');
[$rows] = request(fn() => Events::onUpdate(new TicketValidation(['id' => 4, 'tickets_id' => 5, 'status' => CommonITILValidation::WAITING], ['comment_validation'])));
check($rows === [], 'other approval edits: nothing');

// --- Tasks ----------------------------------------------------------------------------------------
[$rows] = request(fn() => Events::onAdd(new TicketTask(['id' => 6, 'tickets_id' => 5, 'is_private' => 1, 'users_id_tech' => 50])));
check(summary($rows) === ['13:task_added:direct', '21:task_added:group', '22:task_added:group', '50:task_added:direct'], 'private task: assignees, and its technician');
[$rows] = request(fn() => Events::onUpdate(new TicketTask(['id' => 6, 'tickets_id' => 5, 'users_id_tech' => 51], ['users_id_tech'])));
check(summary($rows) === ['51:task_added:direct'], 'task given to another technician');

// --- Actors ---------------------------------------------------------------------------------------------
$dir->groups[4] = [80, 81];
[$rows] = request(fn() => Events::onAdd(new Group_Ticket(['tickets_id' => 5, 'groups_id' => 4, 'type' => A])));
check(summary($rows) === ['80:assigned:group', '81:assigned:group'], 'group assigned: its members');
[$rows] = request(fn() => Events::onAdd(new Ticket_User(['tickets_id' => 5, 'users_id' => 82, 'type' => O])));
check($rows === [], 'observer added: nothing');
[$rows, $pushes, $cleanups] = request(fn() => Events::onPurge(new Ticket_User(['tickets_id' => 5, 'users_id' => 90, 'type' => A])));
check($cleanups === ['Ticket:5' => [90]] && $pushes === [['', 'inbox', [90], true]], 'actor removed: their notifications on it go, their bell refreshes');
[$rows, $pushes, $cleanups] = request(fn() => Events::onPurge(new Ticket_User(['tickets_id' => 5, 'users_id' => 13, 'type' => A])));
check($cleanups === [], 'still an actor another way: kept');
[, , $cleanups] = request(fn() => Events::onUpdate(new Ticket(['id' => 5, 'is_deleted' => 1], ['is_deleted'])));
check($cleanups === ['Ticket:5' => null], 'ticket in the trash: off every bell');

// --- Project tasks -------------------------------------------------------------------------------------
$dir->teams[3] = [91 => 'direct', 92 => 'group', 7 => 'direct'];
[$rows] = request(fn() => Events::onUpdate(new ProjectTask(['id' => 3], ['percent_done'])));
check(summary($rows) === ['91:status_changed:direct', '92:status_changed:group'], 'project task progress: its team');
[$rows] = request(fn() => Events::onAdd(new ProjectTaskTeam(['projecttasks_id' => 3, 'itemtype' => 'Group', 'items_id' => 4])));
check(summary($rows) === ['80:assigned:group', '81:assigned:group'], 'group added to a project task team');

// --- Read state in another tab -------------------------------------------------------------------------------
Inbox::sync(7);
[$rows, $pushes] = request(fn() => null);
check($pushes === [['', 'inbox', [7], true]], 'read elsewhere: silent refresh of the user\'s tabs');

// --- Preferences ------------------------------------------------------------------------------------------------
$p = Inbox::cleanPreferences(['sound_new' => '0', 'update_message_style' => 'combined', 'resolved_closed_style' => 'nope', 'evil' => 1]);
check($p['sound_new'] === false && $p['update_message_style'] === 'combined' && $p['resolved_closed_style'] === 'separate' && !isset($p['evil']), 'preferences: typed, known values only');
check(Inbox::cleanPreferences([]) === Inbox::DEFAULT_PREFERENCES, 'no row: defaults');

$prefs = Inbox::DEFAULT_PREFERENCES;
check(InboxView::wanted(['itemtype' => 'Ticket', 'channel' => 'group'], $prefs), 'group notifications on by default');
check(!InboxView::wanted(['itemtype' => 'Ticket', 'channel' => 'group'], ['notify_ticket_group' => false] + $prefs), 'opted out of group ones');
check(InboxView::wanted(['itemtype' => 'Ticket', 'channel' => 'direct'], ['notify_ticket_group' => false] + $prefs), 'direct ones still on');
check(!InboxView::wanted(['itemtype' => 'Ticket', 'channel' => 'other'], $prefs), '"others" off by default');

// --- Queues -----------------------------------------------------------------------------------------------------
$q = fn(array $o, string $ch = 'direct') => InboxView::queue('Ticket', $o, $ch, 7, [4]);
check($q(['status' => 1]) === 'new', 'nobody assigned: New');
check($q(['status' => 2, 'assigned_users' => [7]]) === 'mine', 'assigned to me: Mine');
check($q(['status' => 2, 'assigned_users' => [9], 'assigned_groups' => [4]]) === 'team', 'my group: Team');
check($q(['status' => 2, 'assigned_users' => [9]]) === 'other', 'someone else: Others');
check($q(['status' => 5, 'assigned_users' => [7]]) === 'resolved' && $q(['status' => 6]) === 'closed', 'Resolved, Closed');
check(InboxView::queue('ProjectTask', [], 'group', 7, []) === 'team', 'project tasks: by channel');

$items = [
    ['key' => 'Ticket:1', 'queue' => 'mine', 'is_read' => false],
    ['key' => 'Ticket:1', 'queue' => 'mine', 'is_read' => false],
    ['key' => 'Ticket:2', 'queue' => 'new', 'is_read' => false],
    ['key' => 'Ticket:3', 'queue' => 'closed', 'is_read' => false],
    ['key' => 'Ticket:4', 'queue' => 'team', 'is_read' => true],
];
$c = InboxView::counts($items, $prefs);
check($c['all'] === 3 && $c['mine'] === 1 && $c['new'] === 1 && $c['closed'] === 1 && $c['team'] === 0 && $c['ended'] === 1, 'counters count items, unread only');
check(InboxView::counts($items, ['show_closed' => false] + $prefs)['all'] === 2, 'hidden queues are not counted');
check(InboxView::inTab('closed', 'ended') && InboxView::inTab('new', 'all') && !InboxView::inTab('new', 'mine'), 'tabs');

// --- Mentions ("@name", GLPI's rich text) ------------------------------------------------
$mention = static fn(int $uid, string $name) => sprintf('<span data-user-mention="true" data-user-id="%d">@%s</span>', $uid, $name);
check(Inbox::mentions('<p>Hello ' . $mention(30, 'Ann') . ' and ' . $mention(41, 'Bob') . $mention(30, 'Ann') . '</p>') === [30, 41], 'mentioned users, once each');
check(Inbox::mentions(htmlspecialchars('<p>' . $mention(42, 'Cy') . '</p>')) === [42], 'content stored encoded (older GLPI)');
check(Inbox::mentions('<p>data-user-id="9" in text, no mention</p>') === [], 'only GLPI\'s mention markup counts');

[$rows] = request(fn() => Events::onAdd(new ITILFollowup(['id' => 3, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 0,
    'content' => '<p>' . $mention(40, 'Dee') . ' ' . $mention(7, 'Me') . ' ' . $mention(11, 'Req') . '</p>'])));
$mentioned = array_values(array_filter(summary($rows), fn($r) => str_contains($r, 'mentioned')));
check($mentioned === ['11:mentioned:direct', '40:mentioned:direct'], 'followup: mentioned users told directly (actors or not), never the author');
$detail = array_values(array_filter($rows, fn($r) => $r['event'] === 'mentioned'))[0]['detail'] ?? '';
check($detail === '{"in":"followup"}', 'where the mention is');

$t = new Ticket(['id' => 5, 'entities_id' => 0, 'content' => '<p>' . $mention(30, 'Ann') . ' ' . $mention(41, 'Bob') . '</p>'], ['content']);
$t->oldvalues = ['content' => '<p>' . $mention(30, 'Ann') . '</p>'];
[$rows] = request(fn() => Events::onUpdate($t));
check(in_array('41:mentioned:direct', summary($rows), true) && !in_array('30:mentioned:direct', summary($rows), true), 'description edited: only the newly mentioned');

$t = new Ticket(['id' => 5, 'entities_id' => 0, 'priority' => 5, 'content' => '<p>' . $mention(30, 'Ann') . '</p>'], ['priority']);
[$rows] = request(fn() => Events::onUpdate($t));
check(!in_array('30:mentioned:direct', summary($rows), true), 'another field changed: mentions already there are not told again');

$row = ['itemtype' => 'Ticket', 'channel' => 'direct', 'event' => 'mentioned'];
check(InboxView::wanted($row, Inbox::DEFAULT_PREFERENCES) === true, 'mentions shown by default');
check(InboxView::wanted($row, ['notify_mentions' => false, 'notify_ticket_direct' => true] + Inbox::DEFAULT_PREFERENCES) === false, 'unless the user turned them off');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
