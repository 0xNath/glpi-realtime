import assert from "node:assert/strict";
import { test } from "node:test";

import { ANSWER_KINDS, langOf, planSync, TIMELINE_EVENTS } from "../src/timeline.ts";

const none = new Set<string>();
const content = new Set(["Ticket:1"]);

test("a new followup goes right after its predecessor", () => {
  const ops = planSync(["Ticket:1", "ITILFollowup:3"], ["Ticket:1", "ITILFollowup:3", "ITILFollowup:4"], none, none, content);
  assert.deepEqual(ops, [{ op: "insert", key: "ITILFollowup:4", after: "ITILFollowup:3" }]);
});

test("newest first: the new item goes before the others", () => {
  const ops = planSync(["ITILFollowup:3", "Ticket:1"], ["ITILSolution:9", "ITILFollowup:3", "Ticket:1"], none, none, content);
  assert.deepEqual(ops, [{ op: "insert", key: "ITILSolution:9", after: null }]);
});

test("edits are replaced, deletions removed, consecutive inserts chained", () => {
  const ops = planSync(
    ["Ticket:1", "ITILFollowup:3", "TicketTask:5"],
    ["Ticket:1", "ITILFollowup:3", "ITILFollowup:6", "Document_Item:7"],
    new Set(["ITILFollowup:3"]),
    none,
    content,
  );
  assert.deepEqual(ops, [
    { op: "remove", key: "TicketTask:5" },
    { op: "replace", key: "ITILFollowup:3" },
    { op: "insert", key: "ITILFollowup:6", after: "ITILFollowup:3" },
    { op: "insert", key: "Document_Item:7", after: "ITILFollowup:6" },
  ]);
});

test("what is being edited here, and the description, are left alone", () => {
  const ops = planSync(
    ["Ticket:1", "ITILFollowup:3", "TicketTask:5"],
    ["ITILFollowup:3"],
    new Set(["ITILFollowup:3", "Ticket:1"]),
    new Set(["ITILFollowup:3", "TicketTask:5"]),
    content,
  );
  assert.deepEqual(ops, [], "the description is never removed, edited items are never touched");
});

test("nothing changed: nothing to do", () => {
  assert.deepEqual(planSync(["Ticket:1", "ITILFollowup:3"], ["Ticket:1", "ITILFollowup:3"], none, none, content), []);
});

test("answer forms and events", () => {
  assert.equal(ANSWER_KINDS.ITILSolution, "solution");
  assert.equal(ANSWER_KINDS.TicketTask, "task");
  assert.ok(TIMELINE_EVENTS.test("followup.add") && TIMELINE_EVENTS.test("solution.update") && TIMELINE_EVENTS.test("document.delete"));
  assert.ok(!TIMELINE_EVENTS.test("item.update") && !TIMELINE_EVENTS.test("actor.add"));
  assert.equal(langOf("fr_FR"), "fr");
  assert.equal(langOf("de"), "en");
});
