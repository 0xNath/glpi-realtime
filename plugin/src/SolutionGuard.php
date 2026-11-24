<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonITILObject;
use CommonITILValidation;
use Session;

/**
 * One solution at a time, enforced by GLPI (not only by the browsers' lock):
 * `pre_item_add` on ITILSolution refuses a solution when the item already has one that
 * is not refused (pending or accepted).
 *
 * Two people saving at the same moment would both pass that check: additions on the
 * same item are serialized with a MariaDB named lock (GET_LOCK), held from the check to
 * the end of the add (or of the request).
 */
final class SolutionGuard
{
    /** Seconds to wait for a concurrent addition on the same item. */
    private const WAIT = 5;

    /** @var array<string, true> locks held by this request */
    private static array $held = [];

    /** @internal tests: (itemtype, id) => solutions that are not refused */
    public static ?\Closure $counter = null;
    /** @internal tests: (name, take) => bool */
    public static ?\Closure $mutex = null;

    public static function onPreAdd(mixed $item): void
    {
        if (!$item instanceof \ITILSolution || !is_array($item->input)) {
            return;
        }
        $type = (string) ($item->input['itemtype'] ?? '');
        $id = (int) ($item->input['items_id'] ?? 0);
        if ($id <= 0 || !is_a($type, CommonITILObject::class, true)) {
            return;
        }
        $name = self::name($type, $id);
        try {
            if (self::mutex($name, true)) {
                self::$held[$name] = true;
                register_shutdown_function([self::class, 'releaseAll']);
            }
            if (self::existing($type, $id) > 0) {
                $fr = str_starts_with((string) ($_SESSION['glpilanguage'] ?? ''), 'fr');
                Session::addMessageAfterRedirect(
                    htmlescape($fr
                        ? 'Une solution a déjà été proposée pour cet élément. Actualisez la page pour la voir.'
                        : 'A solution has already been proposed for this item. Refresh the page to see it.'),
                    false,
                    ERROR
                );
                $item->input = false; // GLPI cancels the addition
                self::release($name);
            }
        } catch (\Throwable $e) {
            // Never block GLPI because of the guard itself.
            \Toolbox::logInFile('realtime', 'solution guard: ' . $e->getMessage() . "\n");
        }
    }

    /** item_add on ITILSolution: the solution is stored, others may now see it. */
    public static function onAdd(mixed $item): void
    {
        if ($item instanceof \ITILSolution) {
            self::release(self::name((string) ($item->fields['itemtype'] ?? ''), (int) ($item->fields['items_id'] ?? 0)));
        }
    }

    public static function releaseAll(): void
    {
        foreach (array_keys(self::$held) as $name) {
            self::release($name);
        }
    }

    private static function release(string $name): void
    {
        if (isset(self::$held[$name])) {
            unset(self::$held[$name]);
            try {
                self::mutex($name, false);
            } catch (\Throwable) {
                // released by MariaDB at disconnection anyway
            }
        }
    }

    private static function name(string $type, int $id): string
    {
        return 'glpi_rt_solution_' . preg_replace('/\W/', '', $type) . '_' . $id;
    }

    private static function existing(string $type, int $id): int
    {
        if (self::$counter !== null) {
            return (self::$counter)($type, $id);
        }
        return countElementsInTable('glpi_itilsolutions', [
            'itemtype' => $type,
            'items_id' => $id,
            'NOT'      => ['status' => CommonITILValidation::REFUSED],
        ]);
    }

    private static function mutex(string $name, bool $take): bool
    {
        if (self::$mutex !== null) {
            return (self::$mutex)($name, $take);
        }
        global $DB;
        $sql = $take
            ? sprintf("SELECT GET_LOCK('%s', %d) AS l", $DB->escape($name), self::WAIT)
            : sprintf("SELECT RELEASE_LOCK('%s') AS l", $DB->escape($name));
        $row = $DB->doQuery($sql)->fetch_assoc();
        return (int) ($row['l'] ?? 0) === 1;
    }
}
