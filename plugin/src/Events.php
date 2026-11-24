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
 * - Events carry no content: a kind (`followup.add`), the sub-item id, the names of the
 *   changed fields. Browsers reload from GLPI, which applies its own rights.
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

    /** Item classes whose changes are announced. */
    public const CLASSES = [
        'Ticket', 'ITILFollowup', 'TicketTask', 'ITILSolution', 'TicketValidation',
        'Document_Item', 'Ticket_User', 'Group_Ticket', 'Supplier_Ticket',
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
            foreach (array_unique([...self::CLASSES, ...Inbox::CLASSES]) as $class) {
                $out[$hook][$class] = [self::class, $method];
            }
        }
        return $out;
    }

    public static function onAdd(mixed $item): void
    {
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
    }

    public static function record(CommonDBTM $item, string $action): void
    {
        $f = $item->fields;
        $id = (int) ($f['id'] ?? 0);
        // Sub-items are purged, not trashed: a purge is what users call a deletion.
        $sub = $action === 'purge' ? 'delete' : $action;

        switch ($item::class) {
            case 'Ticket':
                if ($action === 'add') {
                    return; // nobody is on a ticket that did not exist
                }
                $room = 'Ticket:' . $id;
                if ($action === 'update') {
                    $fields = array_values(array_diff($item->updates, self::NOISE));
                    if ($fields === []) {
                        return;
                    }
                    self::event($room, ['kind' => 'ticket.update', 'fields' => $fields], in_array('entities_id', $fields, true));
                    return;
                }
                self::event($room, ['kind' => 'ticket.' . $action]);
                return;

            case 'ITILFollowup':
                $room = self::room((string) ($f['itemtype'] ?? ''), (int) ($f['items_id'] ?? 0));
                $private = (bool) ($f['is_private'] ?? false);
                self::event($room, [
                    'kind' => 'followup.' . $sub,
                    'item' => ['type' => 'ITILFollowup', 'id' => $id],
                    'vis'  => ['right' => 'followup', 'private' => $private, 'uids' => self::ids([$f['users_id'] ?? 0])],
                ]);
                return;

            case 'TicketTask':
                $room = self::room('Ticket', (int) ($f['tickets_id'] ?? 0));
                $tech = (int) ($f['users_id_tech'] ?? 0);
                self::event($room, [
                    'kind' => 'task.' . $sub,
                    'item' => ['type' => 'TicketTask', 'id' => $id],
                    'vis'  => [
                        'right'   => 'task',
                        'private' => (bool) ($f['is_private'] ?? false),
                        'uids'    => self::ids([$f['users_id'] ?? 0, $tech]),
                        'groups'  => self::ids([$f['groups_id_tech'] ?? 0]),
                    ],
                ]);
                return;

            case 'ITILSolution':
                $room = self::room((string) ($f['itemtype'] ?? ''), (int) ($f['items_id'] ?? 0));
                self::event($room, ['kind' => 'solution.' . $sub, 'item' => ['type' => 'ITILSolution', 'id' => $id]]);
                return;

            case 'TicketValidation':
                $room = self::room('Ticket', (int) ($f['tickets_id'] ?? 0));
                self::event($room, ['kind' => 'validation.' . $sub, 'item' => ['type' => 'TicketValidation', 'id' => $id]]);
                return;

            case 'Document_Item':
                // Documents of followups and tasks are announced with them.
                if (($f['itemtype'] ?? '') !== 'Ticket') {
                    return;
                }
                $room = self::room('Ticket', (int) ($f['items_id'] ?? 0));
                self::event($room, ['kind' => 'document.' . $sub, 'item' => ['type' => 'Document', 'id' => (int) ($f['documents_id'] ?? 0)]]);
                return;

            case 'Ticket_User':
            case 'Group_Ticket':
            case 'Supplier_Ticket':
                $room = self::room('Ticket', (int) ($f['tickets_id'] ?? 0));
                if ($action === 'update' && !in_array('type', $item->updates, true)) {
                    return; // e.g. notification settings of the actor
                }
                // Removing or demoting an actor may remove their access: grants are recomputed.
                self::event($room, ['kind' => 'actor.' . $sub], $action !== 'add');
                return;
        }
    }

    /** Room of an ITIL object, or null when its type is not enabled. */
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
        // One `ticket.update` per request, with every changed field.
        if ($event['kind'] === 'ticket.update') {
            foreach ($b['events'] as &$e) {
                if ($e['kind'] === 'ticket.update') {
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
        if ($pending === [] && $pushes === []) {
            return;
        }
        $uid = Session::getLoginUserID();
        $by = [
            'id'   => is_numeric($uid) ? (int) $uid : 0, // 0: cron, mail collector
            'name' => (string) ($_SESSION['glpifriendlyname'] ?? $_SESSION['glpiname'] ?? ''),
        ];
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
        $notify = [];
        foreach ($pushes as [$item, $kind, $uids, $sync]) {
            foreach (array_chunk(array_values(array_unique($uids)), self::MAX_RECIPIENTS) as $to) {
                $notify[] = array_filter(['to' => $to, 'kind' => $kind, 'item' => $item, 'sync' => $sync]);
            }
        }
        return array_map(
            static fn(array $chunk) => json_encode(['by' => $by, 'notify' => $chunk], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            array_chunk($notify, self::MAX_PER_MESSAGE)
        );
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
