# Protocol v1

One WebSocket per browser tab: `wss://<glpi-host>/ws`.

## Handshake

| Check | Failure |
|---|---|
| `Origin` header is in `security.allowed_origins` | `403` |
| Cookie `glpi_rt` holds a 64-hex token whose `sha256` is a live `rt:s:{hash}` key | `401` |
| Fewer than `max_connections_per_user` connections for this user | `429` |
| Fewer than `max_connections` on this instance, Valkey reachable | `503` |

The cookie is set by the plugin (HttpOnly, Secure, SameSite=Strict, `Path=/ws`): the
browser sends it automatically, JavaScript never reads it.

## Text frames (JSON)

Every message carries `"v": 1`. A client may add an integer `"id"`, echoed in the reply.

### Client → server

| `t` | Fields | Reply |
|---|---|---|
| `sub` | `room` (`"Ticket:42"`) | `subscribed` or `error` |
| `unsub` | `room` | `unsubscribed` |
| `ping` | — | `pong` |
| `activity` | `active` (bool) | none; presence lists change for the other members |

A `sub` succeeds only if GLPI wrote a grant `rt:g:{hash}:{room}` with `read=1` for this
session (the plugin does it when the item is displayed, or through `ajax/grant.php`).

### Server → client

| `t` | Fields | When |
|---|---|---|
| `hello` | `conn`, `user{id,name}`, `ping_interval` | right after the handshake |
| `subscribed` / `unsubscribed` | `room` | replies |
| `pong` | — | reply |
| `error` | `code`, `message` | see codes |
| `bye` | `reason` | just before the server closes |
| `presence` | `room`, `users[{id,name,since,active,avatar?}]` | after `subscribed`, then whenever the list changes |

Error codes: `bad_request`, `unsupported_version`, `forbidden`, `rate_limited`,
`too_many_rooms`, `internal`.

## Presence

`presence` lists everyone currently subscribed to the room, **one entry per user**
(several tabs count once), ordered by arrival (`since`, Unix seconds). It includes the
recipient: clients hide their own user id.

- `active`: the user is active on at least one tab — visible, focused (focus inside an
  iframe such as the rich-text editor counts) and used within the last 5 minutes.
  Clients send `activity` only when their state changes (after 1 s of stability) and,
  after a reconnection, before subscribing if they are inactive (the server assumes
  active for a new connection).
- `avatar`: `{picture, initials, color, fg}` computed by the plugin with GLPI's own
  functions (picture thumbnail, else initials on the user's color, or the default
  picture when the entity disables initials). `picture` is a same-origin path or empty.
  The server re-validates every field (relative path with a restricted character set,
  `#hex` colors, at most 4 alphanumeric initials) and the client checks them again.
- Hovering an avatar shows GLPI's user card (`ajax/comments.php`, GLPI's rights apply).
- A connection that subscribes always receives the list.
- Other members receive it only when it changes (arrival, departure, expiry).
- Server side, each connection is a field of the Valkey hash `rt:p:{room}` with a 45 s
  field TTL refreshed every 15 s, so entries of a crashed instance disappear by themselves.
  Changes are announced on `rt:pc` to every instance.

## Closing

| `bye.reason` | Close code | Client behaviour |
|---|---|---|
| `revoked` | 4001 | Do not reconnect: the GLPI session ended or changed. The next GLPI page issues a new token. |
| `shutdown` | 1012 | Reconnect with backoff (server restart). |
| `policy` | 1008 | Too many rate-limit violations. Reconnect with backoff. |
| `idle` | 1001 | No traffic (including pongs) for `idle_timeout_secs`. Reconnect. |
| (none) | 1013 | Client too slow to read: dropped without `bye`. Reconnect. |
| (none) | 1009 | Message larger than `max_message_bytes`. |

Reconnection delay: exponential from 0.5 s to 30 s with jitter (`client/src/backoff.ts`).

## Binary frames

Reserved for collaborative drafts (Yjs, step 5); rejected with `bad_request` until then.
