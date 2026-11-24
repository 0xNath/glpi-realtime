<?php

/**
 * Re-computes the grant of the current session on one item.
 * Called by the client when the server asks for it (`regrant`, after rights changes).
 *
 * GET ?itemtype=Ticket&id=42  →  {"ok": true|false}
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\Settings;

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

$itemtype = (string) ($_GET['itemtype'] ?? '');
$id = (int) ($_GET['id'] ?? 0);

$ok = false;
if ($id > 0 && in_array($itemtype, Settings::enabledItemtypes(), true) && is_a($itemtype, CommonDBTM::class, true)) {
    $item = new $itemtype();
    $ok = $item->getFromDB($id) && Grants::write($item);
}

echo json_encode(['ok' => $ok]);
