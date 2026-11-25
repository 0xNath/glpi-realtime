<?php

/**
 * Prepended to each test script by scripts/test-php.sh when PHP_COVERAGE_DIR is set:
 * records the lines of plugin/src the script ran (pcov, or Xdebug) into that directory,
 * one JSON file per script; coverage_report.php adds them up.
 */

declare(strict_types=1);

(static function (): void {
    $dir = getenv('PHP_COVERAGE_DIR');
    if (!is_string($dir) || $dir === '') {
        return;
    }
    $src = realpath(__DIR__ . '/../src');
    if (function_exists('pcov\\start')) {
        \pcov\start();
        $collect = static fn (): array => \pcov\collect(\pcov\all);
    } elseif (function_exists('xdebug_start_code_coverage')) {
        xdebug_start_code_coverage(XDEBUG_CC_UNUSED | XDEBUG_CC_DEAD_CODE);
        $collect = static fn (): array => xdebug_get_code_coverage();
    } else {
        fwrite(STDERR, "coverage: neither pcov nor Xdebug is loaded\n");
        return;
    }
    register_shutdown_function(static function () use ($dir, $src, $collect): void {
        $lines = [];
        foreach ($collect() as $file => $hits) {
            if (!str_starts_with((string) $file, $src . '/')) {
                continue;
            }
            // 1: run; -1: not run; -2 (Xdebug): dead code, not counted.
            $lines[substr((string) $file, strlen($src) + 1)] = array_filter($hits, static fn ($h) => $h !== -2);
        }
        $out = $dir . '/' . basename((string) ($_SERVER['SCRIPT_FILENAME'] ?? 'script')) . '.' . getmypid() . '.json';
        file_put_contents($out, json_encode($lines));
    });
})();
