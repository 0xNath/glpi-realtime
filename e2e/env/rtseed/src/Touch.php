<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Rtseed;

use CronTask;
use Ticket;

/**
 * A test-only automatic action changing an e2e ticket (assigned to rt-alice), as GLPI's own actions do (the mail
 * collector creating or updating tickets): what it changes must be notified and published
 * like a change made in a browser.
 */
final class Touch
{
    /** @return array{description: string} */
    public static function cronInfo(string $name): array
    {
        return ['description' => 'Change the e2e ticket (tests only)'];
    }

    public static function cronRttouch(CronTask $task): int
    {
        $ticket = new Ticket();
        // Assigned to rt-alice: she is told.
        if (!$ticket->getFromDBByCrit(['name' => 'glpi-realtime e2e: due soon'])) {
            return 0;
        }
        $urgency = (int) $ticket->fields['urgency'] % 5 + 1;
        $ticket->update(['id' => $ticket->getID(), 'urgency' => $urgency]);
        $task->addVolume(1);
        return 1;
    }
}
