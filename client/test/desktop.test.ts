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
const item = { id: 1, key: "Ticket:4", event: "assigned", channel: "direct", detail: null, is_read: false, actor: 0, date: "", queue: "mine" } as const;

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
