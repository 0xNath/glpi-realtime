# Security model

## Principles

1. **GLPI is the only authority.** The Rust server never reads MariaDB nor PHP sessions.
   It only reads what the plugin wrote in Valkey after GLPI checked identities and rights.
2. **Fail open for GLPI, fail closed for real time.** If Valkey or the server is down, GLPI
   works as without the plugin (50 ms timeout, then Valkey is skipped for the request).
   If a check cannot be made, the server refuses (401/503, `forbidden`, `internal`).
3. **No content in transit** except collaborative drafts (step 5), only to authorized
   participants, never logged.

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
- Grants expire with the session token. Flags (`update`, `see_private_followup`, …) will
  filter events in later steps; private items are never sent to sessions without the
  matching flag.
- Only item types listed in both the plugin (`enabled_itemtypes`) and the server
  (`allowed_itemtypes`) can be subscribed to.

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
- Rights changes (actors, profile) are re-evaluated when the item is displayed again;
  live re-evaluation (`regrant`) comes with ticket events (step 3).
- Logout revocation relies on `post_init` running for `/front/logout.php` (verified by the
  end-to-end tests on GLPI 12.0.0); the session TTL is the fallback.
