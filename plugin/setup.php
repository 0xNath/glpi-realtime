<?php

/**
 * glpi-realtime: real-time presence, events and collaborative drafts for GLPI.
 *
 * This plugin is the only authority on identities and rights: it writes session tokens
 * and per-item grants into Valkey; the Rust WebSocket server only reads them.
 * Every Valkey access fails open: if Valkey is down, GLPI behaves exactly as without
 * the plugin.
 *
 * @license GPL-3.0-or-later
 */

use Glpi\Plugin\Hooks;
use GlpiPlugin\Realtime\Grants;
use GlpiPlugin\Realtime\SessionToken;

define('PLUGIN_REALTIME_VERSION', '0.1.0');
define('PLUGIN_REALTIME_MIN_GLPI', '12.0.0');
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
        'homepage'     => '',
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

    // Session token: issued, slid and revoked on regular GLPI requests (no extra request).
    $PLUGIN_HOOKS[Hooks::POST_INIT]['realtime'] = [SessionToken::class, 'onPostInit'];

    // Per-item grants, computed by GLPI when the item form is displayed.
    $PLUGIN_HOOKS[Hooks::POST_ITEM_FORM]['realtime'] = [Grants::class, 'onPostItemForm'];

    // Browser client (served from public/realtime.js).
    $PLUGIN_HOOKS[Hooks::ADD_JAVASCRIPT]['realtime'] = ['realtime.js'];
}
