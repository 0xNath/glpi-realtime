<?php

/**
 * Minimal GLPI doubles so the plugin classes can run against a real Valkey
 * without a GLPI installation. Usage: php -d extension=igbinary -d extension=redis <script> <valkey-port>
 */

declare(strict_types=1);

define('READ', 1);
define('UPDATE', 2);
define('ERROR', 1);

final class Session
{
    public static mixed $uid = false;
    /** @var array<string, int> */
    public static array $rights = [];

    public static function getLoginUserID($force_human = true): mixed
    {
        return self::$uid;
    }

    public static string $interface = 'central';

    public static function getCurrentInterface(): string
    {
        return self::$interface;
    }

    /** @var list<array{string, int}> */
    public static array $messages = [];

    public static function addMessageAfterRedirect($msg, $check_once = false, $message_type = 0, $reset = false): void
    {
        self::$messages[] = [$msg, $message_type];
    }

    public static function haveRight(string $module, int $right): bool
    {
        return ((self::$rights[$module] ?? 0) & $right) === $right;
    }
}

final class Config
{
    public static array $values = [];

    public static function getConfigurationValues($context, array $names = []): array
    {
        return self::$values;
    }
}

final class Toolbox
{
    public static array $logs = [];

    public static function getFgColor(string $color = "", int $offset = 40, bool $inherit_if_transparent = false): string
    {
        return '#ffffff';
    }

    public static function logInFile($name, $text): void
    {
        self::$logs[] = [$name, $text];
    }
}

function __(string $str, string $domain = 'glpi'): string
{
    return $str;
}

function _n(string $singular, string $plural, int $nb, string $domain = 'glpi'): string
{
    return $nb > 1 ? $plural : $singular;
}

function getUserName(int|string $id, int $link = 0, bool $disable_anon = false): string
{
    return User::$db[(int) $id]['name'] ?? '';
}

function htmlescape(mixed $str): string
{
    return htmlspecialchars((string) $str, ENT_QUOTES);
}

final class Entity
{
    public const ANONYMIZE_DISABLED = 0;
    public const ANONYMIZE_USE_GENERIC = 1;
    public const ANONYMIZE_USE_NICKNAME = 2;
    public static int $anonymize = self::ANONYMIZE_DISABLED;
    public static bool $initials = true;

    public static function getAnonymizeConfig(?int $entities_id = null): int
    {
        return self::$anonymize;
    }

    public static function getUsedConfig($fieldref, $entities_id, $fieldval = '', $default_value = -2)
    {
        return $fieldref === 'display_users_initials' ? self::$initials : null;
    }
}

final class User extends CommonDBTM
{
    /** @var array<int, array{name: string, picture: ?string}> */
    public static array $db = [];
    public array $fields = [];

    public function getFromDB($id): bool
    {
        if (!isset(self::$db[$id])) {
            return false;
        }
        $this->fields = self::$db[$id] + ['id' => $id];
        return true;
    }

    public function getThumbnailPicturePath(bool $enable_anonymization = false): ?string
    {
        return $this->fields['picture'] ? '/front/document.send.php?file=_pictures/' . $this->fields['picture'] : null;
    }

    public function getPicturePath(bool $enable_anonymization = false): string
    {
        return '/pics/picture.png';
    }

    public function getUserInitials(bool $enable_anonymization = false): string
    {
        return strtoupper(substr($this->fields['name'], 0, 2));
    }

    public static function getAnonymizedNameForUser(int $users_id, ?int $entities_id = null): ?string
    {
        return match (Entity::$anonymize) {
            Entity::ANONYMIZE_DISABLED => null,
            Entity::ANONYMIZE_USE_NICKNAME => self::$db[$users_id]['nickname'] ?? '',
            default => 'Helpdesk user',
        };
    }

    public function getUserInitialsBgColor(bool $enable_anonymization = false): string
    {
        return '#5a7f9e';
    }
}

abstract class CommonDBTM
{
    public array $fields = [];
    public array $updates = [];
    public array $oldvalues = [];
    public mixed $input = [];
    public bool $readable = true;

    public function __construct(array $fields = [], array $updates = [])
    {
        $this->fields = $fields;
        $this->updates = $updates;
    }

    public function getID(): int
    {
        return (int) ($this->fields['id'] ?? 0);
    }

    public function isNewItem(): bool
    {
        return $this->getID() <= 0;
    }

    public function can($id, $right): bool
    {
        return $this->readable;
    }
}

abstract class CommonITILObject extends CommonDBTM
{
    public const INCOMING = 1;
    public const ASSIGNED = 2;
    public const SOLVED = 5;
    public const CLOSED = 6;

    public bool $updatable = false;

    public function canUpdateItem(): bool
    {
        return $this->updatable;
    }

    public function canAddFollowups(): bool
    {
        return true;
    }

    public function canAddTasks(): bool
    {
        return false;
    }

    public function canSolve(): bool
    {
        return false;
    }
}

final class Ticket extends CommonITILObject
{
    /** @var array<int, array<int, list<int>>> tickets_id => type => users */
    public static array $actors = [];

    public function getFromDB($id): bool
    {
        if (!isset(self::$actors[$id])) {
            return false;
        }
        $this->fields = ['id' => $id];
        return true;
    }

    public function getUsers($type): array
    {
        return array_map(static fn(int $u) => ['users_id' => $u], self::$actors[$this->getID()][$type] ?? []);
    }
}

final class Change extends CommonITILObject {}

final class Profile_User extends CommonDBTM {}

final class Profile extends CommonDBTM {}

final class ProfileRight extends CommonDBTM {}

final class Problem extends CommonITILObject {}

final class ProjectTask extends CommonDBTM {}

final class ProjectTaskTeam extends CommonDBTM {}

abstract class CommonITILValidation extends CommonDBTM
{
    public const WAITING = 2;
    public const ACCEPTED = 3;
    public const REFUSED = 4;
}

final class ChangeValidation extends CommonITILValidation {}

final class ChangeTask extends CommonDBTM {}

final class ProblemTask extends CommonDBTM {}

final class Problem_User extends CommonITILActor {}

final class Group_Problem extends CommonITILActor {}

abstract class CommonITILActor extends CommonDBTM
{
    public const REQUESTER = 1;
    public const ASSIGN    = 2;
    public const OBSERVER  = 3;
}

final class Ticket_User extends CommonITILActor {}

final class Group_Ticket extends CommonITILActor {}

final class Supplier_Ticket extends CommonITILActor {}

final class ITILSolution extends CommonDBTM {}

final class TicketValidation extends CommonITILValidation {}

final class Change_User extends CommonITILActor {}

final class Change_Group extends CommonITILActor {}

final class Document_Item extends CommonDBTM {}

final class Group_User extends CommonDBTM
{
    /** @var array<int, list<int>> */
    public static array $members = [];

    public static function getGroupUsers($groups_id, $condition = []): array
    {
        return array_map(static fn(int $u) => ['id' => $u], self::$members[$groups_id] ?? []);
    }
}

final class Computer extends CommonDBTM {}

final class ITILFollowup extends CommonDBTM
{
    public const SEEPUBLIC = 1;
    public const SEEPRIVATE = 8192;
    public const SEEPRIVATEGROUPS = 65536;
    public static string $rightname = 'followup';
}

abstract class CommonITILTask extends CommonDBTM
{
    public const SEEPUBLIC = 1;
    public const SEEPRIVATE = 8192;
    public const SEEPRIVATEGROUPS = 65536;
    public static string $rightname = 'task';
}

final class TicketTask extends CommonITILTask {}

require __DIR__ . '/../setup.php';

use GlpiPlugin\Realtime\Directory;
use GlpiPlugin\Realtime\Valkey;

/** Directory with canned answers, for the notification rules. */
final class FakeDirectory implements Directory
{
    /** @var array<string, array<int, array{channel: string, types: list<int>}>> "Ticket:5" => actors */
    public array $actors = [];
    /** @var array<int, list<int>> */
    public array $groups = [];
    /** @var array<int, list<int>> entity => technicians */
    public array $technicians = [];
    /** @var array<int, list<int>> entity => others */
    public array $others = [];
    /** @var array<int, array<int, string>> */
    public array $teams = [];
    /** @var array<string, int> */
    public array $entities = [];

    public function actors(string $itemtype, int $id): array
    {
        return $this->actors["$itemtype:$id"] ?? [];
    }

    public function hasAssignee(string $itemtype, int $id): bool
    {
        foreach ($this->actors($itemtype, $id) as $a) {
            if (in_array(CommonITILActor::ASSIGN, $a['types'], true)) {
                return true;
            }
        }
        return false;
    }

    public function groupMembers(int $groups_id): array
    {
        return $this->groups[$groups_id] ?? [];
    }

    public function technicians(int $entities_id): array
    {
        return $this->technicians[$entities_id] ?? [];
    }

    public function others(string $itemtype, int $entities_id): array
    {
        return $this->others[$entities_id] ?? [];
    }

    public function projectTaskMembers(int $projecttasks_id): array
    {
        return $this->teams[$projecttasks_id] ?? [];
    }

    public function entityOf(string $itemtype, int $id): int
    {
        return $this->entities["$itemtype:$id"] ?? 0;
    }

    /** @var array<int, int> ticket id => time to resolve (Unix) */
    public array $due = [];
    /** @var list<array{0: string, 1: int, 2: string, 3: string, 4: int}> type, id, event, detail, uid */
    public array $notifiedRows = [];

    public function dueTickets(int $from, int $to): array
    {
        return array_filter($this->due, static fn(int $t) => $t >= $from && $t <= $to);
    }

    public function notified(string $itemtype, int $id, string $event, string $detail): array
    {
        $out = [];
        foreach ($this->notifiedRows as [$t, $i, $e, $d, $u]) {
            if ($t === $itemtype && $i === $id && $e === $event && $d === $detail) {
                $out[] = $u;
            }
        }
        return $out;
    }
}

/** $target: TCP port on 127.0.0.1, or path of a unix socket. */
function test_valkey(string $target): Redis
{
    $r = new Redis();
    if (str_starts_with($target, '/')) {
        $r->connect($target);
    } else {
        $r->connect('127.0.0.1', (int) $target, 1.0);
    }
    $r->select(6);
    Valkey::$override = $r;
    return $r;
}

$GLOBALS['failures'] = 0;
function check(bool $cond, string $label): void
{
    echo ($cond ? "ok   " : "FAIL ") . $label . "\n";
    if (!$cond) {
        $GLOBALS['failures']++;
    }
}
