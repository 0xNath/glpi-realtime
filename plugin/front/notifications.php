<?php

/**
 * Every notification of the session user, with filters and quick actions.
 * The page is drawn by the client (realtime.js) from ajax/inbox.php?full=1.
 *
 * @license GPL-3.0-or-later
 */

Session::checkLoginUser();

$helpdesk = Session::getCurrentInterface() === 'helpdesk';
if ($helpdesk) {
    Html::helpHeader(__('Notifications'));
} else {
    Html::header(__('Notifications'), '', 'helpdesk', 'ticket');
}
echo '<div id="glpi-rt-inbox-page" class="container-fluid"></div>';
$helpdesk ? Html::helpFooter() : Html::footer();
