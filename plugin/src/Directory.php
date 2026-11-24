<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

/**
 * Who is concerned by an item: GLPI database lookups used to choose the recipients of a
 * notification. Behind an interface so that the recording rules can be tested without
 * a database.
 */
interface Directory
{
    /**
     * User actors of an ITIL object: direct ones, and members of actor groups
     * (with subgroups when the group has recursive membership). Direct wins over group.
     *
     * @return array<int, array{channel: 'direct'|'group', types: list<int>}> uid => how
     */
    public function actors(string $itemtype, int $id): array;

    /** Whether a user or a group is assigned (CommonITILActor::ASSIGN). */
    public function hasAssignee(string $itemtype, int $id): bool;

    /** Active members of a group, subgroups included when membership is recursive. @return list<int> */
    public function groupMembers(int $groups_id): array;

    /**
     * Active users with a central (technician) profile covering the entity: on the entity
     * itself, or recursive on one of its ancestors.
     *
     * @return list<int>
     */
    public function technicians(int $entities_id): array;

    /**
     * Technicians covering the entity who may see items they are not actors of (STEAL
     * right on the item type) and asked to be told (`notify_others` preference).
     *
     * @return list<int>
     */
    public function others(string $itemtype, int $entities_id): array;

    /** Team of a project task. @return array<int, 'direct'|'group'> */
    public function projectTaskMembers(int $projecttasks_id): array;

    /** Entity of an item, -1 when it does not exist. */
    public function entityOf(string $itemtype, int $id): int;
}
