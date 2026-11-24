<?php

/**
 * One solution at a time, enforced in GLPI (pre_item_add on ITILSolution).
 * php -d extension=igbinary -d extension=redis plugin/tests/solution_test.php
 */

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use GlpiPlugin\Realtime\SolutionGuard;

$existing = 0;
$locks = [];
$log = [];
SolutionGuard::$counter = static function (string $type, int $id) use (&$existing) {
    return $existing;
};
SolutionGuard::$mutex = static function (string $name, bool $take) use (&$locks, &$log) {
    $log[] = ($take ? 'take ' : 'release ') . $name;
    if ($take) {
        $locks[$name] = true;
    } else {
        unset($locks[$name]);
    }
    return true;
};

$s = new ITILSolution();
$s->input = ['itemtype' => 'Ticket', 'items_id' => 5, 'content' => 'fixed'];
SolutionGuard::onPreAdd($s);
check(is_array($s->input) && $locks === ['glpi_rt_solution_Ticket_5' => true], 'first solution: allowed, item locked until it is stored');
$s->fields = ['itemtype' => 'Ticket', 'items_id' => 5];
SolutionGuard::onAdd($s);
check($locks === [], 'released once stored');

$existing = 1; // the first one is now in the database
$s2 = new ITILSolution();
$s2->input = ['itemtype' => 'Ticket', 'items_id' => 5, 'content' => 'me too'];
SolutionGuard::onPreAdd($s2);
check($s2->input === false, 'second solution refused while one is pending or accepted');
check(Session::$messages !== [] && Session::$messages[0][1] === ERROR, 'the user is told why');
check($locks === [], 'lock released on refusal');

$existing = 0; // the previous one was refused
$s3 = new ITILSolution();
$s3->input = ['itemtype' => 'Ticket', 'items_id' => 5];
SolutionGuard::onPreAdd($s3);
check(is_array($s3->input), 'a refused solution can be replaced');
SolutionGuard::releaseAll();
check($locks === [], 'end of request releases whatever is left');

$other = new ITILFollowup();
$other->input = ['itemtype' => 'Ticket', 'items_id' => 5];
$before = count($log);
SolutionGuard::onPreAdd($other);
SolutionGuard::onPreAdd(new ITILSolution()); // no input
check(count($log) === $before, 'other items and incomplete input untouched');

exit($GLOBALS['failures'] === 0 ? 0 : 1);
