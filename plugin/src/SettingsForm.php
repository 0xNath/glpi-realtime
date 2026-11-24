<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

/**
 * The plugin's settings as edited on its configuration page: which item types, and how to
 * reach Valkey and the server. Validation only: config.php saves through GLPI.
 */
final class SettingsForm
{
    /** Tickets, changes and problems: every feature. */
    public const ITIL = ['Ticket', 'Change', 'Problem'];

    /** GLPI items offered besides the default list (presence, single editor of the form). */
    public const MORE = [
        'Software', 'SoftwareLicense', 'Appliance', 'Certificate', 'Contract', 'Rack', 'Enclosure',
        'PDU', 'PassiveDCEquipment', 'Cable', 'Database', 'Domain', 'Line', 'Cluster',
    ];

    /**
     * Item types the page offers: the default list, more GLPI items, custom assets (GLPI 11+),
     * and whatever is already enabled. Class => label.
     *
     * @return array<string, string>
     */
    public static function candidates(): array
    {
        $classes = [
            ...json_decode(Settings::DEFAULTS['enabled_itemtypes'], true),
            ...self::MORE,
            ...self::customAssets(),
            ...Settings::enabledItemtypes(),
        ];
        $out = [];
        foreach (array_unique($classes) as $class) {
            if (is_string($class) && is_a($class, \CommonDBTM::class, true)) {
                $out[$class] = self::label($class);
            }
        }
        return $out;
    }

    /** @return list<string> classes of GLPI 11+'s custom assets */
    private static function customAssets(): array
    {
        $manager = 'Glpi\\Asset\\AssetDefinitionManager';
        if (!class_exists($manager)) {
            return [];
        }
        try {
            return array_values(array_map(
                static fn($d) => $d->getAssetClassName(),
                $manager::getInstance()->getDefinitions(true)
            ));
        } catch (\Throwable) {
            return [];
        }
    }

    private static function label(string $class): string
    {
        try {
            $name = $class::getTypeName(\Session::getPluralNumber());
            return is_string($name) && $name !== '' ? $name : $class;
        } catch (\Throwable) {
            return $class;
        }
    }

    /**
     * Checks the posted form. Returns the values to store (the password only when a new one
     * is typed or its removal asked), or the errors.
     *
     * @param array<string, mixed> $post
     * @param list<string> $candidates
     * @return array{values: array<string, string>, errors: list<string>}
     */
    public static function validate(array $post, array $candidates): array
    {
        $errors = [];
        $values = [];

        $types = array_values(array_filter((array) ($post['itemtypes'] ?? []), 'is_string'));
        $unknown = array_diff($types, $candidates);
        if ($unknown !== []) {
            $errors[] = sprintf(__('Unknown item types: %s.', 'realtime'), implode(', ', $unknown));
        }
        $values['enabled_itemtypes'] = json_encode(array_values(array_intersect($candidates, $types)), JSON_UNESCAPED_SLASHES);

        $socket = trim((string) ($post['valkey_socket'] ?? ''));
        if (!preg_match('#^(/[^\s]+|[A-Za-z0-9.\-]+(:\d{1,5})?|\[[0-9A-Fa-f:.]+\](:\d{1,5})?)$#', $socket)) {
            $errors[] = __('Valkey: a unix socket path (/run/valkey/valkey.sock) or host[:port].', 'realtime');
        }
        $values['valkey_socket'] = $socket;

        $db = (string) ($post['valkey_db'] ?? '');
        if (!preg_match('/^\d{1,2}$/', $db) || (int) $db > 15) {
            $errors[] = __('Valkey database: a number from 0 to 15.', 'realtime');
        }
        $values['valkey_db'] = (string) (int) $db;

        $user = trim((string) ($post['valkey_username'] ?? ''));
        if (!preg_match('/^[A-Za-z0-9_.@\-]{0,64}$/', $user)) {
            $errors[] = __('Valkey user: letters, digits and _ . @ - only.', 'realtime');
        }
        $values['valkey_username'] = $user;

        $password = (string) ($post['valkey_password'] ?? '');
        if (!empty($post['valkey_password_remove'])) {
            $values['valkey_password'] = '';
        } elseif ($password !== '') {
            $values['valkey_password'] = $password; // GLPI encrypts it (secured config)
        }

        $prefix = (string) ($post['key_prefix'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_:.\-]{1,32}$/', $prefix)) {
            $errors[] = __('Key prefix: 1 to 32 letters, digits or _ : . -', 'realtime');
        }
        $values['key_prefix'] = $prefix;

        $cookie = (string) ($post['cookie_name'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_\-]{1,64}$/', $cookie)) {
            $errors[] = __('Cookie name: letters, digits, _ and - only.', 'realtime');
        }
        $values['cookie_name'] = $cookie;

        $path = (string) ($post['ws_path'] ?? '');
        if (!preg_match('#^/[A-Za-z0-9_/.\-]*$#', $path)) {
            $errors[] = __('WebSocket path: starts with / (e.g. /ws).', 'realtime');
        }
        $values['ws_path'] = $path;

        return ['values' => $errors === [] ? $values : [], 'errors' => $errors];
    }
}
