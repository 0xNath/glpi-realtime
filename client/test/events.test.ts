import assert from "node:assert/strict";
import { test } from "node:test";

import { RealtimeClient } from "../src/client.ts";
import { link, text } from "../src/notifications.ts";
import { describe, summary, who } from "../src/updates.ts";

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

function setup(regrant?: (room: string) => Promise<unknown>) {
  FakeWs.all = [];
  const c = new RealtimeClient({
    url: "wss://glpi.test/ws",
    WebSocket: FakeWs as unknown as typeof WebSocket,
    setTimeout: () => 0,
    clearTimeout: () => {},
    random: () => 0.5,
    regrant,
  });
  const seen: Record<string, any>[] = [];
  c.on("*", (m) => seen.push(m));
  c.subscribe("Ticket:1");
  c.start();
  const ws = FakeWs.all[0];
  ws.serverSays(hello);
  ws.serverSays({ id: ws.sent[0].id, t: "subscribed", room: "Ticket:1" });
  return { c, ws, seen };
}

test("regrant: asks GLPI for a new grant, then subscribes again", async () => {
  const asked: string[] = [];
  let release!: () => void;
  const { c, ws } = setup((room) => {
    asked.push(room);
    return new Promise<void>((r) => (release = r));
  });
  ws.serverSays({ t: "regrant", room: "Ticket:1" });
  assert.deepEqual(asked, ["Ticket:1"]);
  assert.equal(ws.sent.length, 1, "no sub before GLPI answered");
  release();
  await tick();
  assert.deepEqual(ws.sent.map((m) => [m.t, m.room]), [["sub", "Ticket:1"], ["sub", "Ticket:1"]]);
  ws.serverSays({ id: ws.sent[1].id, t: "subscribed", room: "Ticket:1" });
  assert.ok(c.isJoined("Ticket:1"));
});

test("regrant still subscribes again when GLPI fails, the server decides", async () => {
  const { ws } = setup(() => Promise.reject(new Error("offline")));
  ws.serverSays({ t: "regrant", room: "Ticket:1" });
  await tick();
  assert.equal(ws.sent.at(-1)!.t, "sub");
});

test("a refused re-subscription forgets the room and reports it", async () => {
  const { c, ws, seen } = setup(() => Promise.resolve());
  ws.serverSays({ t: "regrant", room: "Ticket:1" });
  await tick();
  ws.serverSays({ id: ws.sent.at(-1)!.id, t: "error", code: "forbidden", message: "no grant" });
  assert.ok(!c.isJoined("Ticket:1"));
  assert.deepEqual(seen.at(-2), { v: 1, t: "unsubscribed", room: "Ticket:1", reason: "forbidden" });
  // Not re-subscribed after a reconnection.
  ws.serverCloses(1012);
  FakeWs.all.length = 0;
  (c as any).connect();
  FakeWs.all[0].serverSays(hello);
  assert.deepEqual(FakeWs.all[0].sent, []);
});

test("a room refused from the start is dropped silently", () => {
  FakeWs.all = [];
  const c = new RealtimeClient({ url: "wss://x/ws", WebSocket: FakeWs as unknown as typeof WebSocket, setTimeout: () => 0 });
  const seen: string[] = [];
  c.on("unsubscribed", (m) => seen.push(m.t));
  c.subscribe("Ticket:9");
  c.start();
  FakeWs.all[0].serverSays(hello);
  FakeWs.all[0].serverSays({ id: FakeWs.all[0].sent[0].id, t: "error", code: "forbidden", message: "" });
  assert.deepEqual(seen, []);
  c.subscribe("Ticket:9");
  assert.equal(FakeWs.all[0].sent.length, 2, "can be tried again later");
});

test("server-side removal is reported once", () => {
  const { c, ws, seen } = setup();
  ws.serverSays({ t: "unsubscribed", room: "Ticket:1", reason: "forbidden" });
  assert.ok(!c.isJoined("Ticket:1"));
  assert.equal(seen.filter((m) => m.t === "unsubscribed").length, 1);
});

test("event sentences", () => {
  const bob = { id: 7, name: "Bob" };
  assert.equal(describe({ kind: "followup.add", by: bob }, 2, "en"), "Bob added a followup");
  assert.equal(describe({ kind: "followup.add", by: bob }, 2, "fr"), "Bob a ajouté un suivi");
  assert.equal(describe({ kind: "item.update", fields: ["status"], by: bob }, 2, "en"), "Bob changed the status");
  assert.equal(
    describe({ kind: "item.update", fields: ["status", "priority", "urgency"], by: bob }, 2, "fr"),
    "Bob a modifié le statut, la priorité et l'urgence",
  );
  assert.equal(describe({ kind: "item.update", fields: ["status", "global_validation"], by: bob }, 2, "en"), "Bob updated the ticket", "unnamed field: generic");
  assert.equal(describe({ kind: "brand.new", by: bob }, 2, "en"), "Bob updated the ticket");
  assert.equal(who({ id: 2, name: "me" }, 2, "en"), "You");
  assert.equal(who({ id: 0, name: "" }, 2, "fr"), "GLPI");
  assert.equal(who({ id: 5, name: "" }, 2, "fr"), "#5");
  assert.equal(
    summary([{ kind: "task.add", by: bob }, { kind: "document.add", by: bob }, { kind: "solution.add", by: bob }], 2, "en"),
    "Bob proposed a solution (+2 more changes)",
  );
  assert.equal(summary([], 2, "en"), "");
});

test("notification text and link", () => {
  const n = { nid: "x", kind: "assigned", room: "Ticket:42", by: { id: 7, name: "Alice" } };
  assert.equal(text(n, 2, "fr"), "Alice vous a attribué le ticket n°42");
  assert.equal(text(n, 2, "en"), "Alice assigned you ticket #42");
  assert.equal(text({ ...n, kind: "validation_asked" }, 2, "en"), "Alice requests your approval on ticket #42");
  assert.equal(text({ ...n, kind: "unknown", by: { id: 0, name: "" } }, 2, "en"), "GLPI updated ticket #42");
  assert.equal(link("Ticket:42", "/glpi"), "/glpi/front/ticket.form.php?id=42");
  assert.equal(link("Ticket:42\"><x", ""), null);
});

test("changes and problems are named as such", async () => {
  const { describe: d, summary: s } = await import("../src/updates.ts");
  const { labels } = await import("../src/presence.ts");
  const bob = { id: 7, name: "Bob" };
  assert.equal(d({ kind: "item.update", by: bob }, 2, "fr", "Change"), "Bob a modifié le changement");
  assert.equal(d({ kind: "item.delete", by: bob }, 2, "en", "Problem"), "Bob moved the problem to the trash");
  assert.equal(d({ kind: "item.update", fields: ["status"], by: bob }, 2, "fr", "Problem"), "Bob a modifié le statut");
  assert.equal(d({ kind: "followup.add", by: bob }, 2, "fr", "Change"), "Bob a ajouté un suivi");
  assert.equal(s([{ kind: "item.purge", by: bob }], 2, "en", "Change"), "Bob deleted the change");
  assert.equal(labels("fr", "Change").also, "Également sur ce changement :");
  assert.equal(labels("en", "Problem").active, "active on this problem");
  assert.equal(labels("en").also, "Also on this ticket:");
});
