<?php

/**
 * Interop helper for the Rust test suite: runs the plugin hooks of one GLPI request on
 * ticket <ticket-id>, done by user <by-uid>, then publishes them exactly as the plugin does.
 * php ... publish_events.php <valkey-socket> <by-uid> <ticket-id> <scenario>
 *   changes: ticket update, public and private followups, assignment of user 5
 *   unassign: user 5 removed from the actors (regrant)
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\Events;
use GlpiPlugin\Realtime\Inbox;

test_valkey((string) $argv[1]);
$by = (int) $argv[2];
$tid = (int) $argv[3];
Session::$uid = $by;
$_SESSION['glpifriendlyname'] = 'Tech ' . $by;
Events::$autoFlush = false;
Ticket::$actors[$tid] = [CommonITILActor::REQUESTER => [5]];
// User 5 requested the ticket; no database: rows are dropped, pushes are published.
$dir = new FakeDirectory();
$dir->actors["Ticket:$tid"] = [5 => ['channel' => 'direct', 'types' => [CommonITILActor::REQUESTER]]];
Inbox::$directory = $dir;
Inbox::$writer = static function (): void {};

switch ($argv[4]) {
    case 'changes':
        Events::onUpdate(new Ticket(['id' => $tid], ['status', 'date_mod']));
        Events::onAdd(new ITILFollowup(['id' => 1, 'itemtype' => 'Ticket', 'items_id' => $tid, 'is_private' => 0, 'users_id' => $by]));
        Events::onAdd(new ITILFollowup(['id' => 2, 'itemtype' => 'Ticket', 'items_id' => $tid, 'is_private' => 1, 'users_id' => $by]));
        Events::onAdd(new Ticket_User(['id' => 3, 'tickets_id' => $tid, 'users_id' => 5, 'type' => CommonITILActor::ASSIGN]));
        break;
    case 'unassign':
        Events::onPurge(new Ticket_User(['id' => 3, 'tickets_id' => $tid, 'users_id' => 5, 'type' => CommonITILActor::ASSIGN]));
        break;
}
Events::flush();
