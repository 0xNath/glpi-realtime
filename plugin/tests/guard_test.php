<?php

/**
 * GLPI refuses to save a fields form older than the database (optimistic concurrency).
 * php -d extension=igbinary -d extension=redis plugin/tests/guard_test.php
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\ConcurrencyGuard;

User::$db = [9 => ['name' => 'bob', 'picture' => null]];

$t = new Ticket(['id' => 5, 'date_mod' => '2026-11-24 10:00:00']);
check(ConcurrencyGuard::field($t) === '<input type="hidden" name="_glpi_rt_date_mod" value="2026-11-24 10:00:00" />', 'date_mod put in the fields form');
check(ConcurrencyGuard::field(new Ticket()) === '' && ConcurrencyGuard::field(new Computer(['id' => 1])) === '', 'not on creation forms nor other items');
check(ConcurrencyGuard::field(new Change(['id' => 3, 'date_mod' => 'x'])) !== '', 'changes and problems too');

// Saved from an up-to-date form: accepted, the field is not stored.
$t->input = ['id' => 5, 'urgency' => 4, '_glpi_rt_date_mod' => '2026-11-24 10:00:00'];
ConcurrencyGuard::onPreUpdate($t);
check($t->input === ['id' => 5, 'urgency' => 4], 'up to date: saved');

// Someone saved meanwhile.
$t->fields = ['id' => 5, 'date_mod' => '2026-11-24 10:03:12', 'users_id_lastupdater' => 9];
$t->input = ['id' => 5, 'urgency' => 2, '_glpi_rt_date_mod' => '2026-11-24 10:00:00'];
ConcurrencyGuard::onPreUpdate($t);
check($t->input === false, 'older form: refused');
check(str_contains(Session::$messages[0][0] ?? '', 'bob') && Session::$messages[0][1] === ERROR, 'the user is told who changed it');

// Updates that do not come from the form (followups, API, rules) are not affected.
$t->input = ['id' => 5, 'status' => 4];
ConcurrencyGuard::onPreUpdate($t);
check($t->input === ['id' => 5, 'status' => 4], 'other updates untouched');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
