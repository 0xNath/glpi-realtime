import assert from "node:assert/strict";
import { test } from "node:test";

import { InboxController } from "../src/bell.ts";
import {
  arrivals,
  eventText,
  groups,
  groupText,
  type InboxApi,
  type InboxItem,
  type InboxList,
  LABELS,
  type Preferences,
  shouldRing,
  tabs,
  timeAgo,
} from "../src/inbox.ts";
import { inPeriod } from "../src/page.ts";

const en = LABELS.en;
const prefs: Preferences = {
  update_message_style: "priority",
  resolved_closed_style: "separate",
  show_resolved: true,
  show_closed: true,
  sound_enabled: true,
  sound_new: true,
  sound_mine: true,
  sound_team: true,
  sound_other: true,
  sound_ended: false,
};

function item(p: Partial<InboxItem>): InboxItem {
  return { id: 1, key: "Ticket:1", event: "commented", channel: "direct", detail: null, is_read: false, actor: 7, date: "2026-11-24 10:00:00", queue: "mine", ...p };
}

function list(items: InboxItem[], p: Partial<Preferences> = {}): InboxList {
  const objects: InboxList["objects"] = {};
  for (const i of items) objects[i.key] = { type: "Ticket", id: Number(i.key.split(":")[1]), title: `T${i.key}`, url: "/front/ticket.form.php?id=1", status: 2 };
  return { enabled: true, items, objects, users: { "7": "Alice" }, counts: { all: 0 } as InboxList["counts"], preferences: { ...prefs, ...p } as Preferences, can_see_others: false };
}

test("tabs follow rights and preferences", () => {
  assert.deepEqual(tabs(prefs, false), ["all", "new", "mine", "team", "resolved", "closed"]);
  assert.deepEqual(tabs(prefs, true), ["all", "new", "mine", "team", "other", "resolved", "closed"]);
  assert.deepEqual(tabs({ ...prefs, resolved_closed_style: "ended" }, false).slice(-1), ["ended"]);
  assert.deepEqual(tabs({ ...prefs, show_resolved: false, show_closed: false }, false), ["all", "new", "mine", "team"]);
});

test("update messages: priority, combined, multiple", () => {
  const up = item({ event: "updated", detail: { fields: ["content", "priority", "urgency"] } });
  assert.equal(eventText(up, "priority", en), "Priority changed");
  assert.equal(eventText(up, "combined", en), "Priority changed + Description updated");
  assert.equal(eventText(up, "multiple", en), "Multiple changes");
  assert.equal(eventText(item({ event: "updated", detail: { fields: ["name"] } }), "multiple", en), "Title changed");
});

test("event texts depend on channel and status", () => {
  assert.equal(eventText(item({ event: "assigned", channel: "group" }), "priority", en), "Your group has been assigned");
  assert.equal(eventText(item({ event: "created", channel: "broadcast" }), "priority", en), "New unassigned ticket");
  assert.equal(eventText(item({ event: "validation_done", detail: { status: 4 } }), "priority", en), "Approval refused");
  assert.equal(eventText(item({ event: "validation_done", detail: { status: 3 } }), "priority", LABELS.fr), "Validation acceptée");
});

test("grouped per item, most important event first", () => {
  const l = list([
    item({ id: 1, event: "commented", date: "2026-11-24 10:00:00" }),
    item({ id: 2, event: "solution_refused", date: "2026-11-24 09:00:00" }),
    item({ id: 3, key: "Ticket:2", event: "task_added", date: "2026-11-24 11:00:00", queue: "team" }),
    item({ id: 4, key: "Ticket:3", event: "assigned", is_read: true }),
  ]);
  const gs = groups(l, "all");
  assert.deepEqual(gs.map((g) => g.key), ["Ticket:2", "Ticket:1"], "newest first, read hidden");
  assert.equal(groupText(gs[1], "priority", en), "Solution refused");
  assert.equal(groupText(gs[1], "combined", en), "Solution refused + New followup");
  assert.equal(groupText(gs[1], "multiple", en), "2 updates");
  assert.deepEqual(groups(l, "team").map((g) => g.key), ["Ticket:2"]);
  assert.equal(groups(l, "all", true).length, 3, "with read ones");
});

test("only new unread arrivals ring, per queue sound preference", () => {
  const before = list([item({ id: 1 })]);
  const after = list([item({ id: 1 }), item({ id: 2, key: "Ticket:2", queue: "closed" })]);
  const fresh = arrivals(before, after);
  assert.deepEqual(fresh.map((i) => i.id), [2]);
  assert.equal(shouldRing(fresh, prefs), false, "closed: sound_ended is off by default");
  assert.equal(shouldRing(fresh, { ...prefs, sound_ended: true }), true);
  assert.equal(shouldRing([item({ queue: "mine" })], { ...prefs, sound_enabled: false }), false);
  assert.deepEqual(arrivals(null, after), [], "first load never rings");
});

test("time ago and periods", () => {
  const now = new Date("2026-11-24T12:00:00");
  assert.equal(timeAgo("2026-11-24 11:59:30", now, en), "just now");
  assert.equal(timeAgo("2026-11-24 11:15:00", now, en), "45 min ago");
  assert.equal(timeAgo("2026-11-22 12:00:00", now, LABELS.fr), "il y a 2 j");
  assert.ok(inPeriod("2026-11-24 01:00:00", "today", now));
  assert.ok(!inPeriod("2026-11-10 01:00:00", "week", now));
  assert.ok(inPeriod("2026-11-10 01:00:00", "month", now));
  assert.ok(inPeriod("2020-01-01 00:00:00", "", now));
});

test("controller: one request per burst, rings only on alert with arrivals", async () => {
  let calls = 0;
  let items = [item({ id: 1 })];
  const api = { list: async () => (calls++, list(items)), act: async () => list(items) } as unknown as InboxApi;
  const ctl = new InboxController(api);
  const rings: boolean[] = [];
  ctl.onChange((_l, ring) => rings.push(ring));
  await ctl.load();
  items = [item({ id: 1 }), item({ id: 2, key: "Ticket:2" })];
  ctl.refresh(true);
  ctl.refresh(false);
  ctl.refresh(true);
  await new Promise((r) => setTimeout(r, 300));
  await ctl.load(); // waits for the debounced one
  assert.equal(calls, 3, "initial + one debounced + explicit");
  assert.deepEqual(rings, [false, true, false]);
});

test("mentions say where, and come before most other events", () => {
  assert.equal(eventText(item({ event: "mentioned", detail: { in: "followup" } }), "priority", en), "You were mentioned in a followup");
  assert.equal(eventText(item({ event: "mentioned", detail: { in: "solution" } }), "priority", LABELS.fr), "Vous avez été mentionné dans une solution");
  assert.equal(eventText(item({ event: "mentioned", detail: null }), "priority", en), "You were mentioned");
});
