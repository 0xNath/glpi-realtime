import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { render, setStatus } from "../src/presence.ts";
import type { PresenceUser } from "../src/protocol.ts";
import { event, page } from "./dom.ts";

// The presence bar's avatars: more than five, and GLPI's user card on hover (its HTML from
// ajax/comments.php, through GLPI's jQuery and Bootstrap: doubles here).

const user = (id: number, name: string, active = true) => ({ id, name, since: id, active }) as PresenceUser;

function itemPage(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { document } = page(`<!doctype html><html lang="en"><head></head><body><div id="navigationheader"></div></body></html>`);
  const asked: unknown[] = [];
  (globalThis as any).CFG_GLPI = { root_doc: "/glpi" };
  (globalThis as any).jQuery = { ajax: (o: unknown) => (asked.push(o), Promise.resolve("<div class='card'>Alice Martin</div>")) };
  const popovers: { el: Element; opts: any; shown: number; hidden: number; tip: Element }[] = [];
  (globalThis as any).bootstrap = {
    Popover: class {
      tip: Element;
      constructor(el: Element, opts: any) {
        this.tip = document.createElement("div");
        this.tip.className = "popover glpi-rt-card";
        popovers.push(Object.assign(this, { el, opts, shown: 0, hidden: 0 }) as any);
      }
      show() {
        (this as any).shown++;
      }
      hide() {
        (this as any).hidden++;
      }
    },
  };
  t.after(() => {
    delete (globalThis as any).jQuery;
    delete (globalThis as any).bootstrap;
    delete (globalThis as any).CFG_GLPI;
  });
  return { document, asked, popovers };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("more than five people: five avatars, then +N with their names", (t) => {
  const { document } = itemPage(t);
  setStatus(document, "Ticket:21", "live", 1);
  render(document, "Ticket:21", [user(1, "Me"), ...[2, 3, 4, 5, 6, 7, 8].map((i) => user(i, `User ${i}`))], 1);
  assert.equal(document.querySelectorAll(".glpi-rt-avatar[data-uid]").length, 5);
  const more = document.querySelector(".glpi-rt-more")!;
  assert.equal(more.textContent, "+2");
  assert.equal(more.getAttribute("title"), "User 7, User 8");
  assert.equal(more.getAttribute("aria-label"), "and 2 more");
  render(document, "Ticket:21", [user(1, "Me"), user(2, "User 2")], 1);
  assert.equal(document.querySelector(".glpi-rt-more") === null, true, "gone when five or fewer");
});

test("GLPI's user card on hover: asked once, shown below, hidden after leaving", async (t) => {
  const { document, asked, popovers } = itemPage(t);
  setStatus(document, "Ticket:22", "live", 1);
  render(document, "Ticket:22", [user(2, "Alice Martin")], 1);
  const avatar = document.querySelector<HTMLElement>(".glpi-rt-avatar[data-uid='2']")!;
  (avatar as any).matches = (sel: string) => sel.includes(":hover") || sel.includes(":focus");
  avatar.dispatchEvent(event("mouseenter"));
  await flush();
  assert.deepEqual(asked, [{ url: "/glpi/ajax/comments.php", type: "POST", data: { itemtype: "User", value: 2 } }]);
  assert.equal(popovers.length, 1);
  assert.equal(popovers[0].opts.content, "<div class='card'>Alice Martin</div>");
  assert.equal(popovers[0].opts.placement, "bottom");
  assert.deepEqual(popovers[0].opts.popperConfig({ modifiers: [] }).modifiers.map((m: any) => m.name), ["flip", "preventOverflow"]);
  assert.equal(popovers[0].shown, 1);
  avatar.dispatchEvent(event("focus"));
  await flush();
  assert.equal(asked.length, 1, "the card is cached");
  assert.equal(popovers.length, 1, "one popover per avatar");

  (avatar as any).matches = () => false;
  avatar.dispatchEvent(event("mouseleave"));
  t.mock.timers.tick(300);
  assert.equal(popovers[0].hidden, 1, "hidden 300 ms after leaving");
});

test("the card stays while it is hovered, and needs Bootstrap", async (t) => {
  const { document, popovers } = itemPage(t);
  setStatus(document, "Ticket:23", "live", 1);
  render(document, "Ticket:23", [user(3, "Bob")], 1);
  const avatar = document.querySelector<HTMLElement>(".glpi-rt-avatar[data-uid='3']")!;
  (avatar as any).matches = (sel: string) => sel.includes(":hover");
  avatar.dispatchEvent(event("mouseenter"));
  await flush();
  const tip = popovers[0].tip as any;
  tip.matches = () => true; // the pointer moved onto the card
  (avatar as any).matches = () => false;
  avatar.dispatchEvent(event("mouseleave"));
  t.mock.timers.tick(300);
  assert.equal(popovers[0].hidden, 0, "kept while the card is hovered");
  tip.matches = () => false;
  t.mock.timers.tick(300);
  assert.equal(popovers[0].hidden, 1);

  delete (globalThis as any).bootstrap;
  render(document, "Ticket:23", [user(3, "Bob"), user(4, "Carol")], 1);
  const carol = document.querySelector<HTMLElement>(".glpi-rt-avatar[data-uid='4']")!;
  (carol as any).matches = () => true;
  carol.dispatchEvent(event("mouseenter"));
  await flush();
  assert.equal(popovers.length, 1, "no Bootstrap (popups): no card for new avatars");
});

test("without GLPI's jQuery, or when the card cannot be had: no card", async (t) => {
  const { document, popovers } = itemPage(t);
  delete (globalThis as any).jQuery;
  setStatus(document, "Ticket:24", "live", 1);
  render(document, "Ticket:24", [user(9, "Dan")], 1);
  const avatar = document.querySelector<HTMLElement>(".glpi-rt-avatar[data-uid='9']")!;
  (avatar as any).matches = () => true;
  avatar.dispatchEvent(event("mouseenter"));
  await flush();
  assert.equal(popovers.length, 0);
  t.mock.timers.tick(5 * 60_000); // the cache forgets it
});
