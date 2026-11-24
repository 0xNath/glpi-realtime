<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonDBTM;
use CommonITILActor;
use CommonITILObject;
use Session;

/**
 * Inbox rows in GLPI's database, and the list shown by the bell.
 *
 * `list()` runs in the recipient's session: each item is loaded and GLPI checks READ
 * before anything about it (title, status, requester) is returned. Items the user cannot
 * read any more (entity transfer, actor removed, profile changed) simply disappear.
 */
final class InboxStore
{
    /** Notifications read per call, and items checked. */
    private const MAX_ROWS = 500;
    private const MAX_ITEMS = 100;
    /** Unassigned tickets are offered to technicians for this long. */
    private const NEW_DAYS = 7;

    /** @param list<array<string, mixed>> $rows @param array<string, ?list<int>> $cleanups */
    public static function write(array $rows, array $cleanups): void
    {
        global $DB;
        foreach ($cleanups as $item => $uids) {
            [$type, $id] = explode(':', $item);
            $where = ['itemtype' => $type, 'items_id' => (int) $id];
            if (is_array($uids)) {
                $where['users_id'] = $uids;
            }
            $DB->delete(Inbox::TABLE, $where);
        }
        $now = date('Y-m-d H:i:s');
        foreach ($rows as $r) {
            $DB->insert(Inbox::TABLE, $r + [
                'actor_users_id' => self::actor(),
                'is_read'        => 0,
                'date_creation'  => $now,
                'date_mod'       => $now,
            ]);
        }
    }

    private static function actor(): int
    {
        $uid = Session::getLoginUserID();
        return is_numeric($uid) ? (int) $uid : 0;
    }

    /**
     * The bell: notifications (unread, or all with $withRead) and the unassigned tickets
     * offered to technicians, grouped by item, with what GLPI lets this user see of them.
     *
     * @return array<string, mixed>
     */
    public static function list(int $uid, bool $withRead = false, bool $full = false): array
    {
        global $DB;
        $prefs = Inbox::preferences($uid);
        $where = ['users_id' => $uid];
        if (!$withRead) {
            $where['is_read'] = 0;
        }
        $rows = [];
        foreach ($DB->request(['FROM' => Inbox::TABLE, 'WHERE' => $where, 'ORDER' => ['date_creation DESC', 'id DESC'], 'LIMIT' => self::MAX_ROWS]) as $r) {
            if (InboxView::wanted($r, $prefs)) {
                $rows[] = $r;
            }
        }

        // Items, checked by GLPI in this session.
        $objects = [];
        foreach ($rows as $r) {
            $key = $r['itemtype'] . ':' . $r['items_id'];
            if (!array_key_exists($key, $objects) && count($objects) < self::MAX_ITEMS) {
                $objects[$key] = self::describe((string) $r['itemtype'], (int) $r['items_id'], $full);
            }
        }
        foreach (self::unassigned($uid) as $t) {
            $key = 'Ticket:' . $t['id'];
            if (array_key_exists($key, $objects) || count($objects) >= self::MAX_ITEMS) {
                continue;
            }
            $objects[$key] = self::describe('Ticket', (int) $t['id'], $full);
            $rows[] = [
                'id' => 0, 'itemtype' => 'Ticket', 'items_id' => (int) $t['id'], 'event' => Inbox::CREATED,
                'channel' => 'broadcast', 'detail' => '', 'is_read' => 0, 'actor_users_id' => 0,
                'date_creation' => $t['date_creation'],
            ];
        }
        $objects = array_filter($objects);
        self::addAssignments($objects);

        $myGroups = array_map('intval', (array) ($_SESSION['glpigroups'] ?? []));
        $items = [];
        $actors = [];
        foreach ($rows as $r) {
            $key = $r['itemtype'] . ':' . $r['items_id'];
            if (!isset($objects[$key])) {
                continue; // not readable any more, or beyond the limit
            }
            $queue = InboxView::queue((string) $r['itemtype'], $objects[$key], (string) $r['channel'], $uid, $myGroups);
            if (!InboxView::visible($queue, $prefs)) {
                continue;
            }
            $actor = (int) $r['actor_users_id'];
            $actors[$actor] = true;
            $items[] = [
                'id'      => (int) $r['id'],
                'key'     => $key,
                'event'   => (string) $r['event'],
                'channel' => (string) $r['channel'],
                'detail'  => $r['detail'] !== '' ? json_decode((string) $r['detail'], true) : null,
                'is_read' => (bool) $r['is_read'],
                'actor'   => $actor,
                'date'    => (string) $r['date_creation'],
                'queue'   => $queue,
            ];
        }
        foreach ($objects as &$o) {
            unset($o['assigned_users'], $o['assigned_groups']);
        }
        unset($o);

        return [
            'items'          => $items,
            'objects'        => $objects,
            'users'          => self::names(array_keys($actors)),
            'counts'         => InboxView::counts($items, $prefs),
            'preferences'    => $prefs,
            'can_see_others' => Session::haveRight('ticket', \Ticket::STEAL),
        ];
    }

    /**
     * What the bell shows of an item, or null when GLPI refuses READ.
     *
     * @return array<string, mixed>|null
     */
    private static function describe(string $type, int $id, bool $full): ?array
    {
        if (!is_a($type, CommonDBTM::class, true)) {
            return null;
        }
        $item = new $type();
        if (!$item->getFromDB($id) || !empty($item->fields['is_deleted']) || !$item->can($id, READ)) {
            return null;
        }
        $f = $item->fields;
        $o = [
            'type'   => $type,
            'id'     => $id,
            'title'  => (string) ($f['name'] ?? '') !== '' ? (string) $f['name'] : '#' . $id,
            'url'    => $item->getLinkURL(),
            'status' => (int) ($f['status'] ?? $f['projectstates_id'] ?? 0),
        ];
        if ($item instanceof CommonITILObject) {
            $o['status_label'] = $type::getStatus($o['status']);
            $o['priority'] = (int) ($f['priority'] ?? 0);
            $o['can_assign'] = $item->canAssignToMe();
            if ($full) {
                $o['priority_label'] = CommonITILObject::getPriorityName($o['priority']);
                $o['entity'] = \Dropdown::getDropdownName('glpi_entities', (int) $f['entities_id']);
                $o['type_label'] = $item instanceof \Ticket ? \Ticket::getTicketTypeName((int) $f['type']) : $type::getTypeName(1);
                $o['requesters'] = array_values(array_map(
                    static fn(array $u) => getUserName((int) $u['users_id']),
                    $item->getUsers(CommonITILActor::REQUESTER)
                ));
            }
        }
        return $o;
    }

    /** Assigned users and groups, for the queues: two queries per item type. */
    private static function addAssignments(array &$objects): void
    {
        global $DB;
        $ids = [];
        foreach ($objects as $o) {
            if (in_array($o['type'], Inbox::ITIL, true)) {
                $ids[$o['type']][] = $o['id'];
            }
        }
        foreach ($ids as $type => $list) {
            [$userLink, $groupLink, $fk] = GlpiDirectory::LINKS[$type];
            foreach ($list as $id) {
                $objects["$type:$id"]['assigned_users'] = [];
                $objects["$type:$id"]['assigned_groups'] = [];
            }
            foreach ([[$userLink, 'users_id', 'assigned_users'], [$groupLink, 'groups_id', 'assigned_groups']] as [$link, $col, $field]) {
                foreach ($DB->request(['SELECT' => [$fk, $col], 'FROM' => $link::getTable(), 'WHERE' => [$fk => $list, 'type' => CommonITILActor::ASSIGN]]) as $row) {
                    $objects["$type:{$row[$fk]}"][$field][] = (int) $row[$col];
                }
            }
        }
    }

    /**
     * Recent unassigned tickets in the user's active entities that they have not
     * looked at yet (the "New" queue), for technicians only.
     *
     * @return list<array{id: int, date_creation: string}>
     */
    private static function unassigned(int $uid): array
    {
        global $DB;
        if (Session::getCurrentInterface() !== 'central' || !\Ticket::canView()) {
            return [];
        }
        $assigned = static fn(string $table) => new \Glpi\DBAL\QuerySubQuery([
            'SELECT' => 'tickets_id', 'FROM' => $table, 'WHERE' => ['type' => CommonITILActor::ASSIGN],
        ]);
        $mine = new \Glpi\DBAL\QuerySubQuery([
            'SELECT' => 'items_id', 'FROM' => Inbox::TABLE, 'WHERE' => ['users_id' => $uid, 'itemtype' => 'Ticket'],
        ]);
        $out = [];
        foreach ($DB->request([
            'SELECT' => ['id', 'date_creation'],
            'FROM'   => 'glpi_tickets',
            'WHERE'  => [
                'is_deleted' => 0,
                'status'     => ['<', CommonITILObject::SOLVED],
                'date_creation' => ['>', date('Y-m-d H:i:s', time() - self::NEW_DAYS * DAY_TIMESTAMP)],
                ['NOT' => ['id' => $assigned('glpi_tickets_users')]],
                ['NOT' => ['id' => $assigned('glpi_groups_tickets')]],
                ['NOT' => ['id' => $mine]],
            ] + getEntitiesRestrictCriteria('glpi_tickets'),
            'ORDER'  => 'date_creation DESC',
            'LIMIT'  => 50,
        ]) as $row) {
            $out[] = ['id' => (int) $row['id'], 'date_creation' => (string) $row['date_creation']];
        }
        return $out;
    }

    /** @param list<int> $uids @return array<int, string> */
    private static function names(array $uids): array
    {
        $out = [];
        foreach ($uids as $u) {
            $out[$u] = $u > 0 ? getUserName($u) : '';
        }
        return $out;
    }

    // ------------------------------------------------------------------ read state

    public static function markRead(int $uid, int $id, bool $read = true): void
    {
        global $DB;
        $DB->update(Inbox::TABLE, ['is_read' => (int) $read, 'date_mod' => date('Y-m-d H:i:s')], ['id' => $id, 'users_id' => $uid]);
        Inbox::sync($uid);
    }

    /**
     * Everything about one item read (opened, or clicked in the bell). An unassigned
     * ticket gets a "seen" row so that it leaves the New queue.
     */
    public static function markItemRead(int $uid, string $type, int $id): void
    {
        global $DB;
        $res = $DB->update(
            Inbox::TABLE,
            ['is_read' => 1, 'date_mod' => date('Y-m-d H:i:s')],
            ['users_id' => $uid, 'itemtype' => $type, 'items_id' => $id, 'is_read' => 0]
        );
        $changed = $res && $DB->affectedRows() > 0;
        if ($type === 'Ticket' && !$changed && self::isOffered($uid, $id)) {
            $now = date('Y-m-d H:i:s');
            $DB->insert(Inbox::TABLE, [
                'users_id' => $uid, 'actor_users_id' => 0, 'itemtype' => 'Ticket', 'items_id' => $id,
                'event' => Inbox::CREATED, 'channel' => 'seen', 'detail' => '', 'is_read' => 1,
                'date_creation' => $now, 'date_mod' => $now,
            ]);
            $changed = true;
        }
        if ($changed) {
            Inbox::sync($uid);
        }
    }

    /** Whether the ticket is currently in the user's New queue (unassigned, unseen). */
    private static function isOffered(int $uid, int $id): bool
    {
        foreach (self::unassigned($uid) as $t) {
            if ($t['id'] === $id) {
                return true;
            }
        }
        return false;
    }

    /** Marks every unread item of a tab as read. */
    public static function markTabRead(int $uid, string $tab): void
    {
        $list = self::list($uid);
        $done = [];
        foreach ($list['items'] as $i) {
            if ($i['is_read'] || !InboxView::inTab($i['queue'], $tab) || isset($done[$i['key']])) {
                continue;
            }
            $done[$i['key']] = true;
            [$type, $id] = explode(':', $i['key']);
            self::markItemRead($uid, $type, (int) $id);
        }
        Inbox::sync($uid);
    }

    /** Read notifications older than $days, and those of inactive or deleted users. */
    public static function purge(int $days): int
    {
        global $DB;
        $DB->delete(Inbox::TABLE, ['is_read' => 1, 'date_mod' => ['<', date('Y-m-d H:i:s', time() - $days * DAY_TIMESTAMP)]]);
        $n = $DB->affectedRows();
        $DB->delete(Inbox::TABLE, ['users_id' => new \Glpi\DBAL\QuerySubQuery([
            'SELECT' => 'id', 'FROM' => 'glpi_users', 'WHERE' => ['OR' => ['is_active' => 0, 'is_deleted' => 1]],
        ])]);
        $n += $DB->affectedRows();
        // Unread ones of users who never come back: bounded too.
        $DB->delete(Inbox::TABLE, ['date_creation' => ['<', date('Y-m-d H:i:s', time() - 6 * $days * DAY_TIMESTAMP)]]);
        return $n + $DB->affectedRows();
    }
}
