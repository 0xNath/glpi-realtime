<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonDBTM;
use Redis;
use Session;
use Throwable;

/**
 * Live item events and user notifications, published on the Valkey channel `rt:ev`.
 *
 * - Item hooks (`item_add`, `item_update`, ...) record what changed during the request;
 *   everything is published once, at the end of the request, one message per item.
 * - Events carry no content: a kind (`followup.add`, `item.update`), the sub-item id, the
 *   names of the changed fields. Tickets, changes and problems alike. Browsers reload from GLPI, which applies its own rights.
 * - Each event says who may see it (`vis`), mirroring GLPI's `canViewItem()`; the server
 *   checks it against each session's grant flags.
 * - When rights on the item may have shrunk (actor removed or changed, entity moved),
 *   every grant on it is deleted and the batch is marked `regrant`.
 * - Personal notifications are recorded by Inbox; this class publishes the live push
 *   telling their recipients' browsers to refresh their bell (user ids only).
 *
 * Like every Valkey access of the plugin, publishing fails open.
 */
final class Events
{
    /** Hook name => method. */
    public const HOOKS = [
        'item_add'     => 'onAdd',
        'item_update'  => 'onUpdate',
        'item_delete'  => 'onDelete',
        'item_restore' => 'onRestore',
        'item_purge'   => 'onPurge',
    ];

    /** ITIL objects: one room each (`Ticket:5`, `Change:3`, `Problem:7`). */
    public const ITIL = ['Ticket', 'Change', 'Problem'];

    /** Tasks and approvals => [parent type, foreign key]. */
    private const TASKS = ['TicketTask' => ['Ticket', 'tickets_id'], 'ChangeTask' => ['Change', 'changes_id'], 'ProblemTask' => ['Problem', 'problems_id']];
    private const VALIDATIONS = ['TicketValidation' => ['Ticket', 'tickets_id'], 'ChangeValidation' => ['Change', 'changes_id']];

    /** Actor links (users, groups, suppliers) => [parent type, foreign key]. */
    private const ACTORS = [
        'Ticket_User' => ['Ticket', 'tickets_id'], 'Group_Ticket' => ['Ticket', 'tickets_id'], 'Supplier_Ticket' => ['Ticket', 'tickets_id'],
        'Change_User' => ['Change', 'changes_id'], 'Change_Group' => ['Change', 'changes_id'], 'Change_Supplier' => ['Change', 'changes_id'],
        'Problem_User' => ['Problem', 'problems_id'], 'Group_Problem' => ['Problem', 'problems_id'], 'Problem_Supplier' => ['Problem', 'problems_id'],
    ];

    /** Item classes whose changes are announced. */
    public const CLASSES = [
        ...self::ITIL, 'ITILFollowup', 'ITILSolution', 'Document_Item',
        'TicketTask', 'ChangeTask', 'ProblemTask', 'TicketValidation', 'ChangeValidation',
        'Ticket_User', 'Group_Ticket', 'Supplier_Ticket',
        'Change_User', 'Change_Group', 'Change_Supplier',
        'Problem_User', 'Group_Problem', 'Problem_Supplier',
    ];

    /** Updated fields that are not worth telling anyone about. */
    private const NOISE = ['date_mod', 'date_creation', 'users_id_lastupdater', 'actiontime'];

    /** Limits enforced by the server (events::MAX_EVENTS_PER_BATCH). */
    private const MAX_PER_MESSAGE = 64;
    private const MAX_RECIPIENTS = 1000;

    /** @var array<string, array{regrant: bool, events: list<array<string, mixed>>}> */
    private static array $pending = [];
    private static bool $flushRegistered = false;

    /** @internal tests: publish only on explicit flush(). */
    public static bool $autoFlush = true;

    /** @return array<string, array<string, callable>> hook => [class => callable] */
    public static function hooks(): array
    {
        $out = [];
        foreach (self::HOOKS as $hook => $method) {
            // Other enabled items (projects, assets...): changes to the item itself.
            foreach (array_unique([...self::CLASSES, ...Inbox::CLASSES, ...RightsWatch::CLASSES, ...Settings::enabledItemtypes()]) as $class) {
                $out[$hook][$class] = [self::class, $method];
            }
        }
        return $out;
    }

    public static function onAdd(mixed $item): void
    {
        SolutionGuard::onAdd($item);
        self::safely($item, 'add');
    }

    public static function onUpdate(mixed $item): void
    {
        self::safely($item, 'update');
    }

    public static function onDelete(mixed $item): void
    {
        self::safely($item, 'delete');
    }

    public static function onRestore(mixed $item): void
    {
        self::safely($item, 'restore');
    }

    public static function onPurge(mixed $item): void
    {
        self::safely($item, 'purge');
    }

    private static function safely(mixed $item, string $action): void
    {
        if (!$item instanceof CommonDBTM) {
            return;
        }
        // Never break a GLPI request for a live update or a notification.
        try {
            self::record($item, $action);
        } catch (Throwable $e) {
            \Toolbox::logInFile('realtime', 'event not recorded: ' . $e->getMessage() . "\n");
        }
        try {
            Inbox::record($item, $action);
        } catch (Throwable $e) {
            \Toolbox::logInFile('realtime', 'notification not recorded: ' . $e->getMessage() . "\n");
        }
        try {
            RightsWatch::record($item, $action);
        } catch (Throwable $e) {
            \Toolbox::logInFile('realtime', 'rights change not recorded: ' . $e->getMessage() . "\n");
        }
    }

    public static function record(CommonDBTM $item, string $action): void
    {
        $f = $item->fields;
        $id = (int) ($f['id'] ?? 0);
        // Sub-items are purged, not trashed: a purge is what users call a deletion.
        $sub = $action === 'purge' ? 'delete' : $action;

        $class = $item::class;

        // The item itself (any enabled type): field changes, trash, restore, purge.
        if (in_array($class, self::ITIL, true) || in_array($class, Settings::enabledItemtypes(), true)) {
            if ($action === 'add') {
                return; // nobody is on an item that did not exist
            }
            $room = self::room($class, $id);
            if ($action === 'update') {
                $fields = array_values(array_diff($item->updates, self::NOISE));
                if ($fields !== []) {
                    self::event($room, ['kind' => 'item.update', 'fields' => $fields], in_array('entities_id', $fields, true));
                }
                return;
            }
            self::event($room, ['kind' => 'item.' . $action]);
            return;
        }

        if ($class === 'ITILFollowup') {
            $room = self::itilRoom((string) ($f['itemtype'] ?? ''), (int) ($f['items_id'] ?? 0));
            $private = (bool) ($f['is_private'] ?? false);
            self::event($room, [
                'kind' => 'followup.' . $sub,
                'item' => ['type' => 'ITILFollowup', 'id' => $id],
                'vis'  => ['right' => 'followup', 'private' => $private, 'uids' => self::ids([$f['users_id'] ?? 0])],
            ]);
            return;
        }

        if (isset(self::TASKS[$class])) {
            [$parent, $fk] = self::TASKS[$class];
            $tech = (int) ($f['users_id_tech'] ?? 0);
            self::event(self::itilRoom($parent, (int) ($f[$fk] ?? 0)), [
                'kind' => 'task.' . $sub,
                'item' => ['type' => $class, 'id' => $id],
                'vis'  => [
                    'right'   => 'task',
                    'private' => (bool) ($f['is_private'] ?? false),
                    'uids'    => self::ids([$f['users_id'] ?? 0, $tech]),
                    'groups'  => self::ids([$f['groups_id_tech'] ?? 0]),
                ],
            ]);
            return;
        }

        if ($class === 'ITILSolution') {
            $room = self::itilRoom((string) ($f['itemtype'] ?? ''), (int) ($f['items_id'] ?? 0));
            self::event($room, ['kind' => 'solution.' . $sub, 'item' => ['type' => 'ITILSolution', 'id' => $id]]);
            return;
        }

        if (isset(self::VALIDATIONS[$class])) {
            [$parent, $fk] = self::VALIDATIONS[$class];
            self::event(self::itilRoom($parent, (int) ($f[$fk] ?? 0)), ['kind' => 'validation.' . $sub, 'item' => ['type' => $class, 'id' => $id]]);
            return;
        }

        if ($class === 'Document_Item') {
            // Documents of followups and tasks are announced with them.
            $parent = (string) ($f['itemtype'] ?? '');
            if (!in_array($parent, self::ITIL, true)) {
                return;
            }
            self::event(self::itilRoom($parent, (int) ($f['items_id'] ?? 0)), ['kind' => 'document.' . $sub, 'item' => ['type' => 'Document', 'id' => (int) ($f['documents_id'] ?? 0)]]);
            return;
        }

        if (isset(self::ACTORS[$class])) {
            [$parent, $fk] = self::ACTORS[$class];
            if ($action === 'update' && !in_array('type', $item->updates, true)) {
                return; // e.g. notification settings of the actor
            }
            // Removing or demoting an actor may remove their access: grants are recomputed.
            self::event(self::itilRoom($parent, (int) ($f[$fk] ?? 0)), ['kind' => 'actor.' . $sub], $action !== 'add');
        }
    }

    /** Room of a ticket, change or problem (followups, tasks... belong to those only). */
    private static function itilRoom(string $itemtype, int $id): ?string
    {
        return in_array($itemtype, self::ITIL, true) ? self::room($itemtype, $id) : null;
    }

    /** Room of an enabled item, or null when its type is not enabled. */
    private static function room(string $itemtype, int $id): ?string
    {
        return $id > 0 && in_array($itemtype, Settings::enabledItemtypes(), true) ? $itemtype . ':' . $id : null;
    }

    /** @param array<string, mixed> $event */
    private static function event(?string $room, array $event, bool $regrant = false): void
    {
        if ($room === null) {
            return;
        }
        $b = &self::batch($room);
        $b['regrant'] = $b['regrant'] || $regrant;
        // One `item.update` per request, with every changed field.
        if ($event['kind'] === 'item.update') {
            foreach ($b['events'] as &$e) {
                if ($e['kind'] === 'item.update') {
                    $e['fields'] = array_values(array_unique([...$e['fields'], ...$event['fields']]));
                    return;
                }
            }
            unset($e);
        }
        $b['events'][] = $event;
    }

    /** @return array{regrant: bool, events: list<array<string, mixed>>} */
    private static function &batch(string $room): array
    {
        if (!isset(self::$pending[$room])) {
            self::$pending[$room] = ['regrant' => false, 'events' => []];
        }
        self::ensureFlush();
        return self::$pending[$room];
    }

    /** Publishes at the end of the request (after GLPI's writes and redirect). */
    public static function ensureFlush(): void
    {
        if (self::$autoFlush && !self::$flushRegistered) {
            self::$flushRegistered = true;
            register_shutdown_function([self::class, 'flush']);
        }
    }

    /** Writes the notifications and publishes what the request recorded. Called at shutdown. */
    public static function flush(): void
    {
        $pending = self::$pending;
        self::$pending = [];
        self::$flushRegistered = false;
        $pushes = [];
        try {
            $pushes = Inbox::flush();
        } catch (Throwable $e) {
            \Toolbox::logInFile('realtime', 'notifications not written: ' . $e->getMessage() . "\n");
        }
        $rights = RightsWatch::pending();
        if ($pending === [] && $pushes === [] && $rights['regrant'] === [] && $rights['revoke'] === []) {
            return;
        }
        $uid = Session::getLoginUserID();
        $by = [
            'id'   => is_numeric($uid) ? (int) $uid : 0, // 0: cron, mail collector
            'name' => (string) ($_SESSION['glpifriendlyname'] ?? $_SESSION['glpiname'] ?? ''),
        ];
        // How the author appears to self-service users when agents are anonymized.
        $anon = $by['id'] > 0 ? SessionToken::anonymous($by['id']) : null;
        if ($anon !== null) {
            $by['anon'] = $anon;
        }
        Valkey::run(function (Redis $r) use ($pending, $pushes, $by) {
            foreach ($pending as $room => $b) {
                if ($b['regrant']) {
                    Grants::revokeAll($r, $room);
                }
                foreach (self::messages($room, $by, $b) as $message) {
                    $r->publish(Valkey::key('ev'), $message);
                }
            }
            foreach (self::notices($by, $pushes) as $message) {
                $r->publish(Valkey::key('ev'), $message);
            }
            // Rights changed: only the sessions concerned get new grants.
            foreach (RightsWatch::flush($r) as $room => $hashes) {
                foreach (array_chunk(array_values(array_unique($hashes)), self::MAX_RECIPIENTS) as $chunk) {
                    $r->publish(Valkey::key('ev'), json_encode(['room' => $room, 'by' => $by, 'regrant' => true, 'sessions' => $chunk]));
                }
            }
        });
    }

    /**
     * Live pushes of the inbox, without room: "your bell changed" (`sync`: read state,
     * no alert) or "you have a new notification" (kind = event, item = "Ticket:5").
     *
     * @param array{id: int, name: string} $by
     * @param list<array{0: string, 1: string, 2: list<int>, 3: bool}> $pushes
     * @return list<string>
     */
    public static function notices(array $by, array $pushes): array
    {
        // GLPI's own alerts (time to resolve) have no author: never withheld from the user
        // whose request happened to run the cron task.
        $system = [Inbox::TTR_SOON => true, Inbox::TTR_LATE => true];
        $groups = [];
        foreach ($pushes as [$item, $kind, $uids, $sync]) {
            $g = isset($system[$kind]) ? 'system' : 'by';
            foreach (array_chunk(array_values(array_unique($uids)), self::MAX_RECIPIENTS) as $to) {
                $groups[$g][] = array_filter(['to' => $to, 'kind' => $kind, 'item' => $item, 'sync' => $sync]);
            }
        }
        $out = [];
        foreach ($groups as $g => $notify) {
            $author = $g === 'system' ? ['id' => 0, 'name' => ''] : $by;
            foreach (array_chunk($notify, self::MAX_PER_MESSAGE) as $chunk) {
                $out[] = json_encode(['by' => $author, 'notify' => $chunk], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            }
        }
        return $out;
    }

    /**
     * Encoded batches for one room, split to respect the server limits.
     *
     * @param array{id: int, name: string} $by
     * @param array{regrant: bool, events: list<array<string, mixed>>} $b
     * @return list<string>
     */
    public static function messages(string $room, array $by, array $b): array
    {
        $out = [];
        $events = array_chunk($b['events'], self::MAX_PER_MESSAGE) ?: [[]];
        foreach ($events as $i => $chunk) {
            $out[] = json_encode([
                'room'    => $room,
                'by'      => $by,
                'regrant' => $i === 0 && $b['regrant'],
                'events'  => $chunk,
            ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        }
        return $out;
    }

    /**
     * @param array<mixed> $values
     * @return list<int> distinct positive ids
     */
    private static function ids(array $values): array
    {
        return array_values(array_unique(array_filter(array_map('intval', $values), static fn(int $v) => $v > 0)));
    }

    /** @internal tests */
    public static function pending(): array
    {
        return self::$pending;
    }
}
