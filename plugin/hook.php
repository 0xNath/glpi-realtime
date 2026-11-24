<?php

/**
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Settings;

function plugin_realtime_install(): bool
{
    // Store defaults once; existing values are kept on upgrade.
    $current = Config::getConfigurationValues(Settings::CONTEXT);
    $missing = array_diff_key(Settings::DEFAULTS, $current);
    if ($missing !== []) {
        Config::setConfigurationValues(Settings::CONTEXT, $missing);
    }
    return true;
}

function plugin_realtime_uninstall(): bool
{
    $config = new Config();
    $config->deleteConfigurationValues(Settings::CONTEXT, array_keys(Settings::DEFAULTS));
    // Valkey keys expire by themselves (session TTL).
    return true;
}
