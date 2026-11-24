<?php

/**
 * glpi-realtime: real-time presence, events, notifications and collaborative drafts for GLPI.
 *
 * This plugin is the only authority on identities and rights: it writes session tokens
 * and per-item grants into Valkey; the Rust WebSocket server only reads them.
 * Every Valkey access fails open: if Valkey is down, GLPI behaves exactly as without
 * the plugin.
 *
 * @license GPL-3.0-or-later
 */

use Glpi\Plugin\Hooks;
use GlpiPlugin\Realtime\ConcurrencyGuard;
use GlpiPlugin\Realtime\Events;
use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\SessionToken;
use GlpiPlugin\Realtime\Settings;
use GlpiPlugin\Realtime\SolutionGuard;

define('PLUGIN_REALTIME_VERSION', '0.7.0');
define('PLUGIN_REALTIME_MIN_GLPI', '11.0.0');
define('PLUGIN_REALTIME_MAX_GLPI', '12.0.99');

spl_autoload_register(static function (string $class): void {
    $prefix = 'GlpiPlugin\\Realtime\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});

function plugin_version_realtime(): array
{
    return [
        'name'         => 'Realtime',
        'version'      => PLUGIN_REALTIME_VERSION,
        'author'       => 'glpi-realtime contributors',
        'license'      => 'GPLv3+',
        'homepage'     => 'https://github.com/0xNath/glpi-realtime',
        'requirements' => [
            'glpi' => ['min' => PLUGIN_REALTIME_MIN_GLPI, 'max' => PLUGIN_REALTIME_MAX_GLPI],
            'php'  => ['min' => '8.2'],
        ],
    ];
}

function plugin_realtime_check_prerequisites(): bool
{
    if (!extension_loaded('redis')) {
        echo 'The PHP "redis" extension (phpredis) is required to talk to Valkey.';
        return false;
    }
    return true;
}

function plugin_realtime_check_config($verbose = false): bool
{
    return true;
}

function plugin_init_realtime(): void
{
    global $PLUGIN_HOOKS;

    // Browser client (served from public/realtime.js).
    $PLUGIN_HOOKS[Hooks::ADD_JAVASCRIPT]['realtime'] = ['realtime.js'];

    // Valkey password encrypted with GLPI's key (and re-encrypted by glpi:security:changekey).
    // Written here rather than read from a class: nothing may fail before the try below.
    $PLUGIN_HOOKS[Hooks::SECURED_CONFIGS]['realtime'] = ['valkey_password'];

    // GLPI deactivates a plugin for good when its init throws. Right after an upgrade, PHP's
    // opcache may still serve some old files next to new ones (opcache.revalidate_freq):
    // never let that disable the plugin; the next requests, once files are revalidated, work.
    try {
        // Session token: issued, slid and revoked on regular GLPI requests (no extra request).
        $PLUGIN_HOOKS[Hooks::POST_INIT]['realtime'] = [SessionToken::class, 'onPostInit'];

        // Per-item grants, computed by GLPI when the item form is displayed.
        $PLUGIN_HOOKS[Hooks::POST_ITEM_FORM]['realtime'] = [Grants::class, 'onPostItemForm'];

        // Live events and notifications: item_add, item_update, ... on tickets, changes,
        // problems and their sub-items.
        foreach (Events::hooks() as $hook => $byClass) {
            $PLUGIN_HOOKS[$hook]['realtime'] = $byClass;
        }

        // One solution at a time, enforced by GLPI.
        $PLUGIN_HOOKS[Hooks::PRE_ITEM_ADD]['realtime'] = ['ITILSolution' => [SolutionGuard::class, 'onPreAdd']];

        // Never save a fields form older than the database (whatever the browsers do).
        // (Updates without the form's hidden date, or of items without one, pass.)
        $PLUGIN_HOOKS[Hooks::PRE_ITEM_UPDATE]['realtime'] = array_fill_keys(
            Settings::enabledItemtypes(),
            [ConcurrencyGuard::class, 'onPreUpdate']
        );

        // Setup > Plugins > Realtime: health checks (everything needed, and how to fix it).
        if (Session::haveRight('config', UPDATE)) {
            $PLUGIN_HOOKS[Hooks::CONFIG_PAGE]['realtime'] = 'front/config.php';
        }
    } catch (\Throwable $e) {
        Toolbox::logInFile('realtime', 'plugin init skipped (files being upgraded?): ' . $e->getMessage() . "\n");
    }
}
