<?php

/**
 * Grants for the rows of a list page (tickets, changes, problems), so that the client may
 * follow who is on them. GLPI checks READ on each item, as when it is displayed.
 *
 * POST {"items": ["Ticket:5", "Change:3", ...]}  →  {"rooms": [granted items]}
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\Settings;

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

const MAX_ITEMS = 200;

$in = json_decode((string) file_get_contents('php://input'), true);
$items = is_array($in['items'] ?? null) ? array_slice(array_unique($in['items']), 0, MAX_ITEMS) : [];
$enabled = Settings::enabledItemtypes();
$rooms = [];
foreach ($items as $raw) {
    if (!is_string($raw) || !preg_match('/^([A-Za-z_]+):([1-9][0-9]*)$/', $raw, $m)) {
        continue;
    }
    [, $type, $id] = $m;
    if (!in_array($type, $enabled, true) || !is_a($type, CommonDBTM::class, true)) {
        continue;
    }
    $item = new $type();
    if ($item->getFromDB((int) $id) && Grants::write($item)) {
        $rooms[] = $raw;
    }
}
echo json_encode(['rooms' => $rooms]);
