# Security model

## Principles

1. **GLPI is the only authority.** The Rust server never reads MariaDB nor PHP sessions.
   It only reads what the plugin wrote in Valkey after GLPI checked identities and rights.
2. **Fail open for GLPI, fail closed for real time.** If Valkey or the server is down, GLPI
   works as without the plugin (50 ms timeout, then Valkey is skipped for the request).
   If a check cannot be made, the server refuses (401/503, `forbidden`, `internal`).
3. **No content in transit** except collaborative drafts (step 5), only to authorized
   participants, never logged. Item events carry kinds, ids and changed field names;
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
- Only item types listed in both the plugin (`enabled_itemtypes`) and the server
  (`allowed_itemtypes`) can be subscribed to.

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
`0660 glpi-realtime:http`: only nginx can connect.

## Known limits

- Support agent anonymization (`anonymize_support_agents`) is not applied to presence
  yet: a Self-Service user who can see a ticket sees the names of the technicians on it.
- Profile rights changes (e.g. an administrator removing "see private followups") are not
  pushed: they apply at the user's next login, as in GLPI. Actor and entity changes are
  re-evaluated live (`regrant`).
- During the regrant window (≤ 30 s) a member who lost access still appears in presence
  lists and sees them; they receive no event.
- Approvals (`validation.*`) and documents are announced to every reader of the ticket
  (kind and id only), even if their profile cannot open approvals.
- Logout revocation relies on `post_init` running for `/front/logout.php` (verified by the
  end-to-end tests on GLPI 12.0.0); the session TTL is the fallback.
