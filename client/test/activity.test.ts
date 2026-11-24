import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivityTracker } from "../src/activity.ts";

function setup(start: { visible?: boolean; focus?: boolean } = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const doc = Object.assign(new EventTarget(), {
    visibilityState: (start.visible ?? true) ? "visible" : "hidden",
    focus: start.focus ?? true,
    hasFocus() {
      return this.focus;
    },
  });
  const win = new EventTarget();
  const changes: boolean[] = [];
  const tracker = new ActivityTracker({
    doc: doc as any,
    win: win as any,
    onChange: (a) => changes.push(a),
    idleMs: 60_000,
    settleMs: 1_000,
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** Advances the clock, running due timers in order. */
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  return { tracker, doc, win, changes, advance };
}

test("hidden tab becomes inactive after the settle delay", () => {
  const { tracker, doc, changes, advance } = setup();
  assert.equal(tracker.reported, true);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  advance(500);
  assert.deepEqual(changes, []);
  advance(600);
  assert.deepEqual(changes, [false]);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  advance(1_100);
  assert.deepEqual(changes, [false, true]);
});

test("a quick Alt+Tab is not reported", () => {
  const { doc, win, changes, advance } = setup();
  doc.focus = false;
  win.dispatchEvent(new Event("blur"));
  advance(300);
  doc.focus = true;
  win.dispatchEvent(new Event("focus"));
  advance(2_000);
  assert.deepEqual(changes, []);
});

test("focus inside an iframe (rich-text editor) keeps the tab active", () => {
  const { doc, win, changes, advance } = setup();
  // window blurs, but document.hasFocus() stays true: focus is in a child iframe
  win.dispatchEvent(new Event("blur"));
  advance(2_000);
  assert.deepEqual(changes, []);
});

test("no input for idleMs makes the tab inactive, input makes it active again", () => {
  const { win, changes, advance } = setup();
  advance(30_000);
  win.dispatchEvent(new Event("keydown"));
  advance(59_000);
  assert.deepEqual(changes, [], "input resets the idle timer");
  advance(2_100);
  assert.deepEqual(changes, [false]);
  win.dispatchEvent(new Event("pointermove"));
  advance(1_100);
  assert.deepEqual(changes, [false, true]);
});

test("starts inactive when opened in the background", () => {
  const { tracker } = setup({ visible: false });
  assert.equal(tracker.reported, false);
});
