<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonITILObject;

/** Pure rules of the bell: preference filter, queues, counters. */
final class InboxView
{
    public const QUEUES = ['new', 'mine', 'team', 'other', 'resolved', 'closed'];

    /** Rows hidden by the user's "which notifications" preferences. */
    public static function wanted(array $row, array $prefs): bool
    {
        if (($row['event'] ?? '') === Inbox::MENTIONED) {
            return (bool) ($prefs['notify_mentions'] ?? true);
        }
        $slug = strtolower((string) $row['itemtype']);
        $channel = (string) $row['channel'];
        if (in_array($channel, ['direct', 'group'], true)) {
            return (bool) ($prefs["notify_{$slug}_{$channel}"] ?? true);
        }
        if ($channel === 'other') {
            return (bool) $prefs['notify_others'];
        }
        return true; // broadcast / seen
    }

    /**
     * Queue of an item for the user.
     *
     * @param array{status?: int, assigned_users?: list<int>, assigned_groups?: list<int>} $object
     * @param list<int> $myGroups
     */
    public static function queue(string $itemtype, array $object, string $channel, int $uid, array $myGroups): string
    {
        if (!in_array($itemtype, Inbox::ITIL, true)) {
            return match ($channel) {
                'direct' => 'mine',
                'group'  => 'team',
                default  => 'other',
            };
        }
        $status = (int) ($object['status'] ?? 0);
        if ($status === CommonITILObject::CLOSED) {
            return 'closed';
        }
        if ($status === CommonITILObject::SOLVED) {
            return 'resolved';
        }
        $users = $object['assigned_users'] ?? [];
        $groups = $object['assigned_groups'] ?? [];
        if ($users === [] && $groups === []) {
            return 'new';
        }
        if (in_array($uid, $users, true)) {
            return 'mine';
        }
        if (array_intersect($groups, $myGroups) !== []) {
            return 'team';
        }
        return 'other';
    }

    /**
     * Unread items (not notifications) per queue, and in total, after the display
     * preferences (resolved/closed shown or not).
     *
     * @param list<array{key: string, queue: string, is_read: bool}> $items
     * @return array<string, int>
     */
    public static function counts(array $items, array $prefs): array
    {
        $seen = [];
        foreach ($items as $i) {
            if (!$i['is_read'] && self::visible($i['queue'], $prefs)) {
                $seen[$i['queue']][$i['key']] = true;
            }
        }
        $out = ['all' => 0];
        foreach (self::QUEUES as $q) {
            $out[$q] = count($seen[$q] ?? []);
        }
        $all = [];
        foreach ($seen as $keys) {
            $all += $keys;
        }
        $out['all'] = count($all);
        $out['ended'] = $out['resolved'] + $out['closed'];
        return $out;
    }

    public static function visible(string $queue, array $prefs): bool
    {
        return match ($queue) {
            'resolved' => (bool) $prefs['show_resolved'],
            'closed'   => (bool) $prefs['show_closed'],
            default    => true,
        };
    }

    /** Items of a tab ("ended" is resolved + closed). */
    public static function inTab(string $queue, string $tab): bool
    {
        return $tab === 'all' || $queue === $tab || ($tab === 'ended' && in_array($queue, ['resolved', 'closed'], true));
    }
}
