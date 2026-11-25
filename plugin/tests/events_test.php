<?php

/**
 * Events recorded by the item hooks, and grant revocation on rights changes.
 * php -d extension=igbinary -d extension=redis plugin/tests/events_test.php <valkey-port>
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Events;
use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\Inbox;
use GlpiPlugin\Realtime\SessionToken;
use GlpiPlugin\Realtime\Valkey;

$r = test_valkey((string) ($argv[1] ?? '6379'));
$r->flushDB();
session_start();
Events::$autoFlush = false;
Inbox::$directory = new FakeDirectory();
Inbox::$writer = static function (): void {};
SessionToken::$cookieSink = static function (): void {};
User::$db = [7 => ['name' => 'alice', 'picture' => null]];
Session::$uid = 7;
$_SESSION['glpifriendlyname'] = 'Alice Martin';

/** Batches recorded so far for $room, then forgets them. */
function take(string $room): ?array
{
    $b = Events::pending()[$room] ?? null;
    Events::flush();
    return $b;
}

// --- Hooks are registered for every class and lifecycle step ------------------------
$hooks = Events::hooks();
check(isset($hooks['item_add']['ITILFollowup'], $hooks['item_purge']['Ticket_User'], $hooks['item_update']['Ticket']), 'hooks registered per class');

// --- Ticket updates: changed field names only, merged within a request ---------------
Events::onUpdate(new Ticket(['id' => 5], ['status', 'date_mod']));
Events::onUpdate(new Ticket(['id' => 5], ['priority', 'status']));
Events::onUpdate(new Ticket(['id' => 5], ['date_mod']));
$b = take('Ticket:5');
check($b['events'] === [['kind' => 'item.update', 'fields' => ['status', 'priority']]], 'one item.update with every changed field, noise dropped');
check($b['regrant'] === false, 'no regrant for ordinary updates');
Events::onAdd(new Ticket(['id' => 6]));
check(take('Ticket:6') === null, 'nothing for a new ticket');
Events::onUpdate(new Ticket(['id' => 5], ['entities_id']));
check(take('Ticket:5')['regrant'] === true, 'entity change: regrant');
Events::onDelete(new Ticket(['id' => 5]));
check(take('Ticket:5')['events'][0]['kind'] === 'item.delete', 'trash');

// --- Followups: visibility, notifications of public ones ------------------------------
Ticket::$actors = [5 => [CommonITILActor::REQUESTER => [11], CommonITILActor::OBSERVER => [12], CommonITILActor::ASSIGN => [7, 13]]];
Events::onAdd(new ITILFollowup(['id' => 30, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 0, 'users_id' => 7]));
$b = take('Ticket:5');
check($b['events'] === [[
    'kind' => 'followup.add',
    'item' => ['type' => 'ITILFollowup', 'id' => 30],
    'vis'  => ['right' => 'followup', 'private' => false, 'uids' => [7]],
]], 'followup event with its visibility');
$publishes = static fn(): int => (int) preg_replace('/^calls=(\d+).*/', '$1', (string) ($r->info('commandstats')['cmdstat_publish'] ?? 'calls=0'));
$before = $publishes();
Events::onAdd(new ITILFollowup(['id' => 31, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 1, 'users_id' => 7]));
$b = take('Ticket:5');
check($b['events'][0]['vis']['private'] === true, 'private followup: private event');
Events::onPurge(new ITILFollowup(['id' => 31, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 1, 'users_id' => 7]));
check(take('Ticket:5')['events'][0]['kind'] === 'followup.delete', 'purged sub-item announced as a deletion');
Events::onAdd(new ITILFollowup(['id' => 32, 'itemtype' => 'Computer', 'items_id' => 5]));
check(Events::pending() === [], 'item types that are not enabled are ignored');

// --- Changes and problems: same events, their own rooms ------------------------------------
Events::onUpdate(new Change(['id' => 8], ['status']));
Events::onAdd(new ChangeTask(['id' => 41, 'changes_id' => 8, 'is_private' => 0, 'users_id' => 7]));
Events::onAdd(new ChangeValidation(['id' => 61, 'changes_id' => 8]));
Events::onPurge(new Change_Group(['id' => 84, 'changes_id' => 8, 'groups_id' => 3, 'type' => 2]));
$b = take('Change:8');
check(array_column($b['events'], 'kind') === ['item.update', 'task.add', 'validation.add', 'actor.delete'], 'change: fields, task, approval, actors');
check($b['events'][1]['item'] === ['type' => 'ChangeTask', 'id' => 41] && $b['regrant'] === true, 'change task, and regrant when an actor goes');
Events::onAdd(new ITILSolution(['id' => 51, 'itemtype' => 'Problem', 'items_id' => 9]));
Events::onAdd(new Document_Item(['id' => 72, 'itemtype' => 'Problem', 'items_id' => 9, 'documents_id' => 5]));
Events::onAdd(new ProblemTask(['id' => 42, 'problems_id' => 9]));
check(array_column(take('Problem:9')['events'], 'kind') === ['solution.add', 'document.add', 'task.add'], 'problem: solution, document, task');

// --- Tasks: technician and group visibility, notification of the technician -----------
Events::onAdd(new TicketTask(['id' => 40, 'tickets_id' => 5, 'is_private' => 1, 'users_id' => 7, 'users_id_tech' => 13, 'groups_id_tech' => 4]));
$b = take('Ticket:5');
check($b['events'][0]['vis'] === ['right' => 'task', 'private' => true, 'uids' => [7, 13], 'groups' => [4]], 'task visibility: author, technician, technician group');

// --- Solutions and validations ----------------------------------------------------------
Events::onAdd(new ITILSolution(['id' => 50, 'itemtype' => 'Ticket', 'items_id' => 5]));
check(take('Ticket:5')['events'][0]['kind'] === 'solution.add', 'solution');
Group_User::$members = [9 => [21, 22]];
Events::onAdd(new TicketValidation(['id' => 60, 'tickets_id' => 5, 'itemtype_target' => 'Group', 'items_id_target' => 9]));
$b = take('Ticket:5');
check($b['events'][0]['kind'] === 'validation.add', 'validation request');

// --- Documents --------------------------------------------------------------------------
Events::onAdd(new Document_Item(['id' => 70, 'itemtype' => 'Ticket', 'items_id' => 5, 'documents_id' => 3]));
check(take('Ticket:5')['events'][0] === ['kind' => 'document.add', 'item' => ['type' => 'Document', 'id' => 3]], 'document attached to the ticket');
Events::onAdd(new Document_Item(['id' => 71, 'itemtype' => 'ITILFollowup', 'items_id' => 30, 'documents_id' => 4]));
check(Events::pending() === [], 'documents of followups ride with the followup');

// --- Actors: assignment notifications, regrant when access may shrink -------------------
Events::onAdd(new Ticket_User(['id' => 80, 'tickets_id' => 5, 'users_id' => 14, 'type' => CommonITILActor::ASSIGN]));
$b = take('Ticket:5');
check($b['regrant'] === false && $b['events'][0]['kind'] === 'actor.add', 'new assignee: no regrant');
Events::onAdd(new Group_Ticket(['id' => 81, 'tickets_id' => 5, 'groups_id' => 9, 'type' => CommonITILActor::ASSIGN]));
take('Ticket:5');
Events::onAdd(new Ticket_User(['id' => 82, 'tickets_id' => 5, 'users_id' => 15, 'type' => CommonITILActor::OBSERVER]));
take('Ticket:5');
Events::onPurge(new Ticket_User(['id' => 80, 'tickets_id' => 5, 'users_id' => 14, 'type' => CommonITILActor::ASSIGN]));
$b = take('Ticket:5');
check($b['regrant'] === true && $b['events'][0]['kind'] === 'actor.delete', 'actor removed: regrant');
Events::onUpdate(new Ticket_User(['id' => 82, 'tickets_id' => 5, 'type' => 3], ['use_notification']));
check(Events::pending() === [], 'actor notification settings: nothing');
Events::onUpdate(new Supplier_Ticket(['id' => 83, 'tickets_id' => 5, 'type' => 3], ['type']));
check(take('Ticket:5')['regrant'] === true, 'actor type changed: regrant');

// --- Messages respect the server limits --------------------------------------------------
$many = ['regrant' => true, 'events' => array_fill(0, 70, ['kind' => 'x'])];
$msgs = array_map(fn($m) => json_decode($m, true), Events::messages('Ticket:5', ['id' => 7, 'name' => 'A'], $many));
check(count($msgs) === 2 && count($msgs[0]['events']) === 64 && count($msgs[1]['events']) === 6, 'split at 64 events');
check($msgs[0]['regrant'] && !$msgs[1]['regrant'], 'regrant once');
$notices = array_map(fn($m) => json_decode($m, true), Events::notices(['id' => 7, 'name' => 'A'], [['Ticket:5', 'assigned', range(1, 1500), false], ['', 'inbox', [7], true]]));
check(count($notices) === 1 && count($notices[0]['notify']) === 3, 'notices split at 1000 recipients');
check($notices[0]['notify'][0]['item'] === 'Ticket:5' && !isset($notices[0]['notify'][0]['sync']) && !isset($notices[0]['room']), 'notices carry the item, no room');
check($notices[0]['notify'][2] === ['to' => [7], 'kind' => 'inbox', 'sync' => true], 'sync notice has no item');
check($msgs[0]['by'] === ['id' => 7, 'name' => 'A'] && $msgs[0]['room'] === 'Ticket:5', 'author and room on every message');

// --- A broken hook never breaks GLPI -----------------------------------------------------
Events::onAdd('not an item');
Events::onAdd(new TicketValidation(['id' => 1, 'tickets_id' => 5, 'itemtype_target' => 'Group', 'items_id_target' => 'x']));
check(true, 'bad input ignored');
Events::flush();

// An item whose fields cannot be read: each of the three recorders fails, each failure
// is logged, and the GLPI request goes on.
final class Exploding extends CommonDBTM
{
    public function __construct()
    {
        unset($this->fields, $this->updates);
    }

    public function __get(string $name): mixed
    {
        throw new RuntimeException("no $name");
    }
}
Toolbox::$logs = [];
Events::onUpdate(new Exploding());
$logged = array_map(static fn($l) => strtok($l[1], ':'), Toolbox::$logs);
check(
    $logged === ['event not recorded', 'notification not recorded', 'rights change not recorded'],
    'each recorder failure is logged on its own: ' . json_encode($logged)
);

// Notifications that cannot be written do not stop the item's live update.
Toolbox::$logs = [];
$writer = Inbox::$writer;
Inbox::$writer = static function (): void {
    throw new RuntimeException('database gone');
};
$publishes = static fn(): int => (int) preg_replace('/^calls=(\d+).*/', '$1', (string) ($r->info('commandstats')['cmdstat_publish'] ?? 'calls=0'));
$before = $publishes();
Events::onAdd(new ITILFollowup(['id' => 31, 'itemtype' => 'Ticket', 'items_id' => 5, 'is_private' => 0, 'users_id' => 7]));
check(Events::pending() !== [], 'the followup is recorded');
Events::flush();
Inbox::$writer = $writer;
check(
    array_map(static fn($l) => strtok($l[1], ':'), Toolbox::$logs) === ['notifications not written'],
    'the write failure is logged'
);
check($publishes() > $before, 'and the followup was published anyway');

// --- Grants: index, revocation, stale grants removed --------------------------------------
SessionToken::ensure(7);
$mine = SessionToken::currentHash();
$t = new Ticket(['id' => 5]);
check(Grants::write($t), 'grant written');
$other = str_repeat('b', 64);
$r->hSet(Valkey::key('g:' . $other . ':Ticket:5'), 'read', '1');
$r->sAdd(Valkey::key('gi:Ticket:5'), $other);
check(
    $r->sMembers(Valkey::key('gi:Ticket:5')) == [$mine, $other] || $r->sMembers(Valkey::key('gi:Ticket:5')) == [$other, $mine],
    'sessions with a grant are indexed per item'
);
check($r->ttl(Valkey::key('gi:Ticket:5')) > 0, 'index expires');
Events::onPurge(new Ticket_User(['id' => 80, 'tickets_id' => 5, 'users_id' => 14, 'type' => 2]));
Events::flush();
check(
    $r->exists(Valkey::key('g:' . $mine . ':Ticket:5'), Valkey::key('g:' . $other . ':Ticket:5')) === 0
        && $r->sCard(Valkey::key('gi:Ticket:5')) === 0,
    'regrant deletes every grant on the item'
);
Grants::write($t);
$t->readable = false;
check(!Grants::write($t) && $r->exists(Valkey::key('g:' . $mine . ':Ticket:5')) === 0, 'grant removed once GLPI refuses READ');
check($r->sIsMember(Valkey::key('gi:Ticket:5'), $mine) === false, 'and unindexed');

// --- Session groups --------------------------------------------------------------------------
$_SESSION['glpigroups'] = [8, 3, 3];
SessionToken::ensure(7);
check($r->hGet(SessionToken::sessionKey($mine), 'groups') === '[3,8]', 'session carries the user groups');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
