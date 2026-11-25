import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { LiveTimeline, syncTimeline, type TimelineClient } from "../src/timeline.ts";
import { event, page } from "./dom.ts";

// The live timeline in a DOM without a browser: items merged from GLPI's tab, who is
// writing, the solution's guards. Timers are mocked (the locks' keepalive re-arms forever).

const ROOM = "Ticket:5";
const ME = { conn: "c-me", id: 1, name: "Me" };
const BOB = { conn: "c-bob", id: 2, name: "Bob" };

function item(type: string, id: number, text: string, extra = ""): string {
  return `<div class="timeline-item mb-3${extra}" data-itemtype="${type}" data-items-id="${id}"><div class="timeline-content">${text}</div></div>`;
}

const keys = (root: Element) => Array.from(root.querySelectorAll(":scope > .timeline-item[data-itemtype]")).map((e) => `${e.getAttribute("data-itemtype")}:${e.getAttribute("data-items-id")}`);

test("merge: new items after their predecessor, changed ones replaced, deleted ones removed", () => {
  const { document } = page(`<!doctype html><html><body><div id="local">${item("Ticket", 5, "description", " ITILContent")}${item("ITILFollowup", 1, "one")}${item("ITILFollowup", 2, "two")}</div>
    <div id="remote">${item("Ticket", 5, "description", " ITILContent")}${item("ITILFollowup", 1, "one, edited")}${item("ITILFollowup", 3, "three")}</div></body></html>`);
  const local = document.getElementById("local")!;
  const remote = document.getElementById("remote")!;
  const insert = (html: string, where: { after?: Element; before?: Node | null; parent: Element }) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const el = tpl.content.firstElementChild!;
    if (where.after) where.after.after(el);
    else where.parent.insertBefore(el, where.before ?? where.parent.firstChild);
    return el;
  };
  const res = syncTimeline(local, remote, new Set(["ITILFollowup:1"]), insert);
  assert.deepEqual(keys(local), ["Ticket:5", "ITILFollowup:1", "ITILFollowup:3"]);
  assert.deepEqual([res.added, res.replaced, res.removed], [["ITILFollowup:3"], ["ITILFollowup:1"], ["ITILFollowup:2"]]);
  assert.match(local.textContent ?? "", /one, edited/);
  assert.equal(local.querySelector("[data-items-id='3']")?.classList.contains("glpi-rt-new"), true, "new items are highlighted");
});

/** A ticket page: its timeline in a tab GLPI loads from a URL, the answer blocks, the Solution button. */
function setup(t: TestContext, served: string[] = []) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { document } = page(`<!doctype html><html lang="en"><head></head><body>
    <a data-bs-target="#tab-main" data-glpi-ajax-content="/ajax/timeline.php?id=5">Ticket</a>
    <div class="tab-pane" id="tab-main"><div class="itil-timeline">
      ${item("Ticket", 5, "description", " ITILContent")}${item("ITILFollowup", 1, "one")}
      <div id="new-ITILFollowup-block"><form><textarea name="content"></textarea><input type="checkbox" name="pending"></form></div>
      <div id="new-ITILSolution-block"><div class="card-body"><form><button type="submit">Add</button></form></div></div>
    </div></div>
    <button data-bs-target="#new-ITILSolution-block" id="solution-btn">Solution</button></body></html>`);
  const sent: string[] = [];
  const handlers = new Map<string, ((m: any) => void)[]>();
  // The shared drafts the timeline creates also send through it.
  const client: TimelineClient & { send: (m: unknown) => number } = {
    send: () => 0,
    conn: ME.conn,
    user: { id: ME.id, name: ME.name },
    lockTtl: 30,
    lock: (_room, force, scope, reason) => void sent.push(`lock ${scope ?? "fields"}${reason ? ` ${reason}` : ""}${force ? " force" : ""}`),
    unlock: (_room, scope) => void sent.push(`unlock ${scope ?? "fields"}`),
    compose: (_room, kind) => void sent.push(`compose ${kind}`),
    on: (type, h) => (handlers.set(type, [...(handlers.get(type) ?? []), h]), () => {}),
  };
  const emit = (type: string, m: any) => (handlers.get(type) ?? []).forEach((h) => h(m));
  const fetched: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    fetched.push(url);
    const body = served.shift() ?? "";
    return { ok: true, text: async () => body };
  };
  const tl = new LiveTimeline(document, client, ROOM, "en");
  const timeline = () => document.querySelector(".itil-timeline")!;
  return { document, tl, sent, emit, fetched, timeline };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("an event: the tab is fetched once after the burst, the new followup appears", async (t) => {
  const served = `<div class="itil-timeline">${item("Ticket", 5, "description", " ITILContent")}${item("ITILFollowup", 1, "one")}${item("ITILFollowup", 2, "Bob's answer")}</div>`;
  const { emit, fetched, timeline } = setup(t, [served]);
  for (let i = 0; i < 3; i++) emit("event", { room: ROOM, kind: "followup.add", by: { id: BOB.id, name: BOB.name }, item: { type: "ITILFollowup", id: 2 } });
  emit("event", { room: ROOM, kind: "item.update", by: { id: BOB.id, name: BOB.name } }); // not the timeline's
  t.mock.timers.tick(1_600);
  await settle();
  assert.deepEqual(fetched, ["/ajax/timeline.php?id=5"], "one request for the burst");
  assert.deepEqual(keys(timeline()), ["Ticket:5", "ITILFollowup:1", "ITILFollowup:2"]);
  assert.match(timeline().textContent ?? "", /Bob's answer/);
});

test("a tab in the background waits until it is shown", async (t) => {
  const { document, emit, fetched } = setup(t, [`<div class="itil-timeline"></div>`]);
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  emit("event", { room: ROOM, kind: "task.add", by: { id: BOB.id, name: BOB.name } });
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual(fetched, [], "nothing while hidden");
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(event("visibilitychange"));
  t.mock.timers.tick(1_600);
  await settle();
  assert.equal(fetched.length, 1, "once shown");
});

test("who is writing: a placeholder per other user, gone when they stop", (t) => {
  const { emit, timeline } = setup(t);
  emit("presence", { room: ROOM, users: [{ id: BOB.id, name: BOB.name, active: true, composing: "followup" }, { id: ME.id, name: ME.name, active: true, composing: "task" }] });
  const holders = () => Array.from(timeline().querySelectorAll(".glpi-rt-composing")).map((e) => e.textContent ?? "");
  assert.equal(holders().length, 1, "not for ourselves");
  assert.match(holders()[0], /Bob is writing a followup/);
  emit("presence", { room: ROOM, users: [{ id: BOB.id, name: BOB.name, active: true }] });
  assert.equal(holders().length, 0);
});

test("opening an answer says what we write; a solution also takes its locks; closing ends it", (t) => {
  const { document, sent } = setup(t);
  const block = document.getElementById("new-ITILFollowup-block")!;
  block.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  block.dispatchEvent(event("hidden.bs.collapse", {}, { bubbles: true }));
  const sol = document.getElementById("new-ITILSolution-block")!;
  sol.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  assert.deepEqual(sent, ["compose followup", "compose null", "compose solution", "lock solution", "lock fields solution"]);
  sent.length = 0;
  t.mock.timers.tick(10_000);
  assert.deepEqual(sent, ["lock solution", "lock fields solution"], "renewed while writing it");
  sent.length = 0;
  sol.dispatchEvent(event("hidden.bs.collapse", {}, { bubbles: true }));
  assert.deepEqual(sent, ["unlock solution", "unlock fields", "compose null"]);
});

test("someone else writes a solution: ours cannot be opened nor sent", (t) => {
  const { document, emit } = setup(t);
  emit("lock", { room: ROOM, scope: "solution", holder: { ...BOB, since: 0 } });
  const btn = document.getElementById("solution-btn")!;
  assert.equal(btn.classList.contains("disabled"), true);
  assert.equal(btn.getAttribute("title"), "Bob is already writing a solution.");
  assert.equal(btn.dispatchEvent(event("click", {}, { bubbles: true, cancelable: true })), false, "the click is refused");
  const submit = document.querySelector<HTMLButtonElement>("#new-ITILSolution-block button[type=submit]")!;
  assert.equal(submit.disabled, true);
  const form = document.querySelector("#new-ITILSolution-block form")!;
  assert.equal(form.dispatchEvent(event("submit", {}, { bubbles: true, cancelable: true })), false, "nor sent");
  emit("lock", { room: ROOM, scope: "solution", holder: null });
  assert.equal(btn.classList.contains("disabled"), false, "free again");
});

test("a solution proposed by someone else: no second one", (t) => {
  const { document, emit } = setup(t);
  emit("event", { room: ROOM, kind: "solution.add", by: { id: BOB.id, name: BOB.name } });
  assert.equal(document.getElementById("solution-btn")!.getAttribute("title"), "Bob already proposed a solution. Refresh the page to see it.");
  assert.match(document.getElementById("glpi-rt-solution-note")?.textContent ?? "", /already proposed/);
});

test("put on hold while someone else edits the fields: refused, said in the answer", (t) => {
  const { document, emit, sent } = setup(t);
  emit("lock", { room: ROOM, scope: "fields", holder: { ...BOB, since: 0 } });
  const box = document.querySelector<HTMLInputElement>("#new-ITILFollowup-block input[name=pending]")!;
  box.checked = true;
  box.dispatchEvent(event("change", {}, { bubbles: true }));
  assert.equal(box.checked, false, "unchecked again");
  assert.match(document.querySelector("#new-ITILFollowup-block .glpi-rt-solution-note")?.textContent ?? "", /Bob is editing the fields of this ticket/);
  assert.equal(sent.some((m) => m.startsWith("lock fields")), false);
});

test("reconnected while writing: says it again and takes the locks back", (t) => {
  const { document, emit, sent } = setup(t);
  document.getElementById("new-ITILSolution-block")!.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  sent.length = 0;
  emit("subscribed", { room: ROOM });
  assert.deepEqual(sent, ["compose solution", "lock solution", "lock fields solution"]);
});
