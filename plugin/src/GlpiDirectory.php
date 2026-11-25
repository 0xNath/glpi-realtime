<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use CommonITILActor;

/** Directory backed by GLPI's database. Every query is bounded (MAX users). */
final class GlpiDirectory implements Directory
{
    /** Recipients per lookup: protects GLPI from fan-outs to whole directories. */
    public const MAX = 1000;

    /** ITIL object => [user link class, group link class, foreign key]. */
    public const LINKS = [
        'Ticket'  => ['Ticket_User', 'Group_Ticket', 'tickets_id'],
        'Change'  => ['Change_User', 'Change_Group', 'changes_id'],
        'Problem' => ['Problem_User', 'Group_Problem', 'problems_id'],
    ];

    /** Item type => profile right name, for STEAL ("see items I am not an actor of"). */
    private const RIGHTS = ['Ticket' => 'ticket', 'Change' => 'change', 'Problem' => 'problem'];

    public function actors(string $itemtype, int $id): array
    {
        global $DB;
        if (!isset(self::LINKS[$itemtype]) || $id <= 0) {
            return [];
        }
        [$userLink, $groupLink, $fk] = self::LINKS[$itemtype];
        $out = [];
        foreach ($DB->request(['SELECT' => ['users_id', 'type'], 'FROM' => $userLink::getTable(), 'WHERE' => [$fk => $id]]) as $row) {
            $uid = (int) $row['users_id'];
            if ($uid > 0) {
                $out[$uid]['channel'] = 'direct';
                $out[$uid]['types'][] = (int) $row['type'];
            }
        }
        $groupsByType = [];
        foreach ($DB->request(['SELECT' => ['groups_id', 'type'], 'FROM' => $groupLink::getTable(), 'WHERE' => [$fk => $id]]) as $row) {
            $groupsByType[(int) $row['type']][] = (int) $row['groups_id'];
        }
        foreach ($groupsByType as $type => $groups) {
            foreach ($this->members($groups) as $uid) {
                if (($out[$uid]['channel'] ?? null) !== 'direct') {
                    $out[$uid]['channel'] = 'group';
                }
                $out[$uid]['types'][] = $type;
            }
        }
        foreach ($out as &$a) {
            $a['types'] = array_values(array_unique($a['types']));
        }
        return $out;
    }

    public function hasAssignee(string $itemtype, int $id): bool
    {
        global $DB;
        if (!isset(self::LINKS[$itemtype])) {
            return false;
        }
        [$userLink, $groupLink, $fk] = self::LINKS[$itemtype];
        foreach ([$userLink, $groupLink] as $link) {
            $n = $DB->request(['COUNT' => 'cpt', 'FROM' => $link::getTable(), 'WHERE' => [$fk => $id, 'type' => CommonITILActor::ASSIGN]])->current();
            if ((int) ($n['cpt'] ?? 0) > 0) {
                return true;
            }
        }
        return false;
    }

    public function groupMembers(int $groups_id): array
    {
        return $groups_id > 0 ? $this->members([$groups_id]) : [];
    }

    /** @param list<int> $groups @return list<int> */
    private function members(array $groups): array
    {
        global $DB;
        $groups = $this->withSubgroups(array_values(array_filter($groups, static fn(int $g) => $g > 0)));
        if ($groups === []) {
            return [];
        }
        $out = [];
        foreach ($DB->request([
            'SELECT'     => ['gu.users_id'],
            'DISTINCT'   => true,
            'FROM'       => 'glpi_groups_users AS gu',
            'INNER JOIN' => ['glpi_users AS u' => ['ON' => ['u' => 'id', 'gu' => 'users_id']]],
            'WHERE'      => ['gu.groups_id' => $groups, 'u.is_active' => 1, 'u.is_deleted' => 0],
            'LIMIT'      => self::MAX,
        ]) as $row) {
            $out[] = (int) $row['users_id'];
        }
        return $out;
    }

    /** Groups with recursive membership include the members of their subgroups. */
    private function withSubgroups(array $groups): array
    {
        global $DB;
        if ($groups === []) {
            return [];
        }
        $all = $groups;
        foreach ($DB->request(['SELECT' => ['id', 'recursive_membership'], 'FROM' => 'glpi_groups', 'WHERE' => ['id' => $groups]]) as $row) {
            if ($row['recursive_membership']) {
                $all = [...$all, ...array_map('intval', array_keys(getSonsOf('glpi_groups', (int) $row['id'])))];
            }
        }
        return array_values(array_unique($all));
    }

    /** Profiles covering an entity: on it, or recursive on an ancestor. */
    private function coveringCriteria(int $entities_id): array
    {
        $ancestors = $entities_id > 0 ? array_map('intval', array_keys(getAncestorsOf('glpi_entities', $entities_id))) : [];
        return ['OR' => [
            ['pu.entities_id' => $entities_id],
            ['pu.is_recursive' => 1, 'pu.entities_id' => [...$ancestors, $entities_id]],
        ]];
    }

    public function technicians(int $entities_id): array
    {
        return $this->centralUsers($entities_id);
    }

    public function others(string $itemtype, int $entities_id): array
    {
        $right = self::RIGHTS[$itemtype] ?? null;
        if ($right === null) {
            return [];
        }
        $candidates = $this->centralUsers($entities_id, $right, \Ticket::STEAL);
        return array_values(array_filter($candidates, static fn(int $uid) => (bool) Inbox::preferences($uid)['notify_others']));
    }

    /** @return list<int> */
    private function centralUsers(int $entities_id, ?string $right = null, int $bit = 0): array
    {
        global $DB;
        if ($entities_id < 0) {
            return [];
        }
        $join = [
            'glpi_profiles AS p' => ['ON' => ['p' => 'id', 'pu' => 'profiles_id']],
            'glpi_users AS u'    => ['ON' => ['u' => 'id', 'pu' => 'users_id']],
        ];
        $where = ['p.interface' => 'central', 'u.is_active' => 1, 'u.is_deleted' => 0, $this->coveringCriteria($entities_id)];
        if ($right !== null) {
            $join['glpi_profilerights AS pr'] = ['ON' => ['pr' => 'profiles_id', 'p' => 'id']];
            $where['pr.name'] = $right;
            $where[] = new \Glpi\DBAL\QueryExpression('(' . $DB::quoteName('pr.rights') . ' & ' . (int) $bit . ') = ' . (int) $bit);
        }
        $out = [];
        foreach ($DB->request([
            'SELECT'     => ['pu.users_id'],
            'DISTINCT'   => true,
            'FROM'       => 'glpi_profiles_users AS pu',
            'INNER JOIN' => $join,
            'WHERE'      => $where,
            'LIMIT'      => self::MAX,
        ]) as $row) {
            $out[] = (int) $row['users_id'];
        }
        return $out;
    }

    public function projectTaskMembers(int $projecttasks_id): array
    {
        global $DB;
        $out = [];
        foreach ($DB->request(['SELECT' => ['itemtype', 'items_id'], 'FROM' => 'glpi_projecttaskteams', 'WHERE' => ['projecttasks_id' => $projecttasks_id]]) as $row) {
            if ($row['itemtype'] === 'User') {
                $out[(int) $row['items_id']] = 'direct';
            } elseif ($row['itemtype'] === 'Group') {
                foreach ($this->groupMembers((int) $row['items_id']) as $uid) {
                    $out[$uid] ??= 'group';
                }
            }
        }
        unset($out[0]);
        return $out;
    }

    public function entityOf(string $itemtype, int $id): int
    {
        if (!is_a($itemtype, \CommonDBTM::class, true) || $id <= 0) {
            return -1;
        }
        $item = new $itemtype();
        return $item->getFromDB($id) ? (int) ($item->fields['entities_id'] ?? 0) : -1;
    }

    public function dueTickets(int $from, int $to): array
    {
        global $DB;
        $out = [];
        $rows = $DB->request([
            'SELECT' => ['id', 'time_to_resolve'],
            'FROM'   => \Ticket::getTable(),
            'WHERE'  => [
                'is_deleted' => 0,
                'NOT'        => ['status' => [\CommonITILObject::SOLVED, \CommonITILObject::CLOSED]],
                'AND'        => [
                    ['time_to_resolve' => ['>=', date('Y-m-d H:i:s', $from)]],
                    ['time_to_resolve' => ['<=', date('Y-m-d H:i:s', $to)]],
                ],
            ],
        ]);
        foreach ($rows as $row) {
            $ttr = strtotime((string) $row['time_to_resolve']);
            if ($ttr !== false) {
                $out[(int) $row['id']] = $ttr;
            }
        }
        return $out;
    }

    public function notified(string $itemtype, int $id, string $event, string $detail): array
    {
        global $DB;
        $out = [];
        $rows = $DB->request([
            'SELECT' => ['users_id'],
            'FROM'   => Inbox::TABLE,
            'WHERE'  => ['itemtype' => $itemtype, 'items_id' => $id, 'event' => $event, 'detail' => $detail],
        ]);
        foreach ($rows as $row) {
            $out[] = (int) $row['users_id'];
        }
        return $out;
    }
}
