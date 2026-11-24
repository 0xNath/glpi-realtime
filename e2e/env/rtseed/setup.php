<?php

/**
 * Test-only GLPI plugin of the disposable e2e environment (e2e/env): its command creates
 * the test accounts and ticket. Never install it on a real GLPI.
 *
 * @license GPL-3.0-or-later
 */

function plugin_version_rtseed(): array
{
    return [
        'name'         => 'Realtime e2e seed (tests only)',
        'version'      => '1.0.0',
        'license'      => 'GPLv3+',
        'requirements' => ['glpi' => ['min' => '11.0.0', 'max' => '99.99.99']],
    ];
}

function plugin_init_rtseed(): void
{
}
