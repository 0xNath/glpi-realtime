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
| `sub` | `room` (`"Ticket:42"`, `"Change:7"`, `"Computer:3"`, `"Glpi\\CustomAsset\\ServerAsset:4"`: a PHP class name and a canonical id; restricted by `security.allowed_itemtypes` when set) | `subscribed` or `error` |
| `unsub` | `room` | `unsubscribed` |
| `ping` | — | `pong` |
| `activity` | `active` (bool) | none; presence lists change for the other members |
| `lock` | `room`, `force?`, `scope?` (`fields`, `solution`), `reason?` (`solution`, `pending`) | `lock` (see [Single editor](#single-editor)) |
| `unlock` | `room`, `scope?` | `lock` |
| `draft` | `room`, `kind` (`followup`, `task`, `solution`), `html`, `private` | none, or `error` `locked` / `too_large` / `forbidden` |
| `draft_end` | `room`, `kind` | none |
| `draft_watch` | `room`, `kind`, `on` | `draft` (current content) when `on` |
| `draft_take` | `room`, `kind` | `draft` (now ours) or `error` `locked` |
| `watch` | `rooms` (list of items, replaces the previous set) | `watching{rooms}`: those with a `read` grant (max `limits.max_watched_rooms`) |
| `compose` | `room`, `kind` (`followup`, `task`, `solution`, `validation`, `document`) or `null` | none; presence lists change |

A `sub` succeeds only if GLPI wrote a grant `rt:g:{hash}:{room}` with `read=1` for this
session (the plugin does it when the item is displayed, or through `ajax/grant.php`).
A `sub` on a room already joined re-reads the grant: it refreshes the flags, or, when the
grant is gone, removes the connection from the room and answers `forbidden`.

### Server → client

| `t` | Fields | When |
|---|---|---|
| `hello` | `conn`, `user{id,name}`, `ping_interval`, `lock_ttl` | right after the handshake |
| `subscribed` / `unsubscribed` | `room` | replies |
| `unsubscribed` | `room`, `reason: "forbidden"` | the server removed the subscription (unanswered `regrant`) |
| `pong` | — | reply |
| `error` | `code`, `message` | see codes |
| `bye` | `reason` | just before the server closes |
| `presence` | `room`, `users[{id,name,since,active,avatar?,composing?}]` | after `subscribed`, then whenever the list changes |
| `event` | `room`, `kind`, `by{id,name}`, `item{type,id}?`, `fields[]?` | something changed on the item |
| `regrant` | `room` | rights on the item may have changed |
| `changed` | `room` | to list pages following the item (`watch`): it changed; no content |
| `lock` | `room`, `scope`, `holder{conn,id,name,since,avatar?}` or `null` | after `subscribed`, on change, reply to `lock`/`unlock` |
| `draft` | `room`, `kind`, `draft{writer,html,private,updated}` or `null` | to followers, on each change |
| `draft_info` | `room`, `kind`, `writer` or `null`, `private`, `updated`, `away` | to members allowed to follow it, after `subscribed` and on change |
| `notification` | `nid`, `kind`, `room`, `by{id,name}`, `alert` | the user's notifications changed |

Self-service sessions of entities that anonymize support agents receive agents' names
and avatars anonymized in every frame (see the security model).

Error codes: `bad_request`, `unsupported_version`, `forbidden`, `rate_limited`,
`too_many_rooms`, `locked`, `too_large`, `internal`.

## Presence

**List pages** (search results of tickets, changes, problems) show who is on each row: the
client asks GLPI for grants on the displayed rows (`ajax/grants.php`, `READ` checked per
item), then sends `watch`. It receives `presence` for those items without being listed in
them, and without events, locks or drafts; instead, `changed{room}` when one of them changed
in a way anyone who may read it sees (an event without `vis.right`: fields, status, actors,
solution, approval, document; not followups or tasks, whose visibility needs more than
`read`; never on a regrant). The client marks the row and offers to refresh the list.

`presence` lists everyone currently subscribed to the room, **one entry per user**
(several tabs count once), ordered by arrival (`since`, Unix seconds). It includes the
recipient: clients hide their own user id.

- `active`: the user is active on at least one tab — visible, focused (focus inside an
  iframe such as the rich-text editor counts) and used within the last 5 minutes.
  Clients send `activity` only when their state changes (after 200 ms of stability) and,
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
| `item.update` (+ `fields`: changed field names), `item.delete`, `item.restore`, `item.purge` | — | `read` |
| `followup.add` / `.update` / `.delete` | `ITILFollowup` | public: `see_public_followup`; private: `see_private_followup`; always the author |
| `task.add` / `.update` / `.delete` | `TicketTask` | public: `see_public_task`; private: `see_private_task`, or `see_private_task_groups` and a member of the technician group; always the author and the technician |
| `solution.add` / `.update` | `ITILSolution` | `read` |
| `validation.add` / `.update` / `.delete` | `TicketValidation` | `read` |
| `document.add` / `.delete` (attached to the ticket itself) | `Document` | `read` |
| `actor.add` / `.update` / `.delete` | — | `read` |

`by.id` is 0 for automatic actions. Rules mirror GLPI's `canViewItem()`; flags come from the
session's grant and groups from the session key, both written by GLPI.

### Regrant

A batch may carry `sessions` (token hashes): the regrant then concerns those sessions
only (their user's profile, groups or rights changed), the other members keep their
grants and keep receiving events.

Removing or changing an actor, or moving the ticket to another entity, may remove
someone's access. The plugin then deletes **every** grant on the item (index
`rt:gi:{room}`) and marks the batch `regrant`. Each member receives `regrant` and from then
on no event for that room. The client calls `ajax/grant.php` (GLPI rewrites the grant, or
deletes it if `READ` is now refused) and sends `sub` again: `subscribed`, or `forbidden`
and the connection leaves the room. Without a new `sub` within
`events.regrant_timeout_secs` (30 s), the server sends `unsubscribed{reason: forbidden}`.

## Single editor

One person at a time edits an item's **fields**: the fields panel (`form#itil-form`:
status, urgency, category, actors…), its Save button, and the title/description of the
main item. The timeline (followups, tasks, solutions) is not locked.

- The client sends `lock` on the first edit (focus, typing, opening a dropdown), then every
  `lock_ttl / 3` seconds while editing; `unlock` after a minute without input when nothing
  is unsaved. Saving reloads the page: the connection closes and the server releases the
  lock. A lock that is not renewed expires after `locks.ttl_secs` (30 s).
- **Answers that change the status hold the fields too.** Writing a solution, or a
  followup/task with *Put on hold* checked, takes the fields lock with
  `reason: "solution"` / `"pending"` (needs `solve` / `add_followup` or `add_task` instead
  of `update`). Others see the fields locked and why (no take over); and while someone
  else edits the fields, the Solution button is disabled and *Put on hold* is unchecked.
- Taking the lock needs the grant flag `update`, and no pending `regrant`
  (`forbidden` otherwise). `force: true` takes it from a holder whose tab is inactive
  (presence) or who left the item; otherwise the reply names the current holder.
- Stored in `rt:l:{room}` (JSON holder, TTL), taken and released atomically (Lua) so that
  a connection only renews or releases its own. Changes are announced on `rt:lc`.
- Others see the fields disabled and who edits ("Take over" when the holder is inactive).
  After an `event` changing the fields (`ticket.*`, `actor.*`) by anyone else, the page
  stays read-only until refreshed, so nobody saves values older than GLPI's; the holder
  gets a warning instead.
- The lock is **advisory**: GLPI still accepts any update its rights allow (API, mail
  collector, a browser without the client). GLPI's own item lock (*Lock items*), when
  enabled, removes the Save button: the client then does nothing.

## Live timeline

- **Who is writing.** Opening one of GLPI's answer forms (`#new-{Class}-block`) sends
  `compose{kind}`; closing or submitting it sends `compose{null}`. The kind travels in the
  presence entry of the connection (same TTL, same cleanup), and other members show a
  placeholder ("Alice is writing a followup…") where new items appear, in their own
  timeline order.
- **New items.** On `followup.*`, `task.*`, `solution.*`, `validation.*`, `document.*`
  events, the client fetches the ticket tab again (`data-glpi-ajax-content`, rendered by
  GLPI for this user, rights included) and merges its timeline: new entries inserted next
  to their neighbours, edited ones replaced, deleted ones removed. Entries being edited and
  the answer forms are never touched. Nothing of the content travels on the WebSocket.
- **One solution at a time.** Opening the solution form takes the `solution` lock (grant
  flag `solve`), renewed like the fields lock. Meanwhile, and once a solution was proposed
  by someone else, the Solution button is disabled for the others. GLPI enforces it: the
  plugin's `pre_item_add` on ITILSolution refuses a solution when the item already has one
  that is not refused, under a MariaDB `GET_LOCK` so that two simultaneous saves cannot
  both pass.

## Shared drafts

One shared draft per item and kind (`followup`, `task`, `solution`), written in GLPI's own
editor (TinyMCE). The writer's client sends `draft` as they type (pasted images removed);
the first one makes it the writer, others get `locked` and keep a personal draft.

- Members allowed to follow it get `draft_info` (who writes, no content): the grant flag
  `add_followup`, `add_task` or `solve`, plus `see_private_followup` / `see_private_task`
  when the draft is private. "Join" sends `draft_watch`; followers receive `draft` on each
  change and show it read-only in a sandboxed frame (no script, no remote load).
- `draft_take` makes the caller the writer when the writer's tab is inactive or gone
  (`away: true` in `draft_info`); the reply carries the text, which opens in the caller's
  own answer form. The former writer is told someone took it over.
- Submitting or closing the form sends `draft_end`. A draft whose writer closed the tab is
  kept `drafts.ttl_secs` (15 min) in `rt:d:{room}:{kind}`, written atomically (Lua).
- The content is never logged. Rights are those of the grant GLPI wrote for each session.

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
| `mentioned` (`detail.in`: `description`, `followup`, `task`, `solution`, `validation`) | users newly mentioned ("@name", GLPI's rich text mentions), whatever their role; the user's *When I am mentioned* preference |
| `ttr_soon` / `ttr_late` (`detail.ttr`: Unix seconds) | tickets, not solved or closed: assigned users and members of assigned groups, within their *Time to resolve* preference before it (30 min, 1 h by default, 4 h, or never) / once passed (up to a day late); once per time to resolve; checked every 5 minutes by the `slaalert` task; published with author 0 (GLPI's own alert, never withheld) |

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
| `revoked` | 4001 | The GLPI session ended or changed, or Valkey lost it: ask GLPI (`ajax/session.php`, at most every 30 s); if it issued a new token, reconnect, else stay disconnected until the next GLPI page. Two handshakes refused in a row (401) are handled the same way. A room refused after a reconnection is granted again by GLPI (`ajax/grant.php`) once before being reported lost. |
| `shutdown` | 1012 | Reconnect with backoff (server restart). |
| `policy` | 1008 | Too many rate-limit violations. Reconnect with backoff. |
| `idle` | 1001 | No traffic (including pongs) for `idle_timeout_secs`. Reconnect. |
| `slow` | 1013 | Client too slow to read (its outgoing queue is full): dropped; the `bye` usually cannot reach it. Reconnect. |
| (none) | 1009 | Message larger than `max_message_bytes`. |

Reconnection delay: exponential from 0.5 s to 30 s with jitter (`client/src/backoff.ts`).

## Binary frames

Not used: rejected with `bad_request`.
