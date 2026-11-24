# Security model

## Principles

1. **GLPI is the only authority.** The Rust server never reads MariaDB nor PHP sessions.
   It only reads what the plugin wrote in Valkey after GLPI checked identities and rights.
2. **Fail open for GLPI, fail closed for real time.** If Valkey or the server is down, GLPI
   works as without the plugin (50 ms timeout, then Valkey is skipped for the request).
   If a check cannot be made, the server refuses (401/503, `forbidden`, `internal`).
3. **No content in transit** except shared answer drafts (step 5), only to members GLPI
   allows to add that kind of answer (and to see private ones when the draft is private),
   never logged, shown in a sandboxed frame. Item events carry kinds, ids and changed field names;
   browsers reload the content from GLPI.

## Session token

| Property | How |
|---|---|
| Unguessable | 256 bits from `random_bytes(32)` |
| Not readable by JavaScript (XSS) | Cookie `HttpOnly` |
| Not sent elsewhere | `Path=/ws`, `Secure`, `SameSite=Strict` |
| Not stored in clear | Valkey key is `sha256(token)`; the token only exists in the cookie |
| Bound to the GLPI session | Hash kept in `$_SESSION`; TTL = PHP session lifetime, slid by each GLPI request |
| Revoked on logout | `post_init` on `/front/logout.php` deletes the key |
| Revoked on identity change | Impersonation: new token, old key deleted |
| Revocation reaches open sockets | Keyspace notifications (instant) + sweep every 15 s |

Cross-site WebSocket hijacking is blocked by the `Origin` allow-list (SameSite=Strict
already prevents the cookie from being sent from another site).

## Authorization

- A grant `rt:g:{hash}:{Itemtype}:{id}` is written only after `$item->can($id, READ)`,
  when GLPI displays the item, or on `ajax/grant.php` (same check).
- Grants belong to one token: they cannot be reused by another session.
- Grants expire with the session token. Flags (`see_public_followup`,
  `see_private_followup`, `see_public_task`, `see_private_task`, `see_private_task_groups`)
  filter item events with the rules of GLPI's `canViewItem()`: a session never learns
  that a private followup or task exists unless GLPI would show it.
- Rights changes on an item (actor removed or demoted, entity moved) delete every grant on
  it. Members receive no further event until GLPI grants them again (`regrant`), and are
  removed from the item after 30 s otherwise. `ajax/grant.php` deletes the grant when
  GLPI refuses `READ`.
- Notifications are addressed by user id, chosen by the plugin among the item's actors
  (and technicians of its entity for unassigned items). The WebSocket frame carries the
  item reference and the author's name only. The bell reads its list from GLPI, in the
  recipient's session: every item is loaded and must pass `can(READ)` before its title,
  status or requesters are returned, so entity, profile and actor changes apply at once.
  Ajax endpoints act on the session user's rows only; "Assume" uses GLPI's
  `canAssignToMe()`. CSRF: GLPI's own `Sec-Fetch-Site`/`Origin` check on every POST.
- Events are published by the plugin only; the server validates every batch (kinds, item
  types, field names, sizes) and drops malformed ones. Valkey itself is a trust boundary:
  whoever can write to it can forge sessions, grants and events. Keep it local, behind
  its `0660` socket and, if it also listens on TCP, an ACL or `requirepass`.
- A room is joined only with a grant the plugin wrote for that very item, and the plugin
  writes grants for its `enabled_itemtypes` only: the server follows that list. A room
  name is `<PHP class name>:<id>` (canonical id, at most 100 characters of class name,
  checked before it becomes part of a Valkey key); `[security] allowed_itemtypes`, when
  set, restricts the item types further (defense in depth).
- Valkey restarted without persistence: sessions and grants are gone. The server closes
  the sockets as revoked (sweep); a tab then makes one GLPI request
  (`ajax/session.php`): GLPI, which still knows the user, issues a new token (logged out:
  refused, the tab stays disconnected), and grants are asked again through
  `ajax/grant.php`, so GLPI decides again on every item. At most one such request per
  tab every 30 s.

## Single editor

Taking the fields lock requires the grant flag `update` computed by GLPI
(`canUpdateItem()`); a connection can only renew or release its own lock, and can take
another's only when that holder's tab is inactive or gone. The lock is advisory: it does
not replace GLPI's rights checks on save.

## Live timeline and solutions

Timeline items are never sent over the WebSocket: each browser reloads its ticket tab from
GLPI, in its own session, and merges the timeline entries GLPI rendered for it. A second
solution is refused by GLPI itself (plugin `pre_item_add`, serialized per item with
MariaDB `GET_LOCK`), whatever the browsers do.

## Shared drafts

A draft's HTML comes from another user's editor: followers render it in an
`<iframe sandbox>` (no scripts, opaque origin) whose CSP forbids any load, so it can
neither run code in their page nor reveal them to a remote host. The server checks the
writer's and each follower's grant flags; drafts are capped at 48 KiB and expire 15 min
after their last change.

## Rights changes during a session

Adding or removing a profile or a group to a user, or changing a profile's rights, deletes
every grant of that user's sessions (indexes `rt:us:{uid}`, `rt:gs:{hash}`); their open
tabs are told to regrant (only theirs). Deactivating, trashing or purging a user revokes
their sessions: the server closes their connections.

## Saving the fields

The fields form carries the item's `date_mod` as displayed; GLPI (plugin
`pre_item_update`) refuses to save it if the item changed meanwhile, and tells the user
who changed it. This holds even for a browser without the client or a lock taken over.

## Anonymized support agents

When the entity anonymizes agents for self-service users, the plugin computes how each
agent appears to them (GLPI's generic name or nickname, neutral initials, no picture).
The server applies it to every frame sent to a self-service session of such an entity
(presence, authors, lock holders, draft writers) and strips it from every other frame.

## Values displayed in other users' pages

Names and avatars travel from one user's session to others' pages. Names are inserted as
text only (`textContent`, `aria-label`). Avatar pictures must be same-origin relative
paths made of a restricted character set (no quote, parenthesis, backslash or space, no
`//`), colors must be `#hex`: checked by the server and again by the client before being
used in `style`. User cards come from GLPI itself (`ajax/comments.php`, `canView()`).

## Abuse limits (per instance)

Connections per user and per instance, message size, rooms per connection, token buckets
per connection and per user, disconnection after repeated violations, idle timeout,
bounded outbound queue (slow clients are dropped), handshake rate limit in nginx.

## Process isolation

systemd sandbox: dedicated user, no capabilities, read-only system, no home, private
`/tmp` and `/dev`, W^X memory, syscall filter, only UNIX/INET sockets. The socket is
`0660`, owned by the web server's group (`listen.group`): only it can connect.

## Known limits

- Anonymized agents are computed with the agent's own active entity (GLPI uses the
  viewer's): with different settings per entity, the agent's entity decides.
- During the regrant window (≤ 30 s) a member who lost access still appears in presence
  lists and sees them; they receive no event.
- Approvals (`validation.*`) and documents are announced to every reader of the ticket
  (kind and id only), even if their profile cannot open approvals.
- Logout revocation relies on `post_init` running for `/front/logout.php` (verified by the
  end-to-end tests, on GLPI 11.0 and 12.0); the session TTL is the fallback.
