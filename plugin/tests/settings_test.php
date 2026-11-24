<?php

/**
 * Validation of the settings form of the configuration page.
 * php plugin/tests/settings_test.php
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\SettingsForm;

$candidates = ['Ticket', 'Change', 'Problem', 'Computer', 'Glpi\\CustomAsset\\ServerAsset'];
$ok = [
    'itemtypes' => ['Ticket', 'Computer', 'Glpi\\CustomAsset\\ServerAsset'],
    'valkey_socket' => '/run/valkey/valkey.sock', 'valkey_db' => '6', 'valkey_username' => 'glpi-rt',
    'valkey_password' => '', 'key_prefix' => 'rt:', 'cookie_name' => 'glpi_rt', 'ws_path' => '/ws',
];

$r = SettingsForm::validate($ok, $candidates);
check($r['errors'] === [], 'valid settings');
check($r['values']['enabled_itemtypes'] === '["Ticket","Computer","Glpi\\\\CustomAsset\\\\ServerAsset"]', 'item types in the order offered, custom assets included');
check(!array_key_exists('valkey_password', $r['values']), 'empty password field: the stored one is kept');

check(SettingsForm::validate(['valkey_password' => 's3cret'] + $ok, $candidates)['values']['valkey_password'] === 's3cret', 'a new password is stored (GLPI encrypts it)');
check(SettingsForm::validate(['valkey_password_remove' => '1'] + $ok, $candidates)['values']['valkey_password'] === '', 'or removed when asked');
check(SettingsForm::validate(['itemtypes' => []] + $ok, $candidates)['values']['enabled_itemtypes'] === '[]', 'no item type at all is allowed');

foreach (['valkey:6379', '127.0.0.1', '[::1]:6380', '/var/run/redis.sock'] as $socket) {
    check(SettingsForm::validate(['valkey_socket' => $socket] + $ok, $candidates)['errors'] === [], "Valkey at $socket");
}
$bad = [
    ['itemtypes' => ['User']], ['valkey_socket' => 'valkey 6379'], ['valkey_socket' => ''], ['valkey_db' => '16'],
    ['valkey_db' => 'x'], ['valkey_username' => 'a b'], ['key_prefix' => ''], ['key_prefix' => 'rt "x"'],
    ['cookie_name' => 'glpi rt'], ['ws_path' => 'ws'], ['ws_path' => '/ws?x'],
];
foreach ($bad as $change) {
    $r = SettingsForm::validate($change + $ok, $candidates);
    check($r['errors'] !== [] && $r['values'] === [], 'refused: ' . json_encode($change));
}

exit($GLOBALS['failures'] === 0 ? 0 : 1);
