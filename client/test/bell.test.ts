import assert from "node:assert/strict";
import { test } from "node:test";

import { Bell, InboxController } from "../src/bell.ts";
import { type InboxApi, type InboxItem, type InboxList, LABELS, type Preferences } from "../src/inbox.ts";
import { event, page, tick } from "./dom.ts";

// The bell's DOM code, in a DOM without a browser (linkedom). End-to-end tests check it in
// GLPI; these check its logic in milliseconds.

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
  return { id: 1, key: "Ticket:1", event: "commented", channel: "direct", detail: null, is_read: false, actor: 7, date: "2026-11-24 10:00:00", ts: Date.now() / 1000 - 30, queue: "mine", ...p };
}

function list(items: InboxItem[], extra: Partial<InboxList> = {}): InboxList {
  const objects: InboxList["objects"] = {};
  for (const i of items) objects[i.key] = { type: "Ticket", id: Number(i.key.split(":")[1]), title: `T${i.key}`, url: `/front/ticket.form.php?id=${i.key.split(":")[1]}`, status: 2 };
  const unread = items.filter((i) => !i.is_read).length;
  return { enabled: true, items, objects, users: { "7": "Alice" }, counts: { all: unread } as InboxList["counts"], preferences: { ...prefs }, can_see_others: false, ...extra };
}

/** A fake API: what the bell asked for, and the list it answers with (optionally late). */
function fakeApi(initial: InboxList) {
  const calls: { method: string; body?: unknown }[] = [];
  let current = initial;
  let gate: Promise<void> | null = null;
  const api = {
    list: async () => {
      calls.push({ method: "list" });
      if (gate) await gate;
      return current;
    },
    act: async (body: Record<string, unknown>) => (calls.push({ method: "act", body }), current),
    savePreferences: async (p: Partial<Preferences>) => (calls.push({ method: "savePreferences", body: p }), { preferences: { ...prefs, ...p } as Preferences }),
    assign: async (key: string) => (calls.push({ method: "assign", body: key }), { ok: true }),
  };
  return {
    api: api as unknown as InboxApi,
    calls,
    set: (l: InboxList) => (current = l),
    /** The next list requests wait until the returned function is called. */
    hold: () => {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      return () => ((gate = null), open());
    },
  };
}

function bell(l: InboxList) {
  const { document } = page();
  const fake = fakeApi(l);
  const ctl = new InboxController(fake.api);
  const gone: string[] = [];
  const b = new Bell({ doc: document, ctl, api: fake.api, t: en, rootDoc: "", ring: () => {}, go: (url) => gone.push(url) });
  const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
  return { b, ctl, fake, document, gone, $ };
}

test("badge: hidden at zero, the count, 99+ beyond; the name says what is shown", async () => {
  const { ctl, $ } = bell(list([]));
  await ctl.load();
  const badge = $(".glpi-rt-bell-badge")!;
  assert.equal(badge.hidden, true);
  assert.equal($(".glpi-rt-bell-button .glpi-rt-sr")!.textContent, "Notifications");

  const items = Array.from({ length: 3 }, (_, i) => item({ id: i + 1, key: `Ticket:${i + 1}` }));
  const c = bell(list(items));
  await c.ctl.load();
  assert.equal(c.$(".glpi-rt-bell-badge")!.hidden, false);
  assert.equal(c.$(".glpi-rt-bell-badge")!.textContent, "3");
  assert.ok(c.$(".glpi-rt-bell-button")!.getAttribute("aria-label") === null, "named by its content, no aria-label");

  const many = bell(list([item({})], { counts: { all: 150 } as InboxList["counts"] }));
  await many.ctl.load();
  assert.equal(many.$(".glpi-rt-bell-badge")!.textContent, "99+");
});

test("open, close, Escape; aria-expanded follows", async () => {
  const { b, ctl, document, $ } = bell(list([item({})]));
  await ctl.load();
  const panel = $(".glpi-rt-bell-panel")!;
  assert.equal(panel.hidden, true);
  ($(".glpi-rt-bell-button") as HTMLElement).click();
  assert.equal(panel.hidden, false);
  assert.equal($(".glpi-rt-bell-button")!.getAttribute("aria-expanded"), "true");
  document.dispatchEvent(event("keydown", { key: "Escape" }));
  assert.equal(panel.hidden, true);
  assert.equal($(".glpi-rt-bell-button")!.getAttribute("aria-expanded"), "false");
  b.toggle(true);
  assert.equal(panel.hidden, false);
});

test("rows: unread groups per item, the empty text otherwise, tabs filter", async () => {
  const { ctl, document, $ } = bell(list([item({ id: 1, key: "Ticket:1", queue: "mine" }), item({ id: 2, key: "Ticket:2", queue: "team" }), item({ id: 3, key: "Ticket:3", is_read: true })]));
  await ctl.load();
  const keys = () => [...document.querySelectorAll(".glpi-rt-n")].map((r) => r.getAttribute("data-key"));
  assert.deepEqual(keys().sort(), ["Ticket:1", "Ticket:2"], "read ones hidden");
  assert.match($(".glpi-rt-n[data-key='Ticket:1'] .glpi-rt-n-title")!.textContent!, /#1 TTicket:1/);
  assert.match($(".glpi-rt-n[data-key='Ticket:1'] .glpi-rt-n-meta")!.textContent!, /Alice.*just now/);

  ($(".glpi-rt-tab[data-tab='team']") as HTMLElement).click();
  assert.deepEqual(keys(), ["Ticket:2"]);
  assert.equal($(".glpi-rt-tab[data-tab='team']")!.getAttribute("aria-selected"), "true");
  ($(".glpi-rt-tab[data-tab='new']") as HTMLElement).click();
  assert.deepEqual(keys(), []);
  assert.equal($(".glpi-rt-empty")!.textContent, en.empty);
});

test("row actions: read, unread, open (read then go), mark the tab read", async () => {
  const { ctl, fake, gone, $ } = bell(list([item({ id: 1, key: "Ticket:1" })]));
  await ctl.load();
  ($(`.glpi-rt-n[data-key='Ticket:1'] button[aria-label='${en.read}']`) as HTMLElement).click();
  await tick();
  assert.deepEqual(fake.calls.at(-1), { method: "act", body: { action: "read_item", item: "Ticket:1" } });

  fake.set(list([item({ id: 5, key: "Ticket:1", is_read: true })]));
  ctl.withRead = true;
  await ctl.load();
  ($(`.glpi-rt-n[data-key='Ticket:1'] button[aria-label='${en.unread}']`) as HTMLElement).click();
  await tick();
  assert.deepEqual(fake.calls.at(-1), { method: "act", body: { action: "unread", id: 5 } });

  ($(".glpi-rt-n[data-key='Ticket:1'] .glpi-rt-n-title") as HTMLElement).click();
  await tick();
  await tick();
  assert.deepEqual(fake.calls.at(-1), { method: "act", body: { action: "read_item", item: "Ticket:1" } });
  assert.deepEqual(gone, ["/front/ticket.form.php?id=1"]);

  ($(".glpi-rt-bell-foot .btn") as HTMLElement).click();
  await tick();
  assert.deepEqual(fake.calls.at(-1), { method: "act", body: { action: "read_tab", tab: "all" } });
});

test("assume: only on new items GLPI lets the user take, then the list is reloaded", async () => {
  const l = list([item({ id: 1, key: "Ticket:1", queue: "new" }), item({ id: 2, key: "Ticket:2", queue: "new" })]);
  l.objects["Ticket:1"].can_assign = true;
  const { ctl, fake, $ } = bell(l);
  await ctl.load();
  assert.ok($(`.glpi-rt-n[data-key='Ticket:2'] button[aria-label='${en.assume}']`) === null);
  ($(`.glpi-rt-n[data-key='Ticket:1'] button[aria-label='${en.assume}']`) as HTMLElement).click();
  await tick();
  await tick();
  assert.deepEqual(fake.calls.slice(-2), [{ method: "assign", body: "Ticket:1" }, { method: "list" }]);
});

test("preferences asked for before the list arrived open once it has (#14)", async () => {
  const { ctl, fake, $ } = bell(list([item({})]));
  const release = fake.hold(); // a slow GLPI: the first list is late
  const first = ctl.load();
  ($(".glpi-rt-bell-head button[aria-label='" + en.prefs + "']") as HTMLElement).click();
  await tick();
  assert.ok($(".glpi-rt-prefs") === null, "not before the list");
  release();
  await first;
  await tick();
  await tick();
  assert.ok($(".glpi-rt-prefs"), "the preferences opened");
});

test("preferences: shown as saved, sent as edited, then the list is reloaded", async () => {
  const { ctl, fake, $ } = bell(list([item({})]));
  await ctl.load();
  ($(".glpi-rt-bell-head button[aria-label='" + en.prefs + "']") as HTMLElement).click();
  await tick();
  const box = $<HTMLInputElement>(".glpi-rt-prefs input[name='sound_ended']")!;
  assert.equal(box.checked, false);
  box.checked = true;
  const form = $<HTMLFormElement>(".glpi-rt-prefs")!;
  form.dispatchEvent(event("submit", {}, { cancelable: true }));
  await tick();
  await tick();
  const saved = fake.calls.find((c) => c.method === "savePreferences")!.body as Record<string, unknown>;
  assert.equal(saved.sound_ended, true);
  assert.equal(saved.sound_enabled, true);
  assert.equal(saved.update_message_style, "priority");
  assert.equal(fake.calls.at(-1)!.method, "list");
  assert.ok($(".glpi-rt-overlay") === null, "closed after saving");
});
