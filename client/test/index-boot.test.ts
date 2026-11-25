import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { page } from "./dom.ts";

// The entry point (index.ts) wires everything when the bundle loads in a GLPI page: the
// client, the presence bars, the bell or the toasts, the lists, the fields editor, the
// timeline. Each test loads it into its own page (a fresh module instance), with doubles of
// the WebSocket and of GLPI's endpoints. Timers are mocked: the keepalives re-arm forever.

class FakeWs {
  static all: FakeWs[] = [];
  sent: any[] = [];
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
  says(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...m }) });
  }
}

const THROW = Symbol("throw");
const hello = { t: "hello", conn: "c1", user: { id: 1, name: "Me" }, ping_interval: 30 };
const inboxList = { enabled: true, items: [], objects: {}, users: {}, counts: { all: 0 }, preferences: { update_message_style: "priority", resolved_closed_style: "separate", show_resolved: true, show_closed: true }, can_see_others: false };

let entry: { start: () => Promise<void>; autostart: () => void } | null = null;
/** Loads index.ts into `html`, GLPI's endpoints answering with `endpoints` (path → body). */
async function boot(t: TestContext, html: string, endpoints: Record<string, unknown> = {}, lang = "en") {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { window, document } = page(html.replace("<html>", `<html lang="${lang}">`));
  // linkedom's windows share Node's global object: the previous page's client would
  // look like this one's (index.ts starts once per page).
  delete (window as any).glpiRealtime;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  FakeWs.all = [];
  const fetched: { url: string; method: string; body?: string }[] = [];
  const store = new Map<string, string>();
  Object.assign(window, { WebSocket: FakeWs, CFG_GLPI: { root_doc: "/glpi" } });
  Object.assign(globalThis, {
    location: { protocol: "https:", host: "glpi.test", href: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    MutationObserver: window.MutationObserver,
    fetch: async (url: string, init: RequestInit = {}) => {
      fetched.push({ url, method: String(init.method ?? "GET"), body: init.body as string | undefined });
      const path = Object.keys(endpoints).find((p) => url.includes(p));
      const body = path ? endpoints[path] : {};
      if (body === THROW) throw new Error("network");
      return { ok: path !== undefined, status: path ? 200 : 404, json: async () => body };
    },
  });
  t.after(() => {
    for (const k of ["location", "localStorage", "MutationObserver", "fetch"]) delete (globalThis as any)[k];
  });
  if (!entry) {
    // The first page loads the bundle while GLPI's page is still loading: it starts on
    // DOMContentLoaded.
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });
    entry = await import("../src/index.ts");
    assert.equal(FakeWs.all.length, 0, "not before the page is loaded");
    document.dispatchEvent(new (window as any).Event("DOMContentLoaded"));
  } else {
    await entry.start();
  }
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  await flush();
  return { window, document, fetched, ws: () => FakeWs.all[FakeWs.all.length - 1], flush, store };
}

const TICKET = `<!doctype html><html><head></head><body>
  <div class="page"><header><div><div class="ms-lg-auto"><form role="search"></form></div></div></header></div>
  <div id="navigationheader"></div>
  <div id="itil-object-container" data-glpi-realtime-room="Ticket:5">
    <form id="itil-form"><input name="name" value="Printer"><button name="update" type="submit">Save</button></form>
    <div class="itil-timeline"><div class="timeline-item ITILContent" data-itemtype="Ticket" data-items-id="5"></div></div>
  </div></body></html>`;

test("a technician's ticket: connects, subscribes, shows the status, the bell, the editor; follows the DOM", async (t) => {
  const { window, document, ws, flush, fetched } = await boot(t, TICKET, { "inbox.php": inboxList, "grant.php": {}, "session.php": { ok: true } });
  const client = (window as any).glpiRealtime;
  assert.equal(ws().url, "wss://glpi.test/ws");
  assert.equal(document.querySelector("style")?.textContent?.includes("prefers-reduced-motion"), true);
  assert.equal(document.querySelector(".glpi-rt-bell") !== null, true, "the bell, for a technician");
  assert.equal(fetched.some((f) => f.url === "/glpi/plugins/realtime/ajax/inbox.php?read=0&full=0"), true);

  ws().says(hello);
  assert.deepEqual(ws().sent.map((m) => [m.t, m.room]), [["sub", "Ticket:5"]]);
  ws().says({ t: "subscribed", room: "Ticket:5" });
  assert.equal(document.querySelector(".glpi-rt-presence .glpi-rt-status")?.className, "glpi-rt-status is-live");
  ws().says({ t: "presence", room: "Ticket:5", users: [{ id: 1, name: "Me", since: 0, active: true }, { id: 2, name: "Bob", since: 1, active: true }] });
  assert.equal(document.querySelectorAll(".glpi-rt-presence .glpi-rt-avatar[data-uid]").length, 1);

  // The fields editor: an edit asks for the lock (before anyone changed the item).
  ws().sent.length = 0;
  document.querySelector("#itil-form input")!.dispatchEvent(new (window as any).Event("focusin", { bubbles: true }));
  assert.deepEqual(ws().sent.map((m) => m.t), ["lock"]);

  // Someone else changed the fields: the banner (timeline events are shown live instead).
  ws().says({ t: "event", room: "Ticket:5", kind: "followup.add", by: { id: 2, name: "Bob" } });
  assert.equal(document.querySelector(".glpi-rt-updates") === null || (document.querySelector(".glpi-rt-updates") as HTMLElement).hidden, true);
  ws().says({ t: "event", room: "Ticket:5", kind: "item.update", fields: ["status"], by: { id: 2, name: "Bob" } });
  assert.match(document.querySelector(".glpi-rt-updates")?.textContent ?? "", /Bob changed the status/);

  // GLPI loads another item's form later: followed too.
  const more = document.createElement("div");
  more.setAttribute("data-glpi-realtime-room", "Ticket:6");
  document.body.append(more);
  await new Promise((r) => setImmediate(r));
  await flush();
  assert.equal(ws().sent.some((m) => m.t === "sub" && m.room === "Ticket:6"), true);

  // Rights changed: GLPI recomputes the grant. A notification: the bell reloads.
  ws().says({ t: "regrant", room: "Ticket:5" });
  await flush();
  assert.equal(fetched.some((f) => f.url === "/glpi/plugins/realtime/ajax/grant.php?itemtype=Ticket&id=5"), true);
  const before = fetched.length;
  ws().says({ t: "notification", nid: "n1", kind: "commented", room: "Ticket:5", by: { id: 2, name: "Bob" }, alert: true });
  t.mock.timers.tick(300);
  await flush();
  assert.equal(fetched.length > before, true, "the bell reloaded");

  // Access lost: said, and the status says not live.
  ws().says({ t: "unsubscribed", room: "Ticket:5", reason: "forbidden" });
  assert.equal(document.querySelector(".glpi-rt-updates")?.classList.contains("is-lost"), true);
  assert.equal(document.querySelector("#glpi-rt-presence-Ticket-5 .glpi-rt-status")?.className, "glpi-rt-status is-unavailable");

  // Valkey lost the session (4001): GLPI is asked for a new one.
  ws().onclose?.({ code: 4001 });
  await flush();
  assert.equal(fetched.some((f) => f.url === "/glpi/plugins/realtime/ajax/session.php"), true);
  assert.equal(client.state === "waiting" || client.state === "connecting", true);

  // Our own change from this tab (focused): no banner.
  ws().says(hello);
  const updates = document.querySelectorAll(".glpi-rt-updates").length;
  ws().says({ t: "event", room: "Ticket:6", kind: "item.update", by: { id: 1, name: "Me" } });
  assert.equal(document.querySelectorAll(".glpi-rt-updates").length, updates);
});

test("self-service (the bell not offered): a toast per alert, none for syncs", async (t) => {
  const { document, ws } = await boot(t, TICKET, { "inbox.php": { enabled: false } });
  assert.equal(document.querySelector(".glpi-rt-bell") === null, true);
  ws().says(hello);
  ws().says({ t: "notification", nid: "a", kind: "commented", room: "Ticket:5", by: { id: 2, name: "Bob" }, alert: true });
  ws().says({ t: "notification", nid: "b", kind: "inbox", room: "", by: { id: 1, name: "Me" }, alert: true });
  ws().says({ t: "notification", nid: "c", kind: "commented", room: "Ticket:5", by: { id: 2, name: "Bob" }, alert: false });
  assert.equal(document.querySelectorAll(".glpi-rt-toast").length, 1);
});

test("a list page: its rows' grants asked from GLPI, then followed", async (t) => {
  const LIST = `<!doctype html><html><head></head><body><table class="search-results"><tbody>
    <tr><td><input type="checkbox" class="massive_action_checkbox" name="item[Ticket][3]"></td><td data-searchopt-content-id="1">T3</td></tr>
  </tbody></table></body></html>`;
  const { ws, fetched, flush } = await boot(t, LIST, { "inbox.php": inboxList, "grants.php": { rooms: ["Ticket:3"] } });
  ws().says(hello);
  t.mock.timers.tick(300);
  await flush();
  const asked = fetched.find((f) => f.url.endsWith("/grants.php"));
  assert.deepEqual(JSON.parse(asked!.body!), { items: ["Ticket:3"] });
  assert.equal(ws().sent.some((m) => m.t === "watch" && m.rooms.includes("Ticket:3")), true);
});

test("the notifications page: the full table, not the bell", async (t) => {
  const PAGE = `<!doctype html><html><head></head><body><div id="glpi-rt-inbox-page"></div></body></html>`;
  const { document, flush } = await boot(t, PAGE, { "inbox.php": inboxList });
  await flush();
  assert.equal(document.querySelector(".glpi-rt-page") !== null, true);
  assert.equal(document.querySelector(".glpi-rt-bell") === null, true);
});

test("another language: its catalog asked first; none, or broken: English", async (t) => {
  const { fetched } = await boot(t, `<!doctype html><html><head></head><body></body></html>`, { "i18n.php": { list: { refresh: "Aktualisieren" } }, "inbox.php": inboxList }, "de");
  assert.equal(fetched[0].url, "/glpi/plugins/realtime/ajax/i18n.php", "before anything is drawn");
});

test("the catalog cannot be had: English, and the rest starts", async (t) => {
  const { window } = await boot(t, `<!doctype html><html><head></head><body></body></html>`, { "i18n.php": THROW, "inbox.php": inboxList }, "it");
  assert.equal((window as any).glpiRealtime !== undefined, true);
});

test("while the WebSocket is down, the bell is reloaded every minute", async (t) => {
  const { fetched, flush } = await boot(t, TICKET, { "inbox.php": inboxList });
  const before = fetched.filter((f) => f.url.includes("inbox.php")).length;
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(300);
  await flush();
  assert.equal(fetched.filter((f) => f.url.includes("inbox.php")).length > before, true);
});

test("already started, or no WebSocket in this browser: nothing", async (t) => {
  const { window } = await boot(t, `<!doctype html><html><head></head><body></body></html>`, { "inbox.php": inboxList });
  const first = (window as any).glpiRealtime;
  assert.equal(first !== undefined, true);
  const count = FakeWs.all.length;
  await entry!.start();
  assert.equal(FakeWs.all.length, count, "a second copy of the bundle does not start another client");
  delete (window as any).glpiRealtime;
  delete (window as any).WebSocket;
  await entry!.start();
  assert.equal(FakeWs.all.length, count, "no WebSocket in this browser: nothing");
});

test("the bundle loaded after the page: it starts at once", async (t) => {
  const { window } = await boot(t, `<!doctype html><html><head></head><body></body></html>`, { "inbox.php": inboxList });
  delete (window as any).glpiRealtime;
  const count = FakeWs.all.length;
  Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
  entry!.autostart();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(FakeWs.all.length, count + 1);
});
