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
 * The server lets a connection subscribe to a room only if this key exists with read=1.
 * The key lives as long as the session token.
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
        if ($hash === null || !$item->can($item->getID(), READ)) {
            return false;
        }
        $flags = array_map(static fn(bool $b) => $b ? '1' : '0', self::flags($item));
        $key = Valkey::key('g:' . $hash . ':' . self::room($item));
        $sessionKey = SessionToken::sessionKey($hash);

        return Valkey::run(function (Redis $r) use ($key, $flags, $sessionKey) {
            $ttl = $r->ttl($sessionKey);
            if (!is_int($ttl) || $ttl <= 0) {
                return false; // no live session token: nothing to grant
            }
            $r->multi(Redis::PIPELINE)
                ->del($key)
                ->hMSet($key, $flags)
                ->expire($key, $ttl)
                ->exec();
            return true;
        }, false);
    }

    /** @return array<string, bool> */
    public static function flags(CommonDBTM $item): array
    {
        $flags = ['read' => true];
        if ($item instanceof CommonITILObject) {
            $flags += [
                'update'                  => $item->canUpdateItem(),
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
