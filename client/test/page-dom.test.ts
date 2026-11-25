import assert from "node:assert/strict";
import { test } from "node:test";

import { InboxController } from "../src/bell.ts";
import { type InboxApi, type InboxItem, type InboxList, LABELS, type Preferences } from "../src/inbox.ts";
import { InboxPage } from "../src/page.ts";
import { event, page, tick } from "./dom.ts";

// The full notifications page (front/notifications.php) in a DOM without a browser.

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
const now = Date.now() / 1000;

function item(p: Partial<InboxItem>): InboxItem {
  return { id: 1, key: "Ticket:1", event: "commented", channel: "direct", detail: null, is_read: false, actor: 7, date: "2026-11-24 10:00:00", ts: now - 60, queue: "mine", ...p };
}

function list(items: InboxItem[], statuses: Record<string, [number, string]> = {}): InboxList {
  const objects: InboxList["objects"] = {};
  for (const i of items) {
    const id = Number(i.key.split(":")[1]);
    const [status, label] = statuses[i.key] ?? [2, "Processing"];
    objects[i.key] = { type: "Ticket", id, title: `Ticket ${id}`, url: `/front/ticket.form.php?id=${id}`, status, status_label: label, can_assign: true } as InboxList["objects"][string];
  }
  const unread = new Set(items.filter((i) => !i.is_read).map((i) => i.key)).size;
  return { enabled: true, items, objects, users: { "7": "Alice" }, counts: { all: unread } as InboxList["counts"], preferences: { ...prefs }, can_see_others: false };
}

function setup(l: InboxList) {
  const { document } = page(`<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>`);
  const calls: { method: string; body?: unknown }[] = [];
  let current = l;
  const api = {
    list: async () => (calls.push({ method: "list" }), current),
    act: async (body: Record<string, unknown>) => (calls.push({ method: "act", body }), current),
    savePreferences: async () => ({ preferences: prefs }),
    assign: async (key: string) => (calls.push({ method: "assign", body: key }), { ok: true }),
  } as unknown as InboxApi;
  const ctl = new InboxController(api, true);
  new InboxPage(document.getElementById("root")!, ctl, api, en);
  const rows = () => Array.from(document.querySelectorAll("tbody tr")).map((r) => r.getAttribute("data-key"));
  const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
  return { document, ctl, calls, rows, $, set: (n: InboxList) => (current = n) };
}

test("one row per item, newest first, unread marked; the read ones on demand", async () => {
  const { ctl, rows, $ } = setup(list([
    item({ id: 1, key: "Ticket:1", ts: now - 300 }),
    item({ id: 2, key: "Ticket:2", ts: now - 60 }),
    item({ id: 3, key: "Ticket:1", event: "assigned", ts: now - 600 }),
    item({ id: 4, key: "Ticket:3", is_read: true, ts: now - 30 }),
  ]));
  await ctl.load();
  assert.deepEqual(rows(), ["Ticket:2", "Ticket:1"], "per item, newest first, read hidden");
  assert.equal($("tr[data-key='Ticket:1']")?.classList.contains("is-unread"), true);
  assert.match($("tr[data-key='Ticket:1']")?.textContent ?? "", /Ticket 1.*Processing.*Alice/);
  assert.equal($(".badge.bg-danger")?.textContent, "2", "the unread count");

  const show = $<HTMLInputElement>("input[type=checkbox]")!;
  show.checked = true;
  show.dispatchEvent(event("change", {}, { bubbles: true }));
  await tick();
  await tick();
  assert.deepEqual(rows(), ["Ticket:3", "Ticket:2", "Ticket:1"], "with the read ones");
  assert.equal($("tr[data-key='Ticket:3']")?.classList.contains("is-unread"), false);
});

/** Chooses an option as a user would (linkedom has no select.value setter), then "change". */
function choose(select: HTMLSelectElement, value: string) {
  for (const o of Array.from(select.querySelectorAll("option"))) o.toggleAttribute("selected", o.getAttribute("value") === value);
  select.dispatchEvent(event("change", {}, { bubbles: true }));
}

test("tabs, status and period narrow the table; an empty view says so", async () => {
  const { ctl, rows, $, document } = setup(list(
    [item({ id: 1, key: "Ticket:1", queue: "mine" }), item({ id: 2, key: "Ticket:2", queue: "team", ts: now - 40 * 86400 })],
    { "Ticket:2": [4, "Pending"] },
  ));
  await ctl.load();
  [...document.querySelectorAll<HTMLElement>(".glpi-rt-tab")].find((b) => b.textContent?.startsWith(en.tabs.team))!.click();
  assert.deepEqual(rows(), ["Ticket:2"], "team tab");
  [...document.querySelectorAll<HTMLElement>(".glpi-rt-tab")].find((b) => b.textContent?.startsWith(en.tabs.all))!.click();

  const status = document.querySelectorAll<HTMLSelectElement>("select")[0];
  // Named for screen readers (no visible label): axe's select-name.
  assert.deepEqual(Array.from(document.querySelectorAll("select")).map((e) => e.getAttribute("aria-label")), [en.statusFilter, en.periodFilter]);
  assert.deepEqual(Array.from(status.querySelectorAll("option")).map((o) => o.textContent), [en.allStatuses, "Processing", "Pending"]);
  choose(status, "4");
  assert.deepEqual(rows(), ["Ticket:2"], "status: pending");
  choose(document.querySelectorAll<HTMLSelectElement>("select")[1], "week"); // drawn again

  assert.deepEqual(rows(), [], "pending and within the week: none");
  assert.equal($(".glpi-rt-empty")?.textContent, en.empty);
});

test("actions: read, unread, mark the tab read, assume, open (read then go)", async () => {
  const l = list([item({ id: 5, key: "Ticket:1", queue: "new" }), item({ id: 6, key: "Ticket:2", is_read: true })]);
  const { ctl, calls, $ } = setup(l);
  ctl.withRead = true;
  await ctl.load();
  $<HTMLElement>(`tr[data-key='Ticket:1'] button[aria-label='${en.read}']`)!.click();
  await tick();
  assert.deepEqual(calls.at(-1), { method: "act", body: { action: "read_item", item: "Ticket:1" } });
  $<HTMLElement>(`tr[data-key='Ticket:2'] button[aria-label='${en.unread}']`)!.click();
  await tick();
  assert.deepEqual(calls.at(-1), { method: "act", body: { action: "unread", id: 6 } });
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.includes(en.markAll))!.click();
  await tick();
  assert.deepEqual(calls.at(-1), { method: "act", body: { action: "read_tab", tab: "all" } });
  assert.equal($(`tr[data-key='Ticket:2'] button[aria-label='${en.assume}']`) === null, true, "assume only on new items");
  $<HTMLElement>(`tr[data-key='Ticket:1'] button[aria-label='${en.assume}']`)!.click();
  await tick();
  await tick();
  assert.deepEqual(calls.slice(-2).map((c) => c.method), ["assign", "list"]);

  const went: string[] = [];
  (globalThis as any).location = { set href(v: string) { went.push(v); } };
  $<HTMLElement>(`tr[data-key='Ticket:1'] a[aria-label='${en.open}']`)!.click();
  await tick();
  await tick();
  assert.deepEqual(calls.at(-1), { method: "act", body: { action: "read_item", item: "Ticket:1" } });
  assert.deepEqual(went, ["/front/ticket.form.php?id=1"]);
});

test("a link that is not GLPI's own is not made a link", async () => {
  const l = list([item({ key: "Ticket:1" })]);
  l.objects["Ticket:1"].url = "https://evil.example/x";
  const { ctl, $ } = setup(l);
  await ctl.load();
  assert.equal($("tr[data-key='Ticket:1'] a") === null, true);
  assert.match($("tr[data-key='Ticket:1']")?.textContent ?? "", /Ticket 1/);
});
