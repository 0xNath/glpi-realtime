<?php

/**
 * Grants for the rows of a list page (tickets, changes, problems), so that the client may
 * follow who is on them. GLPI checks READ on each item, as when it is displayed.
 *
 * Items this session already has a grant on are not checked again: grants are deleted
 * whenever rights may change (actors, entity, profiles, groups), so a grant still there is
 * current. Paging through a list only costs the new rows.
 *
 * POST {"items": ["Ticket:5", "Change:3", ...]}  →  {"rooms": [granted items]}
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\SessionToken;
use GlpiPlugin\Realtime\Settings;
use GlpiPlugin\Realtime\Valkey;

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

const MAX_ITEMS = 200;

$in = json_decode((string) file_get_contents('php://input'), true);
$items = is_array($in['items'] ?? null) ? array_slice(array_unique($in['items']), 0, MAX_ITEMS) : [];
$enabled = Settings::enabledItemtypes();
$items = array_values(array_filter($items, static fn($raw) => is_string($raw) && preg_match('/^([A-Za-z_][A-Za-z0-9_\\\\]*):([1-9][0-9]*)$/', $raw)));

// Already granted to this session (one round trip).
$hash = SessionToken::currentHash();
$have = [];
if ($hash !== null && $items !== []) {
    $have = Valkey::run(static function (Redis $r) use ($hash, $items) {
        $pipe = $r->multi(Redis::PIPELINE);
        foreach ($items as $raw) {
            $pipe->hGet(Valkey::key('g:' . $hash . ':' . $raw), 'read');
        }
        return array_map(static fn($v) => $v === '1', $pipe->exec() ?: []);
    }, []);
}

$rooms = [];
foreach ($items as $i => $raw) {
    if ($have[$i] ?? false) {
        $rooms[] = $raw;
        continue;
    }
    preg_match('/^([A-Za-z_][A-Za-z0-9_\\\\]*):([1-9][0-9]*)$/', $raw, $m);
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
