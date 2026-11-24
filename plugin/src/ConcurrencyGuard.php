<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonDBTM;
use Session;

/**
 * Refuses, in GLPI, to save an item's form whose values are older than the database
 * (optimistic concurrency), for every enabled item type with a `date_mod`: the browsers'
 * single-editor lock is advisory, this is not.
 *
 * - `post_item_form` puts the item's `date_mod` in its form (`form#itil-form` for tickets,
 *   changes and problems, the main form otherwise).
 * - `pre_item_update` compares it with the current one: if someone (or GLPI itself: a
 *   followup changing the status) updated the item since the form was displayed, the
 *   update is cancelled and the user told to refresh.
 *
 * Updates that do not come from that form (followups, API, rules, mail collector) carry
 * no such field and are not affected.
 */
final class ConcurrencyGuard
{
    public const FIELD = '_glpi_rt_date_mod';
    /** Hidden field for the form of an enabled item. */
    public static function field(CommonDBTM $item): string
    {
        if ($item->isNewItem() || !in_array($item::class, Settings::enabledItemtypes(), true) || !array_key_exists('date_mod', $item->fields)) {
            return '';
        }
        return sprintf(
            '<input type="hidden" name="%s" value="%s" />',
            self::FIELD,
            htmlescape((string) ($item->fields['date_mod'] ?? ''))
        );
    }

    /** Hook pre_item_update on the enabled item types. */
    public static function onPreUpdate(mixed $item): void
    {
        if (!$item instanceof CommonDBTM || !is_array($item->input) || !array_key_exists(self::FIELD, $item->input)) {
            return;
        }
        $seen = (string) $item->input[self::FIELD];
        unset($item->input[self::FIELD]);
        $current = (string) ($item->fields['date_mod'] ?? '');
        if ($seen === '' || $current === '' || $seen === $current) {
            return;
        }
        $by = (int) ($item->fields['users_id_lastupdater'] ?? 0);
        $name = $by > 0 ? (string) getUserName($by) : 'GLPI';
        Session::addMessageAfterRedirect(
            htmlescape(sprintf(
                // TRANS: %s is the name of who changed the item
                __('%s changed this item while you were editing it: your changes were not saved. Refresh the page and try again.', 'realtime'),
                $name
            )),
            false,
            ERROR
        );
        $item->input = false; // GLPI cancels the update
    }
}
