<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Rtseed\Console;

use Glpi\Console\AbstractCommand;
use Plugin;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * The realtime plugin's state and data, as JSON, for the upgrade test: its version and
 * state in GLPI, and the rows of each of its tables (which an upgrade must keep).
 */
final class CountCommand extends AbstractCommand
{
    protected function configure()
    {
        parent::configure();
        $this->setName('plugins:rtseed:count');
        $this->setDescription('The realtime plugin\'s version, state and table rows (tests only)');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        global $DB;
        $plugin = new Plugin();
        $plugin->getFromDBbyDir('realtime');
        $tables = [];
        foreach ($DB->listTables('glpi_plugin_realtime_%') as $t) {
            $name = $t['TABLE_NAME'];
            $tables[$name] = countElementsInTable($name);
        }
        ksort($tables);
        $output->writeln(json_encode([
            'version' => $plugin->fields['version'] ?? null,
            'active'  => (int) ($plugin->fields['state'] ?? 0) === Plugin::ACTIVATED,
            'tables'  => $tables,
        ], JSON_UNESCAPED_SLASHES));
        return 0;
    }
}
