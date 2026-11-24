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
A `sub` on a room already joined re-reads the grant: it refreshes the flags, or, when the
grant is gone, removes the connection from the room and answers `forbidden`.

### Server → client

| `t` | Fields | When |
|---|---|---|
| `hello` | `conn`, `user{id,name}`, `ping_interval` | right after the handshake |
| `subscribed` / `unsubscribed` | `room` | replies |
| `unsubscribed` | `room`, `reason: "forbidden"` | the server removed the subscription (unanswered `regrant`) |
| `pong` | — | reply |
| `error` | `code`, `message` | see codes |
| `bye` | `reason` | just before the server closes |
| `presence` | `room`, `users[{id,name,since,active,avatar?}]` | after `subscribed`, then whenever the list changes |
| `event` | `room`, `kind`, `by{id,name}`, `item{type,id}?`, `fields[]?` | something changed on the item |
| `regrant` | `room` | rights on the item may have changed |
| `notification` | `nid`, `kind`, `room`, `by{id,name}`, `alert` | the user's notifications changed |

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

## Item events

Published by the plugin from GLPI's item hooks, once per item at the end of each GLPI
request (web, API, cron, mail collector), on the Valkey channel `rt:ev`. **No content**:
clients show "Bob added a followup" and the user reloads from GLPI.

| `kind` | `item` | Seen by members with |
|---|---|---|
| `ticket.update` (+ `fields`: changed field names), `ticket.delete`, `ticket.restore`, `ticket.purge` | — | `read` |
| `followup.add` / `.update` / `.delete` | `ITILFollowup` | public: `see_public_followup`; private: `see_private_followup`; always the author |
| `task.add` / `.update` / `.delete` | `TicketTask` | public: `see_public_task`; private: `see_private_task`, or `see_private_task_groups` and a member of the technician group; always the author and the technician |
| `solution.add` / `.update` | `ITILSolution` | `read` |
| `validation.add` / `.update` / `.delete` | `TicketValidation` | `read` |
| `document.add` / `.delete` (attached to the ticket itself) | `Document` | `read` |
| `actor.add` / `.update` / `.delete` | — | `read` |

`by.id` is 0 for automatic actions. Rules mirror GLPI's `canViewItem()`; flags come from the
session's grant and groups from the session key, both written by GLPI.

### Regrant

Removing or changing an actor, or moving the ticket to another entity, may remove
someone's access. The plugin then deletes **every** grant on the item (index
`rt:gi:{room}`) and marks the batch `regrant`. Each member receives `regrant` and from then
on no event for that room. The client calls `ajax/grant.php` (GLPI rewrites the grant, or
deletes it if `READ` is now refused) and sends `sub` again: `subscribed`, or `forbidden`
and the connection leaves the room. Without a new `sub` within
`events.regrant_timeout_secs` (30 s), the server sends `unsubscribed{reason: forbidden}`.

## Notifications

Personal notifications ("bell", Notifier+ feature set) are **stored by GLPI** in
`glpi_plugin_realtime_notifications` and **read from GLPI**: the bell calls
`ajax/inbox.php`, which loads every item and checks `READ` in the user's session before
returning its title, status or requester. The WebSocket only says *"your bell changed"*.

The plugin publishes on `rt:ev`, without `room` when no item event goes with it:

```json
{"by":{"id":7,"name":"Alice"},"notify":[{"to":[9,12],"kind":"assigned","item":"Ticket:5"},
                                        {"to":[7],"kind":"inbox","sync":true}]}
```

Every connected tab of each recipient receives `notification{nid, kind, room, by, alert}`
and refreshes its bell. `alert: true` only in the recipient's active tabs (all of them when
none is active): that tab may ring, depending on the user's sound preferences. `sync` (read
in another tab, preferences saved) never alerts and reaches the author's own tabs; its
`kind` is `inbox` and `room` is empty. The author of a change is never notified of it.

| Event (`kind`) | Recipients |
|---|---|
| `created` | actors of a new ticket/change/problem; **unassigned**: every technician of its entity (no row stored, the "New" queue is computed when the bell is read) |
| `assigned` | assigned user, members of the assigned group (subgroups when membership is recursive), project task team member |
| `commented` | public followup: every actor and "others"; private: assigned technicians only |
| `task_added` | public task: actors and "others"; private: assignees; always the task technician |
| `solution` / `solution_refused` | actors and "others" / assigned technicians (replaces `status_changed`) |
| `status_changed`, `updated` (`detail.fields`) | actors and "others" |
| `validation_asked` / `validation_done` | approver (user or group members) / actors |
| `transferred` | entity changed: actors, or technicians of the new entity when unassigned |

"Others": technicians with the STEAL right on the item's entity who enabled *Notify others*.
Queues are computed per reader: **New** (nobody assigned), **Mine**, **Team** (one of my
groups), **Others**, **Resolved**, **Closed** (or one **Ended** tab). Opening an item marks
its notifications read. Rows are removed when the item is trashed or purged, or for a user
who is no longer an actor; a daily task purges read rows after 30 days and rows of inactive
users.

The self-service interface has no bell: it shows a toast for each `alert`.

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
