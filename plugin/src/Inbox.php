<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonDBTM;
use CommonITILActor;
use CommonITILValidation;
use Redis;
use Session;
use Throwable;

/**
 * Personal notifications ("bell"), stored in GLPI's database and pushed live.
 *
 * Recording: item hooks choose recipients among the item's actors (direct, group,
 * technicians of the entity for unassigned items, and "others" who asked for it), as the
 * Notifier+ plugin does. Rows are buffered during the request, de-duplicated, written at
 * the end of it, and the recipients' browsers are told (no content, see Events).
 *
 * Reading (InboxStore) happens in the recipient's own GLPI session: GLPI checks READ on
 * every item before its title is shown, so rights and entities always apply.
 */
final class Inbox
{
    public const TABLE = 'glpi_plugin_realtime_notifications';
    public const PREFS_TABLE = 'glpi_plugin_realtime_preferences';

    // Events (also the `kind` of the live notification).
    public const CREATED = 'created';
    public const ASSIGNED = 'assigned';
    public const COMMENTED = 'commented';
    public const TASK_ADDED = 'task_added';
    public const SOLUTION = 'solution';
    public const SOLUTION_REFUSED = 'solution_refused';
    public const STATUS_CHANGED = 'status_changed';
    public const UPDATED = 'updated';
    public const VALIDATION_ASKED = 'validation_asked';
    public const VALIDATION_DONE = 'validation_done';
    public const TRANSFERRED = 'transferred';
    /** Someone wrote "@user" (GLPI's mentions) in a description, followup, task, solution or approval. */
    public const MENTIONED = 'mentioned';
    /** A ticket assigned to the user nears its time to resolve (`sla_alert` minutes before). */
    public const TTR_SOON = 'ttr_soon';
    /** ...or passed it. */
    public const TTR_LATE = 'ttr_late';

    /** Updated fields worth a notification ("updated" event). */
    public const WATCHED_FIELDS = ['name', 'content', 'priority', 'urgency', 'impact', 'itilcategories_id', 'type', 'time_to_resolve'];

    public const ITIL = ['Ticket', 'Change', 'Problem'];
    private const TASKS = ['TicketTask' => 'Ticket', 'ChangeTask' => 'Change', 'ProblemTask' => 'Problem'];
    private const VALIDATIONS = ['TicketValidation' => 'Ticket', 'ChangeValidation' => 'Change'];
    private const USER_LINKS = ['Ticket_User' => 'Ticket', 'Change_User' => 'Change', 'Problem_User' => 'Problem'];
    private const GROUP_LINKS = ['Group_Ticket' => 'Ticket', 'Change_Group' => 'Change', 'Group_Problem' => 'Problem'];

    /** Item classes whose hooks feed the inbox. */
    public const CLASSES = [
        'Ticket', 'Change', 'Problem', 'ProjectTask', 'ProjectTaskTeam', 'ITILFollowup', 'ITILSolution',
        'TicketTask', 'ChangeTask', 'ProblemTask', 'TicketValidation', 'ChangeValidation',
        'Ticket_User', 'Change_User', 'Problem_User', 'Group_Ticket', 'Change_Group', 'Group_Problem',
    ];

    public const DEFAULT_PREFERENCES = [
        // Which notifications to receive, per item type and channel.
        'notify_ticket_direct'      => true,
        'notify_ticket_group'       => true,
        'notify_change_direct'      => true,
        'notify_change_group'       => true,
        'notify_problem_direct'     => true,
        'notify_problem_group'      => true,
        'notify_projecttask_direct' => true,
        'notify_projecttask_group'  => true,
        // Activity on items one can see without being an actor (STEAL right only).
        'notify_others'             => false,
        // "@me" in a description, followup, task, solution or approval.
        'notify_mentions'           => true,
        // Sound, globally and per queue.
        'sound_enabled'             => true,
        'sound_new'                 => true,
        'sound_mine'                => true,
        'sound_team'                => true,
        'sound_other'               => true,
        'sound_ended'               => false,
        // priority: the most important change; combined: "A + B"; multiple: "Multiple changes".
        'update_message_style'      => 'priority',
        'show_resolved'             => true,
        'show_closed'               => true,
        // separate: Resolved and Closed tabs; ended: one "Ended" tab.
        'resolved_closed_style'     => 'separate',
        // Minutes before an assigned ticket's time to resolve to be warned; '0': never.
        'sla_alert'                 => '60',
    ];

    private const CHOICES = [
        'update_message_style'  => ['priority', 'combined', 'multiple'],
        'resolved_closed_style' => ['separate', 'ended'],
        'sla_alert'             => ['0', '30', '60', '240'],
    ];

    public static ?Directory $directory = null;
    /** @internal tests: receives (rows, cleanups) instead of the database. */
    public static ?\Closure $writer = null;
    /** @internal tests: users_id => stored preferences, instead of the database. */
    public static ?\Closure $preferencesReader = null;

    /** @var array<string, array{users_id: int, itemtype: string, items_id: int, event: string, channel: string, detail: string}> */
    private static array $rows = [];
    /** Live pushes without rows (unassigned items for every technician): key => [item, event, uids]. */
    private static array $broadcasts = [];
    /** Items whose rows must go: "Ticket:5" => null (all users) or list of uids. */
    private static array $cleanups = [];
    /** Users whose inbox changed without a new notification (read state): uid => true. */
    private static array $syncs = [];
    /** @var array<int, array<string, mixed>> */
    private static array $prefsCache = [];

    private static function dir(): Directory
    {
        return self::$directory ??= new GlpiDirectory();
    }

    // ------------------------------------------------------------------ preferences

    /** @return array<string, bool|string> */
    public static function preferences(int $users_id): array
    {
        if (isset(self::$prefsCache[$users_id])) {
            return self::$prefsCache[$users_id];
        }
        $stored = [];
        if (self::$preferencesReader !== null) {
            return self::$prefsCache[$users_id] = self::cleanPreferences((self::$preferencesReader)($users_id));
        }
        try {
            global $DB;
            $row = $DB->request(['SELECT' => ['preferences'], 'FROM' => self::PREFS_TABLE, 'WHERE' => ['users_id' => $users_id]])->current();
            $stored = is_array($row) ? (json_decode((string) $row['preferences'], true) ?: []) : [];
        } catch (Throwable) {
            // Table missing (plugin not updated yet): defaults.
        }
        return self::$prefsCache[$users_id] = self::cleanPreferences($stored);
    }

    /**
     * Known keys only, with the default type; unknown values fall back to the default.
     *
     * @param array<string, mixed> $input
     * @return array<string, bool|string>
     */
    public static function cleanPreferences(array $input, array $base = self::DEFAULT_PREFERENCES): array
    {
        $out = $base;
        foreach (self::DEFAULT_PREFERENCES as $key => $default) {
            if (!array_key_exists($key, $input)) {
                continue;
            }
            if (is_bool($default)) {
                $out[$key] = filter_var($input[$key], FILTER_VALIDATE_BOOLEAN);
            } elseif (in_array($input[$key], self::CHOICES[$key], true)) {
                $out[$key] = $input[$key];
            }
        }
        return $out;
    }

    /** @param array<string, mixed> $input */
    public static function savePreferences(int $users_id, array $input): array
    {
        global $DB;
        $prefs = self::cleanPreferences($input, self::preferences($users_id));
        $DB->updateOrInsert(
            self::PREFS_TABLE,
            ['preferences' => json_encode($prefs), 'date_mod' => date('Y-m-d H:i:s')],
            ['users_id' => $users_id]
        );
        self::$prefsCache[$users_id] = $prefs;
        self::sync($users_id);
        return $prefs;
    }

    // ------------------------------------------------------------------ recording

    public static function record(CommonDBTM $item, string $action): void
    {
        self::onMentions($item, $action);
        $class = $item::class;
        $f = $item->fields;
        $updates = $item->updates;

        if (in_array($class, self::ITIL, true)) {
            self::onItil($item, $action);
        } elseif ($class === 'ITILFollowup') {
            if ($action === 'add') {
                self::onFollowup($f);
            }
        } elseif (isset(self::TASKS[$class])) {
            self::onTask(self::TASKS[$class], $f, $action, $updates);
        } elseif ($class === 'ITILSolution') {
            self::onSolution($f, $action, $updates);
        } elseif (isset(self::VALIDATIONS[$class])) {
            self::onValidation(self::VALIDATIONS[$class], $f, $action, $updates);
        } elseif (isset(self::USER_LINKS[$class]) || isset(self::GROUP_LINKS[$class])) {
            self::onActor($class, $f, $action, $updates);
        } elseif ($class === 'ProjectTask') {
            self::onProjectTask($f, $action, $updates);
        } elseif ($class === 'ProjectTaskTeam') {
            self::onProjectTaskTeam($f, $action);
        }
    }

    /**
     * Users newly mentioned ("@name", GLPI's rich text mentions) in what was added or
     * changed: told directly, whatever their role on the item. GLPI makes them observers
     * and mails them; the bell tells them at once.
     */
    private static function onMentions(CommonDBTM $item, string $action): void
    {
        if ($action !== 'add' && $action !== 'update') {
            return;
        }
        $class = $item::class;
        $f = $item->fields;
        $fields = ['content'];
        if (in_array($class, self::ITIL, true)) {
            [$type, $id, $where] = [$class, (int) ($f['id'] ?? 0), 'description'];
        } elseif ($class === 'ITILFollowup' || $class === 'ITILSolution') {
            [$type, $id, $where] = [(string) ($f['itemtype'] ?? ''), (int) ($f['items_id'] ?? 0), $class === 'ITILFollowup' ? 'followup' : 'solution'];
        } elseif (isset(self::TASKS[$class])) {
            $type = self::TASKS[$class];
            [$id, $where] = [(int) ($f[GlpiDirectory::LINKS[$type][2]] ?? 0), 'task'];
        } elseif (isset(self::VALIDATIONS[$class])) {
            $type = self::VALIDATIONS[$class];
            [$id, $where] = [(int) ($f[GlpiDirectory::LINKS[$type][2]] ?? 0), 'validation'];
            $fields = ['comment_submission', 'comment_validation'];
        } else {
            return;
        }
        if ($id <= 0 || !in_array($type, self::ITIL, true)) {
            return;
        }
        $now = [];
        $before = [];
        foreach ($fields as $field) {
            $value = (string) ($f[$field] ?? '');
            $now = [...$now, ...self::mentions($value)];
            if ($action === 'update') {
                // Unchanged field: whoever it mentions was already told.
                $old = array_key_exists($field, $item->oldvalues) ? (string) $item->oldvalues[$field] : $value;
                $before = [...$before, ...self::mentions($old)];
            }
        }
        foreach (array_diff(array_unique($now), $before) as $uid) {
            self::add($uid, $type, $id, self::MENTIONED, 'direct', ['in' => $where], $f);
        }
    }

    /**
     * Ids of the users mentioned in rich text: GLPI writes
     * `<span data-user-mention="true" data-user-id="5">@Name</span>`.
     *
     * @return list<int>
     */
    public static function mentions(string $html): array
    {
        if (!str_contains($html, 'data-user-mention')) {
            return [];
        }
        if (!str_contains($html, '<') && str_contains($html, '&lt;')) {
            $html = html_entity_decode($html, ENT_QUOTES | ENT_HTML5); // stored encoded (older GLPI)
        }
        $ids = [];
        preg_match_all('/<[a-z][^>]*\bdata-user-mention\s*=\s*["\']true["\'][^>]*>/i', $html, $tags);
        foreach ($tags[0] as $tag) {
            if (preg_match('/\bdata-user-id\s*=\s*["\']?(\d+)/i', $tag, $m) && (int) $m[1] > 0) {
                $ids[] = (int) $m[1];
            }
        }
        return array_values(array_unique($ids));
    }

    private static function author(array $f = []): int
    {
        $uid = Session::getLoginUserID();
        if (is_numeric($uid) && (int) $uid > 0) {
            return (int) $uid;
        }
        // Mail collector, cron: GLPI records who it acted for.
        return (int) ($f['users_id_lastupdater'] ?? 0);
    }

    private static function onItil(CommonDBTM $item, string $action): void
    {
        $type = $item::class;
        $f = $item->fields;
        $id = (int) ($f['id'] ?? 0);
        $updates = $item->updates;
        if ($action === 'purge' || ($action === 'delete') || ($action === 'update' && in_array('is_deleted', $updates, true) && !empty($f['is_deleted']))) {
            self::$cleanups["$type:$id"] = null; // trash or purge: off every bell
            return;
        }
        if ($action === 'add') {
            if (!self::dir()->hasAssignee($type, $id)) {
                self::broadcast($type, $id, self::CREATED, self::dir()->technicians((int) ($f['entities_id'] ?? 0)), $f);
            } else {
                self::toActors($type, $id, self::CREATED, [], $f, others: false);
            }
            return;
        }
        if ($action !== 'update') {
            return;
        }
        if (in_array('entities_id', $updates, true)) {
            $entity = (int) ($f['entities_id'] ?? 0);
            if (!self::dir()->hasAssignee($type, $id)) {
                self::broadcast($type, $id, self::TRANSFERRED, self::dir()->technicians($entity), $f);
            } else {
                self::toActors($type, $id, self::TRANSFERRED, [], $f, entity: $entity);
            }
            return;
        }
        if (in_array('status', $updates, true)) {
            self::toActors($type, $id, self::STATUS_CHANGED, ['status' => (int) ($f['status'] ?? 0)], $f);
            return;
        }
        $fields = array_values(array_intersect(self::WATCHED_FIELDS, $updates));
        if ($fields !== []) {
            self::toActors($type, $id, self::UPDATED, ['fields' => $fields], $f);
        }
    }

    private static function onFollowup(array $f): void
    {
        $type = (string) ($f['itemtype'] ?? '');
        $id = (int) ($f['items_id'] ?? 0);
        if (!in_array($type, self::ITIL, true)) {
            return;
        }
        // Private: technicians assigned only, never requesters or observers.
        $private = !empty($f['is_private']);
        self::toActors($type, $id, self::COMMENTED, [], $f, assigneesOnly: $private, others: !$private);
    }

    private static function onTask(string $type, array $f, string $action, array $updates): void
    {
        $fk = GlpiDirectory::LINKS[$type][2];
        $id = (int) ($f[$fk] ?? 0);
        $tech = (int) ($f['users_id_tech'] ?? 0);
        $private = !empty($f['is_private']);
        if ($action === 'add') {
            self::toActors($type, $id, self::TASK_ADDED, [], $f, assigneesOnly: $private, others: !$private);
        }
        // The technician of the task is always told, directly.
        if ($tech > 0 && ($action === 'add' || ($action === 'update' && in_array('users_id_tech', $updates, true)))) {
            self::add($tech, $type, $id, self::TASK_ADDED, 'direct', [], $f);
        }
    }

    private static function onSolution(array $f, string $action, array $updates): void
    {
        $type = (string) ($f['itemtype'] ?? '');
        $id = (int) ($f['items_id'] ?? 0);
        if (!in_array($type, self::ITIL, true)) {
            return;
        }
        if ($action === 'add') {
            self::toActors($type, $id, self::SOLUTION, [], $f);
        } elseif ($action === 'update' && in_array('status', $updates, true) && (int) ($f['status'] ?? 0) === CommonITILValidation::REFUSED) {
            // The requester refused it: technicians must act. Supersedes the status change.
            self::toActors($type, $id, self::SOLUTION_REFUSED, [], $f, assigneesOnly: true, others: false);
        }
    }

    private static function onValidation(string $type, array $f, string $action, array $updates): void
    {
        $fk = GlpiDirectory::LINKS[$type][2];
        $id = (int) ($f[$fk] ?? 0);
        $status = (int) ($f['status'] ?? 0);
        if ($action === 'add') {
            $target = (int) ($f['items_id_target'] ?? $f['users_id_validate'] ?? 0);
            if (($f['itemtype_target'] ?? 'User') === 'Group') {
                foreach (self::dir()->groupMembers($target) as $uid) {
                    self::add($uid, $type, $id, self::VALIDATION_ASKED, 'group', [], $f);
                }
            } else {
                self::add($target, $type, $id, self::VALIDATION_ASKED, 'direct', [], $f);
            }
        } elseif ($action === 'update' && in_array('status', $updates, true)
            && in_array($status, [CommonITILValidation::ACCEPTED, CommonITILValidation::REFUSED], true)) {
            self::toActors($type, $id, self::VALIDATION_DONE, ['status' => $status], $f, others: false);
        }
    }

    private static function onActor(string $class, array $f, string $action, array $updates): void
    {
        $type = self::USER_LINKS[$class] ?? self::GROUP_LINKS[$class];
        $id = (int) ($f[GlpiDirectory::LINKS[$type][2]] ?? 0);
        $isUser = isset(self::USER_LINKS[$class]);
        $members = $isUser ? [(int) ($f['users_id'] ?? 0)] : self::dir()->groupMembers((int) ($f['groups_id'] ?? 0));

        if ($action === 'purge') {
            // No longer an actor (by any other way): their notifications on it go.
            $still = self::dir()->actors($type, $id);
            $gone = array_values(array_filter($members, static fn(int $u) => $u > 0 && !isset($still[$u])));
            if ($gone !== []) {
                self::$cleanups["$type:$id"] = array_merge(self::$cleanups["$type:$id"] ?? [], $gone);
            }
            return;
        }
        $assigned = (int) ($f['type'] ?? 0) === CommonITILActor::ASSIGN;
        if ($assigned && ($action === 'add' || ($action === 'update' && in_array('type', $updates, true)))) {
            foreach ($members as $uid) {
                self::add($uid, $type, $id, self::ASSIGNED, $isUser ? 'direct' : 'group', [], $f);
            }
        }
    }

    private static function onProjectTask(array $f, string $action, array $updates): void
    {
        $id = (int) ($f['id'] ?? 0);
        if ($action === 'purge' || $action === 'delete') {
            self::$cleanups["ProjectTask:$id"] = null;
            return;
        }
        if ($action === 'add') {
            $event = self::CREATED;
            $detail = [];
        } elseif ($action === 'update' && array_intersect(['projectstates_id', 'percent_done'], $updates) !== []) {
            $event = self::STATUS_CHANGED;
            $detail = [];
        } elseif ($action === 'update' && ($fields = array_values(array_intersect(['name', 'content', 'plan_start_date', 'plan_end_date'], $updates))) !== []) {
            $event = self::UPDATED;
            $detail = ['fields' => $fields];
        } else {
            return;
        }
        foreach (self::dir()->projectTaskMembers($id) as $uid => $channel) {
            self::add($uid, 'ProjectTask', $id, $event, $channel, $detail, $f);
        }
    }

    private static function onProjectTaskTeam(array $f, string $action): void
    {
        if ($action !== 'add') {
            return;
        }
        $task = (int) ($f['projecttasks_id'] ?? 0);
        $member = (int) ($f['items_id'] ?? 0);
        if (($f['itemtype'] ?? '') === 'User') {
            self::add($member, 'ProjectTask', $task, self::ASSIGNED, 'direct', [], $f);
        } elseif (($f['itemtype'] ?? '') === 'Group') {
            foreach (self::dir()->groupMembers($member) as $uid) {
                self::add($uid, 'ProjectTask', $task, self::ASSIGNED, 'group', [], $f);
            }
        }
    }

    /** Every actor of the item (or its assignees), then "others" who asked for it. */
    private static function toActors(
        string $type,
        int $id,
        string $event,
        array $detail,
        array $f,
        bool $assigneesOnly = false,
        bool $others = true,
        ?int $entity = null,
    ): void {
        if ($id <= 0) {
            return;
        }
        $actors = self::dir()->actors($type, $id);
        foreach ($actors as $uid => $a) {
            if ($assigneesOnly && !in_array(CommonITILActor::ASSIGN, $a['types'], true)) {
                continue;
            }
            self::add($uid, $type, $id, $event, $a['channel'], $detail, $f);
        }
        if ($others) {
            $entity ??= self::dir()->entityOf($type, $id);
            foreach (self::dir()->others($type, $entity) as $uid) {
                if (!isset($actors[$uid])) {
                    self::add($uid, $type, $id, $event, 'other', $detail, $f);
                }
            }
        }
    }

    private static function add(int $uid, string $type, int $id, string $event, string $channel, array $detail, array $f, bool $system = false): void
    {
        if ($uid <= 0 || $id <= 0 || (!$system && $uid === self::author($f))) {
            return; // nobody is told about what they did themselves (GLPI's own alerts have no author)
        }
        $key = "$uid|$type|$id|$event";
        // A user reached in several ways keeps the most personal channel.
        $rank = ['direct' => 3, 'group' => 2, 'other' => 1];
        if (isset(self::$rows[$key]) && $rank[self::$rows[$key]['channel']] >= $rank[$channel]) {
            return;
        }
        self::$rows[$key] = [
            'users_id' => $uid,
            'itemtype' => $type,
            'items_id' => $id,
            'event'    => $event,
            'channel'  => $channel,
            'detail'   => $detail === [] ? '' : json_encode($detail),
        ];
        Events::ensureFlush();
    }

    /** Unassigned items: no row per technician (thousands), they are listed when read. */
    private static function broadcast(string $type, int $id, string $event, array $uids, array $f): void
    {
        $author = self::author($f);
        $uids = array_values(array_filter($uids, static fn(int $u) => $u > 0 && $u !== $author));
        if ($uids !== []) {
            self::$broadcasts["$type:$id:$event"] = ["$type:$id", $event, $uids];
            Events::ensureFlush();
        }
    }

    /** The user's inbox changed without a new notification (read, preferences): other tabs refresh. */
    public static function sync(int $users_id): void
    {
        self::$syncs[$users_id] = true;
        Events::ensureFlush();
    }

    /**
     * Rows to insert, after de-duplication within the request.
     *
     * @return list<array<string, mixed>>
     */
    public static function pendingRows(): array
    {
        $rows = self::$rows;
        $byItem = [];
        foreach ($rows as $key => $r) {
            $byItem["{$r['users_id']}|{$r['itemtype']}|{$r['items_id']}"][$r['event']] = $key;
        }
        foreach ($byItem as $events) {
            // "Created" says less than "assigned to you"; a refused solution explains the status change.
            if (isset($events[self::ASSIGNED], $events[self::CREATED])) {
                unset($rows[$events[self::CREATED]]);
            }
            if (isset($events[self::SOLUTION_REFUSED], $events[self::STATUS_CHANGED])) {
                unset($rows[$events[self::STATUS_CHANGED]]);
            }
        }
        return array_values($rows);
    }

    /**
     * Writes the request's notifications and returns the live pushes to publish:
     * list of [item, event, uids, sync].
     *
     * @return list<array{0: string, 1: string, 2: list<int>, 3: bool}>
     */
    public static function flush(?callable $insert = null): array
    {
        $rows = self::pendingRows();
        $broadcasts = self::$broadcasts;
        $cleanups = self::$cleanups;
        $syncs = self::$syncs;
        self::$rows = self::$broadcasts = self::$cleanups = self::$syncs = [];

        $insert ??= self::$writer ?? [InboxStore::class, 'write'];
        $insert($rows, $cleanups);

        $pushes = [];
        $grouped = [];
        foreach ($rows as $r) {
            $grouped["{$r['itemtype']}:{$r['items_id']}|{$r['event']}"][] = $r['users_id'];
            unset($syncs[$r['users_id']]); // told anyway
        }
        foreach ($grouped as $key => $uids) {
            [$item, $event] = explode('|', $key);
            $pushes[] = [$item, $event, $uids, false];
        }
        foreach ($broadcasts as [$item, $event, $uids]) {
            $pushes[] = [$item, $event, $uids, false];
        }
        foreach ($cleanups as $item => $uids) {
            // Someone's bell may show an item that left it.
            if (is_array($uids)) {
                foreach ($uids as $u) {
                    $syncs[$u] = true;
                }
            }
        }
        if ($syncs !== []) {
            $pushes[] = ['', 'inbox', array_keys($syncs), true];
        }
        return $pushes;
    }

    // ------------------------------------------------------------------ cron

    /** @return array{description: string, parameter?: string} */
    public static function cronInfo(string $name): array
    {
        if ($name === 'slaalert') {
            return ['description' => 'Warn assigned technicians of tickets nearing or past their time to resolve'];
        }
        return [
            'description' => 'Purge read notifications and those of inactive users',
            'parameter'   => 'Days a read notification is kept',
        ];
    }

    /** The longest `sla_alert` choice, in seconds: how far ahead tickets are looked at. */
    private const SLA_HORIZON = 240 * 60;

    /**
     * Assigned technicians (direct, or through an assigned group) of tickets nearing their
     * time to resolve (within their `sla_alert` preference) or past it (within a day: an
     * old backlog is not announced at once), once per ticket, event and time to resolve
     * (a new one after a change of SLA warns again). Returns the notifications added.
     */
    public static function slaAlerts(int $now): int
    {
        $added = 0;
        foreach (self::dir()->dueTickets($now - DAY_TIMESTAMP, $now + self::SLA_HORIZON) as $id => $ttr) {
            $event = $ttr <= $now ? self::TTR_LATE : self::TTR_SOON;
            $detail = ['ttr' => $ttr];
            $done = array_flip(self::dir()->notified('Ticket', $id, $event, (string) json_encode($detail)));
            foreach (self::dir()->actors('Ticket', $id) as $uid => $a) {
                if (!in_array(CommonITILActor::ASSIGN, $a['types'], true) || isset($done[$uid])) {
                    continue;
                }
                $minutes = (int) self::preferences($uid)['sla_alert'];
                if ($minutes <= 0 || ($event === self::TTR_SOON && $ttr - $now > $minutes * 60)) {
                    continue;
                }
                self::add($uid, 'Ticket', $id, $event, $a['channel'], $detail, [], system: true);
                $added++;
            }
        }
        return $added;
    }

    public static function cronSlaalert(\CronTask $task): int
    {
        $task->addVolume(self::slaAlerts(time()));
        // Written and published now: GLPI's command line does not always run shutdown
        // functions after an automatic action (the alerts were counted, never stored).
        Events::flush();
        return 1;
    }

    public static function cronInboxpurge(\CronTask $task): int
    {
        $days = max(1, (int) ($task->fields['param'] ?? 30));
        $n = InboxStore::purge($days);
        $task->addVolume($n);
        return 1;
    }

    /** @internal tests */
    public static function reset(): void
    {
        self::$rows = self::$broadcasts = self::$cleanups = self::$syncs = self::$prefsCache = [];
    }
}
