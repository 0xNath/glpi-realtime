<?php

/**
 * "Assume": assigns the session user to an item from the bell, with GLPI's own rule
 * (canAssignToMe). GLPI moves a new item to "assigned" by itself.
 * POST {"item": "Ticket:5"} → {"ok": bool, "message": string}
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\GlpiDirectory;

Session::checkLoginUser();
Session::checkCentralAccess();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

$reply = static function (bool $ok, string $message, int $code = 200): void {
    http_response_code($code);
    echo json_encode(['ok' => $ok, 'message' => $message]);
};
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    $reply(false, 'POST only', 405);
    return;
}
$in = json_decode((string) file_get_contents('php://input'), true);
if (!preg_match('/^(Ticket|Change|Problem):([1-9][0-9]*)$/', (string) ($in['item'] ?? ''), $m)) {
    $reply(false, __('Item not found'), 400);
    return;
}
[, $type, $id] = $m;
$id = (int) $id;
$item = new $type();
if (!$item->getFromDB($id) || !$item->can($id, READ)) {
    $reply(false, __('Item not found'), 404);
    return;
}
if (!$item->canAssignToMe()) {
    $reply(false, __("You don't have permission to perform this action."), 403);
    return;
}
$uid = (int) Session::getLoginUserID();
[$userLink, , $fk] = GlpiDirectory::LINKS[$type];
$link = new $userLink();
if ($link->find([$fk => $id, 'users_id' => $uid, 'type' => CommonITILActor::ASSIGN]) !== []) {
    $reply(true, __('You are already assigned to this item.', 'realtime'));
    return;
}
$ok = (bool) $link->add([$fk => $id, 'users_id' => $uid, 'type' => CommonITILActor::ASSIGN, 'use_notification' => 1]);
$reply($ok, $ok ? __('Item successfully updated') : __('Error'), $ok ? 200 : 500);
