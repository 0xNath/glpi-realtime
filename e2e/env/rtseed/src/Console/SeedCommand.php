<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Rtseed\Console;

use Glpi\Console\AbstractCommand;
use Profile;
use Profile_User;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Ticket;
use User;

/**
 * Creates (or resets) the e2e accounts and ticket, as e2e/README.md describes them:
 * rt-alice (Technician), rt-bob (Super-Admin, also Technician), rt-carol (Technician and
 * Self-Service), and a ticket requested by "glpi", which Self-Service users do not see.
 * Prints "ticket=<id>".
 */
final class SeedCommand extends AbstractCommand
{
    protected function configure()
    {
        parent::configure();
        $this->setName('plugins:rtseed:seed');
        $this->setDescription('Creates the e2e accounts and ticket (tests only)');
        foreach (['alice', 'bob', 'carol'] as $who) {
            $this->addOption("$who-password", null, InputOption::VALUE_REQUIRED);
        }
    }

    private function profile(string $name): int
    {
        $p = new Profile();
        if (!$p->getFromDBByCrit(['name' => $name])) {
            throw new \RuntimeException("No profile named $name");
        }
        return (int) $p->getID();
    }

    /** @param list<string> $profiles the first one is the default */
    private function user(string $login, string $password, array $profiles): int
    {
        $user = new User();
        $input = ['name' => $login, 'realname' => $login, 'password' => $password, 'password2' => $password, 'is_active' => 1];
        if ($user->getFromDBbyName($login)) {
            $id = (int) $user->getID();
            $user->update(['id' => $id] + $input);
        } else {
            $id = (int) $user->add($input);
        }
        if ($id <= 0) {
            throw new \RuntimeException("Cannot create $login");
        }
        $pu = new Profile_User();
        $pu->deleteByCriteria(['users_id' => $id], true);
        foreach ($profiles as $name) {
            $pu->add(['users_id' => $id, 'profiles_id' => $this->profile($name), 'entities_id' => 0, 'is_recursive' => 1]);
        }
        $user->update(['id' => $id, 'profiles_id' => $this->profile($profiles[0])]);
        return $id;
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $passwords = [];
        foreach (['alice', 'bob', 'carol'] as $who) {
            $passwords[$who] = (string) $input->getOption("$who-password");
            if ($passwords[$who] === '') {
                throw new \InvalidArgumentException("--$who-password is required");
            }
        }
        $this->user('rt-alice', $passwords['alice'], ['Technician']);
        $this->user('rt-bob', $passwords['bob'], ['Super-Admin', 'Technician']);
        $this->user('rt-carol', $passwords['carol'], ['Technician', 'Self-Service']);

        $glpi = new User();
        $glpi->getFromDBbyName('glpi');
        $ticket = new Ticket();
        $id = (int) $ticket->add([
            'name'                => 'glpi-realtime e2e',
            'content'             => 'Ticket of the end-to-end tests.',
            'entities_id'         => 0,
            '_users_id_requester' => (int) $glpi->getID(),
        ]);
        if ($id <= 0) {
            throw new \RuntimeException('Cannot create the ticket');
        }
        $output->writeln("ticket=$id");
        return 0;
    }
}
