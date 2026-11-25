import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { type EditorClient, FieldsEditor, IDLE_MS } from "../src/editor.ts";
import type { Holder } from "../src/protocol.ts";
import { event, page } from "./dom.ts";

// The single editor of an item's fields, in a DOM without a browser: what is intercepted,
// disabled, shown, and asked of the server. The lock's keepalive runs on mocked timers.

const ROOM = "Ticket:5";
const ME = { conn: "c-me", id: 1, name: "Me" };
const BOB = { conn: "c-bob", id: 2, name: "Bob" };

function holder(who: typeof ME, extra: Partial<Holder> = {}): Holder {
  return { conn: who.conn, id: who.id, name: who.name, since: Math.floor(Date.now() / 1000), ...extra } as Holder;
}

/** A ticket page: GLPI's fields form and a Save button outside it. */
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { document } = page(`<!doctype html><html lang="en"><head></head><body><div id="tab">
    <form id="itil-form">
      <input name="name" value="Printer"><select name="urgency"><option>3</option></select>
      <input name="itilcategories_id" disabled><input type="hidden" name="id" value="5">
    </form>
    <button form="itil-form" name="update" type="submit">Save</button></div></body></html>`);
  const sent: { t: string; force?: boolean }[] = [];
  const handlers = new Map<string, ((m: any) => void)[]>();
  const client: EditorClient = {
    conn: ME.conn,
    user: { id: ME.id },
    lockTtl: 30,
    lock: (room, force) => void (room === ROOM && sent.push(force ? { t: "lock", force } : { t: "lock" })),
    unlock: (room) => void (room === ROOM && sent.push({ t: "unlock" })),
    lockOf: () => null,
    on: (type, h) => (handlers.set(type, [...(handlers.get(type) ?? []), h]), () => {}),
  };
  const emit = (type: string, m: any) => (handlers.get(type) ?? []).forEach((h) => h(m));
  const editor = new FieldsEditor(document, client, ROOM, "en");
  const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector(sel) as T;
  const bar = () => document.querySelector<HTMLElement>(".glpi-rt-editor")!;
  const fire = (sel: string, type: string) => {
    const e = event(type, {}, { bubbles: true, cancelable: true });
    $(sel).dispatchEvent(e);
    return e;
  };
  return { document, editor, sent, emit, $, bar, fire };
}

test("an edit asks for the lock; nothing is blocked while the fields are free", (t) => {
  const { sent, fire, bar, editor } = setup(t);
  assert.equal(fire("input[name=name]", "focusin").defaultPrevented, false);
  assert.deepEqual(sent, [{ t: "lock" }], "asked on the first intent");
  fire("input[name=name]", "input");
  assert.equal(editor.state.dirty, true, "typing makes the form dirty");
  assert.equal(bar().hidden, true, "no bar while free");
});

test("someone else edits: fields and Save disabled, the bar names them; an edit is refused", (t) => {
  const { document, sent, emit, $, bar, fire } = setup(t);
  emit("lock", { room: ROOM, holder: holder(BOB) });
  assert.equal($("input[name=name]").disabled, true);
  assert.equal($<HTMLSelectElement>("select[name=urgency]").disabled, true);
  assert.equal($<HTMLButtonElement>("button[form=itil-form]").disabled, true, "Save outside the form too");
  assert.equal($("input[name=id]").disabled, false, "hidden fields untouched (they are sent)");
  assert.equal(document.body.classList.contains("glpi-rt-fields-locked"), true);
  assert.equal(bar().hidden, false);
  assert.match(bar().textContent ?? "", /^Bob has been editing the fields of this ticket for a moment\.$/);
  const e = fire("input[name=name]", "keydown");
  assert.equal(e.defaultPrevented, true, "the keystroke is refused");
  assert.equal(sent.length, 0, "and no lock asked");
});

test("released: exactly what was disabled is enabled again", (t) => {
  const { emit, $, bar, document } = setup(t);
  emit("lock", { room: ROOM, holder: holder(BOB) });
  emit("lock", { room: ROOM, holder: null });
  assert.equal($("input[name=name]").disabled, false);
  assert.equal($<HTMLButtonElement>("button[form=itil-form]").disabled, false);
  assert.equal($("input[name=itilcategories_id]").disabled, true, "GLPI's own disabled field stays so");
  assert.equal(bar().hidden, true);
  assert.equal(document.body.classList.contains("glpi-rt-fields-locked"), false);
});

test("an inactive holder can be taken over; one writing an answer cannot", (t) => {
  const { sent, emit, bar } = setup(t);
  emit("lock", { room: ROOM, holder: holder(BOB) });
  assert.equal([...bar().querySelectorAll("button")].some((b) => b.textContent === "Take over"), false, "not while Bob is active");
  emit("presence", { room: ROOM, users: [{ id: BOB.id, name: BOB.name, active: false }] });
  const take = [...bar().querySelectorAll("button")].find((b) => b.textContent === "Take over");
  assert.ok(take !== undefined, "offered once Bob is inactive");
  take!.click();
  assert.deepEqual(sent.at(-1), { t: "lock", force: true });

  emit("lock", { room: ROOM, holder: holder(BOB, { reason: "solution" }) });
  assert.match(bar().textContent ?? "", /is adding a solution/);
  assert.equal([...bar().querySelectorAll("button")].some((b) => b.textContent === "Take over"), false, "never under a solution being written");
});

test("someone else changed the item: refresh before editing", (t) => {
  const { emit, bar, $ } = setup(t);
  emit("event", { room: ROOM, kind: "item.update", by: { id: BOB.id, name: BOB.name } });
  assert.match(bar().textContent ?? "", /^Bob changed this ticket\. Refresh before editing its fields\.Refresh$/);
  assert.equal($("input[name=name]").disabled, true, "stale values cannot be edited");
});

test("changed by someone else while we edit: a warning, our edit goes on", (t) => {
  const other = setup(t);
  other.emit("lock", { room: ROOM, holder: holder(ME) });
  other.emit("event", { room: ROOM, kind: "item.update", by: { id: BOB.id, name: BOB.name } });
  assert.match(other.bar().textContent ?? "", /changed this ticket while you were editing: check before saving/);
  assert.equal(other.$("input[name=name]").disabled, false, "our edit goes on");
});

test("our lock taken over: lost, said so", (t) => {
  const { emit, bar } = setup(t);
  emit("lock", { room: ROOM, holder: holder(ME) });
  emit("lock", { room: ROOM, holder: holder(BOB) });
  assert.match(bar().textContent ?? "", /^Bob took over the fields\. Your unsaved changes can no longer be saved\./);
});

test("kept alive while editing, released when idle", (t) => {
  const { sent, emit, fire } = setup(t);
  fire("input[name=name]", "focusin");
  emit("lock", { room: ROOM, holder: holder(ME) });
  sent.length = 0;
  t.mock.timers.tick(10_000); // lockTtl / 3
  assert.deepEqual(sent, [{ t: "lock" }], "renewed while recently used");
  sent.length = 0;
  t.mock.timers.tick(IDLE_MS + 10_000);
  assert.ok(sent.some((m) => m.t === "unlock"), "released after a minute without input, not dirty, not focused there");
});

test("reconnected while editing: asks for the lock again", (t) => {
  const { sent, emit, fire } = setup(t);
  fire("input[name=name]", "input");
  sent.length = 0;
  emit("subscribed", { room: ROOM });
  assert.deepEqual(sent, [{ t: "lock" }]);
});

test("without the right to edit: never asks for the lock", (t) => {
  const { sent, emit, fire } = setup(t);
  emit("error", { code: "forbidden", message: "cannot edit this item" });
  fire("input[name=name]", "input");
  assert.deepEqual(sent, []);
});
