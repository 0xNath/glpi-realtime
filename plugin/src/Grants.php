<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonDBTM;
use CommonITILObject;
use CommonITILTask;
use ITILFollowup;
use Redis;
use Session;

/**
 * Per-item rights, computed by GLPI and written to Valkey for the Rust server:
 * `rt:g:{token_hash}:{Itemtype}:{id}` => flags ("0"/"1").
 *
 * The server lets a connection subscribe to a room only if this key exists with read=1,
 * and filters the item's events with the other flags. The key lives as long as the
 * session token. `rt:gi:{Itemtype}:{id}` indexes the sessions holding a grant on the
 * item, so that every grant can be revoked when rights on it change (see Events).
 */
final class Grants
{
    /** Hook post_item_form: ['item' => CommonDBTM, 'options' => array]. */
    public static function onPostItemForm(mixed $params): void
    {
        $item = is_array($params) ? ($params['item'] ?? null) : null;
        if (!$item instanceof CommonDBTM || $item->isNewItem()) {
            return;
        }
        // Opening an item reads its notifications (the user's other tabs refresh).
        $uid = Session::getLoginUserID();
        if (in_array($item::class, ['Ticket', 'Change', 'Problem', 'ProjectTask'], true) && is_numeric($uid)) {
            try {
                InboxStore::markItemRead((int) $uid, $item::class, $item->getID());
            } catch (\Throwable) {
                // Inbox tables missing (plugin not updated yet): never break the form.
            }
        }
        if (self::write($item)) {
            // Rooms the client should join on this page.
            echo sprintf(
                '<span hidden data-glpi-realtime-room="%s"></span>',
                htmlescape(self::room($item))
            );
        }
    }

    /**
     * Computes and stores the grant of the current session on $item.
     * Returns false if the item is not enabled, not readable, or Valkey is unavailable.
     */
    public static function write(CommonDBTM $item): bool
    {
        if (!in_array($item::class, Settings::enabledItemtypes(), true)) {
            return false;
        }
        $hash = SessionToken::currentHash();
        if ($hash === null) {
            return false;
        }
        $room = self::room($item);
        $key = Valkey::key('g:' . $hash . ':' . $room);
        $index = Valkey::key('gi:' . $room);
        if (!$item->can($item->getID(), READ)) {
            // Rights lost (e.g. after a `regrant`): make sure no stale grant survives.
            Valkey::run(fn(Redis $r) => $r->multi(Redis::PIPELINE)->del($key)->sRem($index, $hash)->exec());
            return false;
        }
        $flags = array_map(static fn(bool $b) => $b ? '1' : '0', self::flags($item));
        $sessionKey = SessionToken::sessionKey($hash);

        return Valkey::run(function (Redis $r) use ($key, $index, $hash, $flags, $sessionKey) {
            $ttl = $r->ttl($sessionKey);
            if (!is_int($ttl) || $ttl <= 0) {
                return false; // no live session token: nothing to grant
            }
            $r->multi(Redis::PIPELINE)
                ->del($key)
                ->hMSet($key, $flags)
                ->expire($key, $ttl)
                ->sAdd($index, $hash)
                ->expire($index, Settings::sessionTtl())
                ->exec();
            return true;
        }, false);
    }

    /**
     * Deletes every session's grant on $room: rights on the item may have changed.
     * Sessions that can still read it get a new grant from ajax/grant.php or the next display.
     */
    public static function revokeAll(Redis $r, string $room): void
    {
        $index = Valkey::key('gi:' . $room);
        $hashes = $r->sMembers($index);
        if (!is_array($hashes) || $hashes === []) {
            return;
        }
        foreach (array_chunk($hashes, 500) as $chunk) {
            $keys = array_map(static fn(string $h) => Valkey::key('g:' . $h . ':' . $room), $chunk);
            // Only the members read here: a grant written meanwhile stays indexed.
            $r->multi(Redis::PIPELINE)->del($keys)->sRem($index, ...$chunk)->exec();
        }
    }

    /** @return array<string, bool> */
    public static function flags(CommonDBTM $item): array
    {
        $flags = ['read' => true];
        if ($item instanceof CommonITILObject) {
            $flags += [
                'update'                  => $item->canUpdateItem(),
                'see_public_followup'     => Session::haveRight(ITILFollowup::$rightname, ITILFollowup::SEEPUBLIC),
                'see_public_task'         => Session::haveRight(CommonITILTask::$rightname, CommonITILTask::SEEPUBLIC),
                'add_followup'            => $item->canAddFollowups(),
                'add_task'                => $item->canAddTasks(),
                'solve'                   => $item->canSolve(),
                'see_private_followup'    => Session::haveRight(ITILFollowup::$rightname, ITILFollowup::SEEPRIVATE),
                'see_private_followup_groups' => Session::haveRight(ITILFollowup::$rightname, ITILFollowup::SEEPRIVATEGROUPS),
                'see_private_task'        => Session::haveRight(CommonITILTask::$rightname, CommonITILTask::SEEPRIVATE),
                'see_private_task_groups' => Session::haveRight(CommonITILTask::$rightname, CommonITILTask::SEEPRIVATEGROUPS),
            ];
        }
        return $flags;
    }

    public static function room(CommonDBTM $item): string
    {
        return $item::class . ':' . $item->getID();
    }
}
