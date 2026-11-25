<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Rtseed\Console;

use CronTask;
use Glpi\Console\AbstractCommand;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * Runs one of the realtime plugin's automatic actions now, as GLPI's cron would (tests
 * only): fails when the upgrade did not register it.
 */
final class CronCommand extends AbstractCommand
{
    protected function configure()
    {
        parent::configure();
        $this->setName('plugins:rtseed:cron');
        $this->setDescription('Run an automatic action of the realtime plugin now (tests only)');
        $this->addArgument('task', InputArgument::REQUIRED, 'Its name, e.g. slaalert');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $name = (string) $input->getArgument('task');
        $task = new CronTask();
        if (!$task->getFromDBbyName(\GlpiPlugin\Realtime\Inbox::class, $name)) {
            $output->writeln("<error>$name is not registered</error>");
            return 1;
        }
        $ran = CronTask::launch(CronTask::MODE_EXTERNAL, 1, $name);
        $output->writeln("$name: " . ($ran === false ? 'not run' : 'run'));
        return $ran === false ? 1 : 0;
    }
}
