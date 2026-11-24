<?php

/**
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Inbox;
use GlpiPlugin\Realtime\Settings;

function plugin_realtime_install(): bool
{
    global $DB;

    // Store defaults once; existing values are kept on upgrade.
    $current = Config::getConfigurationValues(Settings::CONTEXT);
    $missing = array_diff_key(Settings::DEFAULTS, $current);
    if ($missing !== []) {
        Config::setConfigurationValues(Settings::CONTEXT, $missing);
    }
    // 0.3.0: changes and problems get every feature, like tickets (unless an admin chose
    // the list).
    if (($current['enabled_itemtypes'] ?? null) === Settings::OLD_ITEMTYPES) {
        Config::setConfigurationValues(Settings::CONTEXT, ['enabled_itemtypes' => Settings::DEFAULTS['enabled_itemtypes']]);
    }

    $charset   = DBConnection::getDefaultCharset();
    $collation = DBConnection::getDefaultCollation();
    $sign      = DBConnection::getDefaultPrimaryKeySignOption();

    // Inbox: one row per recipient and event. Titles are not stored: they are read from
    // GLPI when the list is displayed, after GLPI checked READ on the item.
    if (!$DB->tableExists(Inbox::TABLE)) {
        $DB->doQuery("CREATE TABLE `" . Inbox::TABLE . "` (
            `id`             INT {$sign} NOT NULL AUTO_INCREMENT,
            `users_id`       INT {$sign} NOT NULL DEFAULT 0 COMMENT 'recipient',
            `actor_users_id` INT {$sign} NOT NULL DEFAULT 0 COMMENT 'who did it (0: GLPI)',
            `itemtype`       VARCHAR(100) NOT NULL DEFAULT '',
            `items_id`       INT {$sign} NOT NULL DEFAULT 0,
            `event`          VARCHAR(32) NOT NULL DEFAULT '',
            `channel`        VARCHAR(10) NOT NULL DEFAULT '' COMMENT 'direct | group | other | seen',
            `detail`         VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'JSON: changed fields...',
            `is_read`        TINYINT NOT NULL DEFAULT 0,
            `date_creation`  TIMESTAMP NULL DEFAULT NULL,
            `date_mod`       TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (`id`),
            KEY `user_unread` (`users_id`, `is_read`, `date_creation`),
            KEY `item` (`itemtype`, `items_id`, `users_id`),
            KEY `date_mod` (`date_mod`)
        ) ENGINE=InnoDB DEFAULT CHARSET={$charset} COLLATE={$collation} ROW_FORMAT=DYNAMIC");
    }

    // Preferences: a missing row means the defaults (Inbox::DEFAULT_PREFERENCES).
    if (!$DB->tableExists(Inbox::PREFS_TABLE)) {
        $DB->doQuery("CREATE TABLE `" . Inbox::PREFS_TABLE . "` (
            `users_id`    INT {$sign} NOT NULL,
            `preferences` TEXT NOT NULL COMMENT 'JSON, see Inbox::DEFAULT_PREFERENCES',
            `date_mod`    TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (`users_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET={$charset} COLLATE={$collation} ROW_FORMAT=DYNAMIC");
    }

    CronTask::register(Inbox::class, 'inboxpurge', DAY_TIMESTAMP, [
        'comment' => 'Realtime: purge read notifications and those of inactive users',
        'mode'    => CronTask::MODE_EXTERNAL,
        'param'   => 30, // days a read notification is kept
    ]);
    return true;
}

function plugin_realtime_uninstall(): bool
{
    global $DB;
    $config = new Config();
    $config->deleteConfigurationValues(Settings::CONTEXT, array_keys(Settings::DEFAULTS));
    foreach ([Inbox::TABLE, Inbox::PREFS_TABLE] as $table) {
        if ($DB->tableExists($table)) {
            $DB->doQuery("DROP TABLE `{$table}`");
        }
    }
    CronTask::unregister('Realtime');
    // Valkey keys expire by themselves (session TTL).
    return true;
}
