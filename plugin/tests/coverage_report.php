<?php

/**
 * Adds up the coverage files of coverage_prepend.php (argument: their directory) and
 * prints, per file of plugin/src, the share of its executable lines some test ran. Files
 * no test loads are listed at 0 %.
 */

declare(strict_types=1);

$dir = $argv[1] ?? '';
$src = realpath(__DIR__ . '/../src');
$run = [];      // file => line => true (run by at least one script)
$lines = [];    // file => line => true (executable)
foreach (glob($dir . '/*.json') ?: [] as $f) {
    foreach (json_decode((string) file_get_contents($f), true) ?: [] as $file => $hits) {
        foreach ($hits as $line => $h) {
            $lines[$file][$line] = true;
            if ($h > 0) {
                $run[$file][$line] = true;
            }
        }
    }
}
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    $rel = substr($f->getPathname(), strlen($src) + 1);
    if (str_ends_with($rel, '.php') && !isset($lines[$rel])) {
        $lines[$rel] = [];
    }
}
ksort($lines);
$total = $covered = 0;
printf("%-40s %8s %8s\n", 'file (plugin/src)', 'lines', 'cover');
foreach ($lines as $file => $l) {
    $n = count($l);
    $c = count($run[$file] ?? []);
    $total += $n;
    $covered += $c;
    printf("%-40s %8d %7s\n", $file, $n, $n ? sprintf('%.1f%%', 100 * $c / $n) : 'not run');
}
printf("%-40s %8d %7.1f%%\n", 'TOTAL', $total, $total ? 100 * $covered / $total : 0);
