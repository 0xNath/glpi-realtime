import assert from "node:assert/strict";
import { test } from "node:test";

import { Toasts } from "../src/notifications.ts";
import { UpdatesBanner } from "../src/updates.ts";
import { page } from "./dom.ts";

// The banner saying someone changed the item, and the self-service toasts, in a DOM
// without a browser.

const BOB = { id: 2, name: "Bob" };

function itemPage(lang = "en") {
  return page(`<!doctype html><html lang="${lang}"><head></head><body><div id="itil-object-container"><div id="first"></div></div></body></html>`).document;
}

test("banner: who changed what, accumulated, with Refresh; dismissed until the next change", () => {
  const document = itemPage();
  let reloads = 0;
  const banner = new UpdatesBanner(document, () => reloads++);
  const bar = () => document.getElementById("glpi-rt-updates-Ticket-5");
  const text = () => bar()?.querySelector(".glpi-rt-updates-text")?.textContent;

  banner.add("Ticket:5", { kind: "item.update", fields: ["status"], by: BOB }, 1);
  assert.equal(bar()?.hidden, false);
  assert.equal(bar()?.parentElement?.firstElementChild === bar(), true, "on top of the item");
  assert.equal(text(), "Bob changed the status");
  banner.add("Ticket:5", { kind: "followup.add", by: BOB }, 1);
  assert.match(text() ?? "", /^Bob added a followup \(\+1 more change\)$/);

  bar()!.querySelector<HTMLElement>(".glpi-rt-refresh")!.click();
  assert.equal(reloads, 1);
  bar()!.querySelector<HTMLElement>(".glpi-rt-dismiss")!.click();
  assert.equal(bar()?.hidden, true);
  banner.add("Ticket:5", { kind: "item.update", fields: ["priority"], by: { id: 0, name: "" } }, 1);
  assert.equal(text(), "GLPI changed the priority", "the dismissed changes are not counted again");
});

test("banner: our own change from another tab says 'You'; one per item", () => {
  const document = itemPage("fr");
  const banner = new UpdatesBanner(document, () => {});
  banner.add("Ticket:5", { kind: "item.update", fields: ["status"], by: { id: 1, name: "Me" } }, 1);
  banner.add("Change:9", { kind: "item.update", fields: ["status"], by: BOB }, 1);
  assert.match(document.getElementById("glpi-rt-updates-Ticket-5")?.textContent ?? "", /^Vous /);
  assert.equal(document.querySelectorAll(".glpi-rt-updates").length, 2);
});

test("banner: access lost says so, cannot be dismissed, and further changes do not hide it", () => {
  const document = itemPage();
  const banner = new UpdatesBanner(document, () => {});
  banner.lost("Ticket:5");
  const bar = document.getElementById("glpi-rt-updates-Ticket-5")!;
  assert.equal(bar.classList.contains("is-lost"), true);
  assert.equal(bar.querySelector(".glpi-rt-updates-text")?.textContent, "You no longer have access to this ticket.");
  assert.equal(bar.querySelector<HTMLElement>(".glpi-rt-dismiss")?.hidden, true);
  banner.add("Ticket:5", { kind: "item.update", fields: ["status"], by: BOB }, 1);
  assert.equal(bar.querySelector(".glpi-rt-updates-text")?.textContent, "You no longer have access to this ticket.");
});

test("banner: no item container on the page, nothing drawn", () => {
  const { document } = page(`<!doctype html><html lang="en"><head></head><body></body></html>`);
  new UpdatesBanner(document, () => {}).add("Ticket:5", { kind: "item.update", by: BOB }, 1);
  assert.equal(document.querySelector(".glpi-rt-updates") === null, true);
});

test("toasts: one per alert, its text and link, closed by hand or after a while, never twice", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = itemPage();
  const toasts = new Toasts(document, "/glpi", 15_000);
  const n = { nid: "n1", kind: "commented", room: "Ticket:42", by: BOB, alert: true };
  toasts.show(n as any, 1);
  toasts.show(n as any, 1);
  const all = () => Array.from(document.querySelectorAll(".glpi-rt-toast"));
  assert.equal(all().length, 1, "the same notification once");
  assert.match(all()[0].querySelector(".toast-body")?.textContent ?? "", /Bob.*#42/);
  assert.equal(all()[0].querySelector("a")?.getAttribute("href"), "/glpi/front/ticket.form.php?id=42");

  toasts.show({ ...n, nid: "n2", room: "Ticket:43" } as any, 1);
  all()[1].querySelector<HTMLElement>(".btn-close")!.click();
  assert.equal(all().length, 1, "closed by hand");
  t.mock.timers.tick(15_000);
  assert.equal(all().length, 0, "gone after the delay");
});

test("toasts: no link for a room that is not an item", () => {
  const document = itemPage();
  new Toasts(document, "").show({ nid: "x", kind: "inbox", room: "", by: BOB, alert: true } as any, 1);
  assert.equal(document.querySelector(".glpi-rt-toast a") === null, true);
});
