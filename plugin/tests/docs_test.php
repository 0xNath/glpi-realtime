<?php

/**
 * docs/troubleshooting.md names every check of Health.php ("The checks, one by one"):
 * users start from the name the configuration page shows them.
 * php plugin/tests/docs_test.php
 */

declare(strict_types=1);

$health = (string) file_get_contents(__DIR__ . '/../src/Health.php');
$doc = (string) file_get_contents(__DIR__ . '/../../docs/troubleshooting.md');
preg_match_all("/\\\$label = __\\('((?:[^'\\\\]|\\\\.)+)', 'realtime'\\)/", $health, $a);
preg_match_all("/self::check\\('\\w+', __\\('((?:[^'\\\\]|\\\\.)+)', 'realtime'\\)/", $health, $b);
$labels = array_values(array_unique(array_map(static fn($l) => str_replace("\\'", "'", $l), [...$a[1], ...$b[1]])));
$failures = 0;
foreach ($labels as $label) {
    $ok = str_contains($doc, "| **$label** (");
    echo ($ok ? 'ok   ' : 'FAIL ') . "troubleshooting.md has a row for the check \"$label\"\n";
    $failures += $ok ? 0 : 1;
}
if (count($labels) < 15) {
    echo "FAIL only " . count($labels) . " check labels found in Health.php: the pattern no longer matches\n";
    $failures++;
}
exit($failures === 0 ? 0 : 1);
