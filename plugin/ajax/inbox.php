<?php

/**
 * The bell, for the session user. Titles and details are read here, after GLPI checked
 * READ on each item: nothing of the kind travels on the WebSocket.
 *
 * GET  ?read=0|1&full=0|1                       → list
 * POST {"action": "read"|"unread", "id": N}
 *      {"action": "read_item", "item": "Ticket:5"}
 *      {"action": "read_tab", "tab": "all"|"new"|"mine"|"team"|"other"|"resolved"|"closed"|"ended"}
 *                                               → list (the user's other tabs refresh live)
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\InboxStore;

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

$uid = (int) Session::getLoginUserID();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true);
    $in = is_array($in) ? $in : [];
    $action = (string) ($in['action'] ?? '');
    switch ($action) {
        case 'read':
        case 'unread':
            InboxStore::markRead($uid, (int) ($in['id'] ?? 0), $action === 'read');
            break;
        case 'read_item':
            if (preg_match('/^([A-Za-z_]+):([1-9][0-9]*)$/', (string) ($in['item'] ?? ''), $m)) {
                InboxStore::markItemRead($uid, $m[1], (int) $m[2]);
            }
            break;
        case 'read_tab':
            $tab = (string) ($in['tab'] ?? 'all');
            if (in_array($tab, ['all', 'new', 'mine', 'team', 'other', 'resolved', 'closed', 'ended'], true)) {
                InboxStore::markTabRead($uid, $tab);
            }
            break;
        default:
            http_response_code(400);
            echo json_encode(['error' => 'unknown action']);
            return;
    }
}

// Self-service users get the bell too, with a single "All" tab (queues are technicians').
echo json_encode(['enabled' => true, 'interface' => Session::getCurrentInterface()] + InboxStore::list(
    $uid,
    withRead: ($_GET['read'] ?? '0') === '1',
    full: ($_GET['full'] ?? '0') === '1',
));
