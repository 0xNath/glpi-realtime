import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState, IDLE_MS } from "../src/editor.ts";
import type { Holder } from "../src/protocol.ts";

const me: Holder = { conn: "c-me", id: 2, name: "Me", since: 0 };
const bob: Holder = { conn: "c-bob", id: 7, name: "Bob", since: 0 };

function state(): EditorState {
  const s = new EditorState();
  s.conn = "c-me";
  s.selfId = 2;
  return s;
}

test("free, mine, someone else's", () => {
  const s = state();
  assert.equal(s.mode(), "free");
  assert.ok(s.canEdit());
  s.onLock(me);
  assert.equal(s.mode(), "mine");
  assert.ok(s.canEdit());
  s.onLock(null);
  s.onLock(bob);
  assert.equal(s.mode(), "other");
  assert.ok(!s.canEdit(), "fields read-only while Bob edits");
});

test("a takeover is reported as lost, never silently", () => {
  const s = state();
  s.onLock(me);
  s.onLock(bob);
  assert.equal(s.mode(), "lost");
  assert.ok(!s.canEdit());
  s.onLock(null);
  assert.equal(s.mode(), "lost", "stays lost: our unsaved values are out of date");
});

test("values changed by someone else: refresh before editing", () => {
  const s = state();
  s.onEvent("followup.add", { id: 7, name: "Bob" });
  assert.equal(s.mode(), "free", "the timeline does not touch the fields");
  s.onEvent("ticket.update", { id: 7, name: "Bob" });
  assert.equal(s.mode(), "stale");
  assert.equal(s.staleBy, "Bob");
  assert.ok(!s.canEdit());
});

test("while editing: a warning for others' changes, nothing for our own", () => {
  const s = state();
  s.onLock(me);
  s.onEvent("ticket.update", { id: 2, name: "Me" });
  assert.equal(s.mode(), "mine", "our own save");
  s.onEvent("actor.add", { id: 0, name: "" });
  assert.equal(s.mode(), "mine-stale", "GLPI itself (rules, cron) changed it");
  assert.ok(s.canEdit(), "the editor may still decide to save");
});

test("our other tab saving makes this one stale", () => {
  const s = state();
  s.onEvent("ticket.update", { id: 2, name: "Me" });
  assert.equal(s.mode(), "stale");
});

test("renewed while editing, released when idle and saved", () => {
  const s = state();
  assert.equal(s.tick(0, true), null, "not holding: nothing to do");
  s.onLock(me);
  s.lastInput = 1000;
  assert.equal(s.tick(1000 + IDLE_MS - 1, false), "renew");
  assert.equal(s.tick(1000 + IDLE_MS, false), "release");
  assert.equal(s.tick(1000 + IDLE_MS, true), "renew", "focus in the fields");
  s.dirty = true;
  assert.equal(s.tick(1000 + 10 * IDLE_MS, false), "renew", "unsaved changes keep it");
});

test("without the update right: never holds it, still respects it", () => {
  const s = state();
  s.forbidden = true;
  assert.ok(s.canEdit(), "nobody edits: GLPI's own rights apply");
  s.onLock(bob);
  assert.ok(!s.canEdit());
});
