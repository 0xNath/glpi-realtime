<?php

/**
 * Notification preferences of the session user.
 * GET → preferences; POST {key: value, ...} → saved preferences.
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Inbox;

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

$uid = (int) Session::getLoginUserID();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true);
    $prefs = Inbox::savePreferences($uid, is_array($in) ? $in : []);
} else {
    $prefs = Inbox::preferences($uid);
}
echo json_encode(['preferences' => $prefs, 'can_see_others' => Session::haveRight('ticket', Ticket::STEAL)]);
