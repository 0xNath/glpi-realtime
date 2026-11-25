<?php

/** @license GPL-3.0-or-later */

function plugin_rtseed_install(): bool
{
    // An automatic action changing the e2e ticket (see GlpiPlugin\Rtseed\Touch).
    CronTask::register(GlpiPlugin\Rtseed\Touch::class, 'rttouch', DAY_TIMESTAMP, ['mode' => CronTask::MODE_EXTERNAL]);
    return true;
}

function plugin_rtseed_uninstall(): bool
{
    return true;
}
