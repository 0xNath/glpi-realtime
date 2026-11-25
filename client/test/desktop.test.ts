import assert from "node:assert/strict";
import { test } from "node:test";

import { desktopText, notifyDesktop } from "../src/desktop.ts";
import { type InboxList, LABELS } from "../src/inbox.ts";

const list = {
  enabled: true,
  items: [],
  objects: { "Ticket:4": { type: "Ticket", id: 4, title: "Imprimante en panne", url: "/front/ticket.form.php?id=4", status: 2 } },
  users: {},
  counts: {},
  preferences: { update_message_style: "priority", resolved_closed_style: "separate" },
  can_see_others: false,
} as unknown as InboxList;
const item = { id: 1, key: "Ticket:4", event: "assigned", channel: "direct", detail: null, is_read: false, actor: 0, date: "", ts: 0, queue: "mine" } as const;

test("text of a desktop notification", () => {
  assert.deepEqual(desktopText(list, { ...item }, LABELS.fr), {
    title: "#4 Imprimante en panne",
    body: "Vous avez été attribué",
    url: "/front/ticket.form.php?id=4",
  });
  assert.equal(desktopText(list, { ...item, key: "Ticket:9" }, LABELS.fr), null, "unknown (unreadable) item: nothing");
});

test("only in the background, only when enabled", () => {
  const shown: string[] = [];
  class N {
    static permission = "granted";
    onclick: (() => void) | null = null;
    constructor(title: string) {
      shown.push(title);
    }
    close() {}
  }
  const store = new Map([["glpi-rt-desktop", "1"]]);
  const win = { Notification: N, localStorage: { getItem: (k: string) => store.get(k) ?? null }, focus() {}, location: {} };
  const doc = (visibilityState: string) => ({ visibilityState, defaultView: win }) as unknown as Document;
  notifyDesktop(doc("visible"), list, [{ ...item }], LABELS.en);
  assert.deepEqual(shown, [], "visible tab: the bell is enough");
  notifyDesktop(doc("hidden"), list, [{ ...item }], LABELS.en);
  assert.deepEqual(shown, ["#4 Imprimante en panne"]);
  store.set("glpi-rt-desktop", "0");
  notifyDesktop(doc("hidden"), list, [{ ...item }], LABELS.en);
  assert.equal(shown.length, 1, "turned off");
});

test("turning them on asks the browser once; off, refused, unsupported or blocked: off", async () => {
  const { setDesktop, desktopEnabled } = await import("../src/desktop.ts");
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  let asked = 0;
  let answer = "granted";
  const N = { permission: "default", requestPermission: async () => (asked++, answer) };
  const win = { Notification: N, localStorage: storage } as unknown as Window;
  assert.equal(await setDesktop(true, win), true);
  assert.equal(asked, 1);
  N.permission = "granted";
  assert.equal(desktopEnabled(win), true);
  assert.equal(await setDesktop(true, win), true);
  assert.equal(asked, 1, "already granted: not asked again");
  assert.equal(await setDesktop(false, win), false);
  assert.equal(desktopEnabled(win), false, "turned off here, whatever the browser allows");
  N.permission = "default";
  answer = "denied";
  assert.equal(await setDesktop(true, win), false, "refused by the user");
  assert.equal(store.get("glpi-rt-desktop"), "0");
  assert.equal(await setDesktop(true, { localStorage: storage } as unknown as Window), false, "no Notification API");
  const blocked = { Notification: N, get localStorage(): Storage { throw new Error("blocked"); } } as unknown as Window;
  assert.equal(await setDesktop(true, blocked), false, "storage blocked (private mode)");
  N.permission = "granted"; // so that the storage is read, and throws
  assert.equal(desktopEnabled(blocked), false);
});

test("a click on the notification focuses GLPI and opens the item, GLPI's own paths only", () => {
  const notes: any[] = [];
  class N {
    static permission = "granted";
    onclick: (() => void) | null = null;
    closed = false;
    constructor() {
      notes.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  let focused = 0;
  const win = { Notification: N, localStorage: { getItem: () => "1" }, focus: () => focused++, location: { href: "" } };
  const doc = { visibilityState: "hidden", defaultView: win } as unknown as Document;
  const foreign = { ...list, objects: { ...list.objects, "Ticket:5": { ...list.objects["Ticket:4"], id: 5, url: "//evil.example/x" } } } as InboxList;
  notifyDesktop(doc, foreign, [{ ...item }, { ...item, key: "Ticket:5" }], LABELS.en);
  notes[0].onclick();
  assert.equal(win.location.href, "/front/ticket.form.php?id=4");
  assert.equal(notes[0].closed, true);
  win.location.href = "";
  notes[1].onclick();
  assert.equal(win.location.href, "", "a protocol-relative URL is not followed");
  assert.equal(focused, 2);
});
