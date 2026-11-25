import assert from "node:assert/strict";
import { test } from "node:test";

import { backoff } from "../src/backoff.ts";
import { RealtimeClient } from "../src/client.ts";

class FakeWs {
  static all: FakeWs[] = [];
  sent: Record<string, unknown>[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
  serverSays(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...m }) });
  }
  serverCloses(code: number) {
    this.onclose?.({ code });
  }
}

function setup() {
  FakeWs.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const c = new RealtimeClient({
    url: "wss://glpi.test/ws",
    WebSocket: FakeWs as unknown as typeof WebSocket,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    random: () => 0.5,
  });
  return { c, timers };
}

const hello = { t: "hello", conn: "x", user: { id: 2, name: "glpi" }, ping_interval: 30 };

test("backoff grows, is capped and jittered", () => {
  assert.equal(backoff(0, () => 0), 250);
  assert.equal(backoff(0, () => 1), 500);
  assert.equal(backoff(3, () => 1), 4000);
  assert.equal(backoff(20, () => 1), 30_000);
  assert.equal(backoff(20, () => 0), 15_000);
});

test("subscribes to known rooms once the server says hello", () => {
  const { c } = setup();
  c.subscribe("Ticket:1");
  c.start();
  const ws = FakeWs.all[0];
  assert.equal(ws.url, "wss://glpi.test/ws");
  assert.equal(ws.sent.length, 0, "nothing sent before hello");
  ws.serverSays(hello);
  assert.equal(c.state, "open");
  assert.deepEqual(c.user, { id: 2, name: "glpi" });
  assert.deepEqual(ws.sent.map((m) => [m.v, m.t, m.room]), [[1, "sub", "Ticket:1"]]);
  c.subscribe("Ticket:2");
  c.subscribe("Ticket:2");
  assert.equal(ws.sent.length, 2, "duplicate subscription ignored");
  ws.serverSays({ t: "subscribed", room: "Ticket:2" });
  assert.ok(c.isJoined("Ticket:2"));
  assert.ok(!c.isJoined("Ticket:1"));
});

test("reconnects with backoff and re-subscribes", () => {
  const { c, timers } = setup();
  c.subscribe("Ticket:7");
  c.start();
  FakeWs.all[0].serverSays(hello);
  FakeWs.all[0].serverCloses(1012); // server restart
  assert.equal(c.state, "waiting");
  assert.equal(timers.length, 1);
  timers[0].fn();
  FakeWs.all[1].serverCloses(1006); // still down
  assert.ok(timers[1].ms > timers[0].ms, "delay increases");
  timers[1].fn();
  FakeWs.all[2].serverSays(hello);
  assert.deepEqual(FakeWs.all[2].sent.map((m) => m.room), ["Ticket:7"]);
  FakeWs.all[2].serverCloses(1006);
  assert.equal(timers[2].ms, timers[0].ms, "attempts reset after a successful connection");
});

test("activity is sent on change and restored after reconnection", () => {
  const { c, timers } = setup();
  c.subscribe("Ticket:1");
  c.setActive(false); // before connecting: remembered
  c.start();
  FakeWs.all[0].serverSays(hello);
  assert.deepEqual(FakeWs.all[0].sent.map((m) => [m.t, m.active ?? m.room]), [
    ["activity", false],
    ["sub", "Ticket:1"],
  ]);
  c.setActive(false);
  assert.equal(FakeWs.all[0].sent.length, 2, "unchanged: nothing sent");
  c.setActive(true);
  assert.deepEqual(FakeWs.all[0].sent[2], { v: 1, id: 3, t: "activity", active: true });
  // New connection while active: the server default (active) is right, nothing sent.
  FakeWs.all[0].serverCloses(1006);
  timers[0].fn();
  FakeWs.all[1].serverSays(hello);
  assert.deepEqual(FakeWs.all[1].sent.map((m) => m.t), ["sub"]);
});

test("does not reconnect after revocation", () => {
  const { c, timers } = setup();
  c.start();
  FakeWs.all[0].serverSays(hello);
  FakeWs.all[0].serverSays({ t: "bye", reason: "revoked" });
  FakeWs.all[0].serverCloses(4001);
  assert.equal(c.state, "revoked");
  assert.equal(timers.length, 0);
});

test("stop() prevents reconnection and handlers survive errors", () => {
  const { c, timers } = setup();
  const seen: string[] = [];
  c.on("*", () => {
    throw new Error("buggy handler");
  });
  c.on("hello", (m) => seen.push(m.t));
  c.start();
  FakeWs.all[0].serverSays(hello);
  FakeWs.all[0].serverSays({ t: "pong" });
  FakeWs.all[0].onmessage?.({ data: "garbage" });
  FakeWs.all[0].onmessage?.({ data: JSON.stringify({ v: 2, t: "hello" }) });
  assert.deepEqual(seen, ["hello"]);
  c.stop();
  FakeWs.all[0].serverCloses(1006);
  assert.equal(timers.length, 0);
  assert.equal(c.state, "stopped");
});

test("state changes are announced (the presence bar shows the link's status)", () => {
  const { c, timers } = setup();
  const seen: string[] = [];
  const off = c.onState((s) => seen.push(`${s}${c.retrying ? "+" : ""}`));
  c.subscribe("Ticket:7");
  c.start();
  FakeWs.all[0].serverSays(hello);
  assert.equal(c.followed().join(), "Ticket:7");
  FakeWs.all[0].serverCloses(1006);
  timers[0].fn();
  FakeWs.all[1].serverSays(hello);
  assert.deepEqual(seen, ["connecting", "open", "waiting+", "connecting+", "open"], "each change once; retrying while lost");
  off();
  c.stop();
  assert.equal(seen.length, 5, "no more once unsubscribed");
});

test("what is sent depends on the connection and on the joined rooms", () => {
  const { c } = setup();
  c.subscribe("Ticket:7");
  c.setActive(false); // before the connection: remembered, sent with hello
  c.lock("Ticket:7");
  c.watch(["Ticket:8"]);
  c.start();
  const ws = FakeWs.all[0];
  assert.equal(ws.sent.length, 0, "nothing before hello");
  ws.serverSays(hello);
  assert.deepEqual(ws.sent.map((m) => m.t), ["activity", "sub", "watch"], "the state again on hello");
  assert.equal(c.isWatched("Ticket:8"), true);
  ws.sent.length = 0;
  c.lock("Ticket:7");
  c.compose("Ticket:7", "followup");
  assert.equal(ws.sent.length, 0, "not joined yet: no lock, no compose");
  ws.serverSays({ t: "subscribed", room: "Ticket:7" });
  c.lock("Ticket:7");
  c.lock("Ticket:7", true, "solution", "solution");
  c.unlock("Ticket:7");
  c.unlock("Ticket:7", "solution");
  c.compose("Ticket:7", null);
  c.setActive(false);
  c.setActive(true);
  c.watch([]);
  assert.deepEqual(ws.sent.map(({ v: _v, id: _id, ...m }) => m), [
    { t: "lock", room: "Ticket:7" },
    { t: "lock", room: "Ticket:7", force: true, scope: "solution", reason: "solution" },
    { t: "unlock", room: "Ticket:7" },
    { t: "unlock", room: "Ticket:7", scope: "solution" },
    { t: "compose", room: "Ticket:7", kind: null },
    { t: "activity", active: true },
    { t: "watch", rooms: [] },
  ], "a repeated activity is not sent");
  ws.serverSays({ t: "lock", room: "Ticket:7", scope: "fields", holder: { conn: "y", id: 3, name: "Bob", since: 1 } });
  assert.equal(c.lockOf("Ticket:7")?.name, "Bob", "the fields' holder is remembered");
  ws.serverSays({ t: "lock", room: "Ticket:7", scope: "solution", holder: { conn: "z", id: 4, name: "Carol", since: 1 } });
  assert.equal(c.lockOf("Ticket:7")?.name, "Bob", "not the solution's");
  ws.sent.length = 0;
  c.unsubscribe("Ticket:7");
  c.unsubscribe("Ticket:7");
  assert.deepEqual(ws.sent.map((m) => m.t), ["unsub"], "once");
  assert.equal(c.isJoined("Ticket:7"), false);
  assert.equal(c.lockOf("Ticket:9"), null);
});

test("a WebSocket that cannot even be created is retried", () => {
  FakeWs.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let attempts = 0;
  const c = new RealtimeClient({
    url: "wss://glpi.test/ws",
    WebSocket: function () {
      attempts++;
      throw new Error("blocked by CSP");
    } as unknown as typeof WebSocket,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    random: () => 0.5,
  });
  c.start();
  assert.equal(attempts, 1);
  assert.equal(c.state, "waiting");
  timers[0].fn();
  assert.equal(attempts, 2, "tried again after the delay");
});

test("refused twice and GLPI's session cannot be renewed: keeps trying (not revoked)", async () => {
  FakeWs.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const c = new RealtimeClient({
    url: "wss://glpi.test/ws",
    WebSocket: FakeWs as unknown as typeof WebSocket,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    random: () => 0.5,
    refreshSession: async () => {
      throw new Error("network");
    },
  });
  c.start();
  FakeWs.all[0].serverCloses(1006); // refused before hello
  timers.shift()!.fn();
  FakeWs.all[1].serverCloses(1006);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(c.state, "waiting", "a failed renewal is not a revocation");
  assert.equal(timers.length > 0, true, "another attempt scheduled");
});

test("a state listener that throws does not stop the others", () => {
  const { c } = setup();
  const seen: string[] = [];
  c.onState(() => {
    throw new Error("bad listener");
  });
  c.onState((s) => seen.push(s));
  c.start();
  assert.deepEqual(seen, ["connecting"]);
});
