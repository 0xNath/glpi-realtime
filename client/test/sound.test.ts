import assert from "node:assert/strict";
import { test } from "node:test";

import { Chime } from "../src/sound.ts";

// The bell's chime: no sound before a user gesture (browsers forbid it), then two tones,
// at most every 2 s.

function fakeWindow(withAudio = true) {
  const listeners = new Map<string, () => void>();
  const tones: number[] = [];
  class AC {
    state = "running";
    currentTime = 0;
    destination = {};
    resume() {}
    createOscillator() {
      return { type: "", frequency: { value: 0 }, connect: (g: any) => g, start() {}, stop() {}, set freq(v: number) {} } as any;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}) } as any;
    }
  }
  const osc = AC.prototype.createOscillator;
  AC.prototype.createOscillator = function () {
    const o = osc.call(this);
    const start = o.start;
    o.start = () => (tones.push(o.frequency.value), start());
    return o;
  };
  const win = {
    ...(withAudio ? { AudioContext: AC } : {}),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
  } as unknown as Window;
  return { win, gesture: (type = "click") => listeners.get(type)?.(), tones };
}

test("silent before a gesture, two tones after, at most every 2 s", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const { win, gesture, tones } = fakeWindow();
  const chime = new Chime(win);
  chime.play();
  assert.deepEqual(tones, [], "no gesture yet: no sound");
  gesture("keydown");
  chime.play();
  assert.deepEqual(tones, [880, 1320]);
  chime.play();
  assert.equal(tones.length, 2, "not twice within 2 s");
  t.mock.timers.tick(2_000);
  chime.play();
  assert.equal(tones.length, 4);
});

test("no Web Audio: silent, nothing thrown", () => {
  const { win, gesture } = fakeWindow(false);
  const chime = new Chime(win);
  gesture();
  chime.play();
  const broken = { AudioContext: function () { throw new Error("blocked"); }, addEventListener: (_: string, fn: () => void) => fn() } as unknown as Window;
  new Chime(broken).play();
});
