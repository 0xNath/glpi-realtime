import assert from "node:assert/strict";
import { test } from "node:test";

import { RealtimeClient } from "../src/client.ts";
import { CLOSE_REVOKED } from "../src/protocol.ts";

/** Valkey restarted and lost its data: sessions and grants are gone, GLPI issues new ones. */

class FakeWs {
  static all: FakeWs[] = [];
  sent: Record<string, any>[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(_url: string) {
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

const hello = { t: "hello", conn: "x", user: { id: 2, name: "me" }, ping_interval: 30 };
const tick = () => new Promise((r) => setTimeout(r, 0));
const last = () => FakeWs.all.at(-1)!;

function setup(opts: { alive?: boolean; regrant?: (room: string) => Promise<unknown> } = {}) {
  FakeWs.all = [];
  let clock = 0;
  const refreshes: number[] = [];
  const c = new RealtimeClient({
    url: "wss://glpi.test/ws",
    WebSocket: FakeWs as unknown as typeof WebSocket,
    setTimeout: (fn) => (fn(), 0), // reconnect at once
    clearTimeout: () => {},
    random: () => 0.5,
    now: () => clock,
    regrant: opts.regrant,
    refreshSession: async () => {
      refreshes.push(clock);
      return opts.alive ?? true;
    },
  });
  return { c, refreshes, advance: (ms: number) => (clock += ms) };
}

test("closed as revoked: GLPI issues a new token, the tab reconnects", async () => {
  const { c, refreshes } = setup();
  c.start();
  last().serverSays(hello);
  last().serverCloses(CLOSE_REVOKED);
  await tick();
  assert.equal(refreshes.length, 1);
  assert.equal(FakeWs.all.length, 2, "reconnected");
  last().serverSays(hello);
  assert.equal(c.state, "open");
});

test("closed as revoked, GLPI session over: stays disconnected", async () => {
  const { c, refreshes } = setup({ alive: false });
  c.start();
  last().serverSays(hello);
  last().serverCloses(CLOSE_REVOKED);
  await tick();
  assert.equal(refreshes.length, 1);
  assert.equal(c.state, "revoked");
  assert.equal(FakeWs.all.length, 1);
});

test("a real revocation does not loop: one refresh per 30 s", async () => {
  const { c, refreshes, advance } = setup();
  c.start();
  last().serverSays(hello);
  last().serverCloses(CLOSE_REVOKED);
  await tick();
  last().serverSays(hello);
  advance(5_000);
  last().serverCloses(CLOSE_REVOKED); // revoked again at once
  await tick();
  assert.equal(refreshes.length, 1);
  assert.equal(c.state, "revoked");
});

test("refused connections (token unknown): GLPI is asked after the second", async () => {
  const { c, refreshes } = setup();
  c.start();
  last().serverCloses(1006);
  await tick();
  assert.equal(refreshes.length, 0, "one refusal: may be the network");
  last().serverCloses(1006);
  await tick();
  assert.equal(refreshes.length, 1);
  last().serverSays(hello);
  assert.equal(c.state, "open");
});

test("a room refused after a reconnection is granted again by GLPI, once", async () => {
  const asked: string[] = [];
  const { c } = setup({ regrant: async (room) => asked.push(room) });
  const lost: string[] = [];
  c.on("unsubscribed", (m) => m.t === "unsubscribed" && lost.push(m.room));
  c.subscribe("Ticket:1");
  c.start();
  last().serverSays(hello);
  last().serverSays({ id: last().sent.at(-1)!.id, t: "subscribed", room: "Ticket:1" });
  // Valkey lost the grants: the new connection is refused the room.
  last().serverCloses(1012);
  last().serverSays(hello);
  last().serverSays({ id: last().sent.at(-1)!.id, t: "error", code: "forbidden", message: "" });
  await tick();
  assert.deepEqual(asked, ["Ticket:1"], "GLPI asked for the grant");
  const again = last().sent.at(-1)!;
  assert.deepEqual([again.t, again.room], ["sub", "Ticket:1"], "and subscribed again");
  assert.deepEqual(lost, [], "not reported lost");
  // Refused again: the rights are really gone.
  last().serverSays({ id: again.id, t: "error", code: "forbidden", message: "" });
  assert.deepEqual(lost, ["Ticket:1"]);
});
