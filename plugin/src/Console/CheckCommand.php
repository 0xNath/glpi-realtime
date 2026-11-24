<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime\Console;

use Glpi\Console\AbstractCommand;
use GlpiPlugin\Realtime\Health;
use Symfony\Component\Console\Formatter\OutputFormatter;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * bin/console plugins:realtime:check: the configuration page's checks, for scripts and
 * monitoring. The web server's /ws location is checked through GLPI's URL, as a browser
 * would reach it. Exit code as monitoring plugins expect it: 0 everything works, 1
 * warnings, 2 errors.
 */
final class CheckCommand extends AbstractCommand
{
    public const EXIT_OK = 0;
    public const EXIT_WARNING = 1;
    public const EXIT_ERROR = 2;

    protected function configure()
    {
        parent::configure();
        $this->setName('plugins:realtime:check');
        $this->setDescription(__('Check everything the real-time layer needs (exit code: 0 ok, 1 warnings, 2 errors)', 'realtime'));
        $this->addOption('format', null, InputOption::VALUE_REQUIRED, __('Output format: text or json', 'realtime'), 'text');
        $this->addOption('no-web', null, InputOption::VALUE_NONE, __('Do not request GLPI\'s URL (web server checks)', 'realtime'));
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $checks = Health::run(cli: true);
        if ($input->getOption('no-web')) {
            $checks = array_values(array_filter($checks, static fn($c) => $c['group'] !== 'web'));
        }
        $statuses = array_column($checks, 'status');
        $code = in_array(Health::ERROR, $statuses, true) ? self::EXIT_ERROR
            : (in_array(Health::WARNING, $statuses, true) ? self::EXIT_WARNING : self::EXIT_OK);

        if ($input->getOption('format') === 'json') {
            $output->writeln(json_encode([
                'status' => [self::EXIT_OK => Health::OK, self::EXIT_WARNING => Health::WARNING, self::EXIT_ERROR => Health::ERROR][$code],
                'checks' => $checks,
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), OutputInterface::OUTPUT_RAW);
            return $code;
        }

        $groups = [
            'glpi'   => __('GLPI', 'realtime'),
            'valkey' => __('Valkey', 'realtime'),
            'server' => __('glpi-realtime server', 'realtime'),
            'web'    => __('Web server', 'realtime'),
        ];
        $badges = [
            Health::OK      => ['fg=black;bg=green', __('OK', 'realtime')],
            Health::WARNING => ['fg=black;bg=yellow', __('Warning', 'realtime')],
            Health::ERROR   => ['fg=white;bg=red', __('Error', 'realtime')],
            Health::INFO    => ['fg=black;bg=cyan', __('Info', 'realtime')],
        ];
        $width = max(array_map(static fn($b) => mb_strlen($b[1]), $badges));
        $e = static fn(string $s): string => OutputFormatter::escape($s);
        foreach ($groups as $g => $title) {
            $rows = array_filter($checks, static fn($c) => $c['group'] === $g);
            if ($rows === []) {
                continue;
            }
            $output->writeln('');
            $output->writeln('<options=bold,underscore>' . $e($title) . '</>');
            foreach ($rows as $c) {
                [$style, $text] = $badges[$c['status']];
                $badge = sprintf('<%s> %s </>', $style, str_pad($text, $width + strlen($text) - mb_strlen($text)));
                $output->writeln($badge . ' <options=bold>' . $e($c['label']) . '</>' . ($c['detail'] !== '' ? ': ' . $e($c['detail']) : ''));
                if ($c['fix'] !== '') {
                    $output->writeln(str_repeat(' ', $width + 3) . '<fg=gray>→ ' . $e($c['fix']) . '</>');
                }
            }
        }
        $output->writeln('');
        if ($code !== self::EXIT_OK) {
            $output->writeln($e(sprintf(__('More on each problem: %s.', 'realtime'), Health::TROUBLESHOOTING)));
        }
        $output->writeln(match ($code) {
            self::EXIT_OK      => '<info>' . $e(__('Everything the real-time layer needs is available.', 'realtime')) . '</info>',
            self::EXIT_WARNING => '<comment>' . $e(__('The real-time layer works, with limitations: see the warnings.', 'realtime')) . '</comment>',
            default            => '<error>' . $e(__('The real-time layer cannot work: fix the errors above, from the top.', 'realtime')) . '</error>',
        });
        return $code;
    }
}
