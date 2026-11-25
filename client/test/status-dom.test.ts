import assert from "node:assert/strict";
import { test } from "node:test";

import { liveStatus, render, setStatus } from "../src/presence.ts";
import type { PresenceUser } from "../src/protocol.ts";
import { page } from "./dom.ts";

// The link's status in an item's presence bar, shown even when nobody else is there.

test("the client's state, per item", () => {
  assert.equal(liveStatus("open", false, true, false), "live");
  assert.equal(liveStatus("open", false, false, false), "connecting", "connected, the item not joined yet");
  assert.equal(liveStatus("connecting", false, false, false), "connecting", "first attempt");
  assert.equal(liveStatus("idle", false, false, false), "connecting");
  assert.equal(liveStatus("waiting", false, false, false), "retrying", "lost, waiting to try again");
  assert.equal(liveStatus("connecting", true, false, false), "retrying", "trying again: still lost");
  assert.equal(liveStatus("revoked", true, false, false), "offline", "GLPI must issue a new session");
  assert.equal(liveStatus("stopped", false, false, false), "offline");
  assert.equal(liveStatus("open", false, false, true), "unavailable", "refused for this item");
});

const alice: PresenceUser = { id: 2, name: "Alice Martin", since: 1, active: true } as PresenceUser;
const me: PresenceUser = { id: 1, name: "Me", since: 0, active: true } as PresenceUser;

function item(room: string, lang = "en") {
  const { document } = page(`<!doctype html><html lang="${lang}"><head></head><body><div id="navigationheader"></div></body></html>`);
  const bar = () => document.getElementById(`glpi-rt-presence-${room.replace(/[^A-Za-z0-9_-]/g, "-")}`);
  const text = () => bar()?.querySelector(".glpi-rt-label")?.textContent ?? null;
  const dot = () => bar()?.querySelector(".glpi-rt-status") ?? null;
  return { document, bar, text, dot };
}

test("alone on the item: the bar says the link is live", () => {
  const { document, bar, text, dot } = item("Ticket:1");
  setStatus(document, "Ticket:1", "live", 1);
  render(document, "Ticket:1", [me], 1);
  assert.equal(bar()?.hidden, false, "shown although nobody else is there");
  assert.equal(text(), "Live");
  assert.equal(dot()?.className, "glpi-rt-status is-live");
  assert.match(dot()?.getAttribute("aria-label") ?? "", /^Connected/);
  assert.equal(dot()?.getAttribute("title"), dot()?.getAttribute("aria-label"));
});

test("with someone else: the dot, then who is there", () => {
  const { document, bar, text, dot } = item("Ticket:2");
  setStatus(document, "Ticket:2", "live", 1);
  render(document, "Ticket:2", [me, alice], 1);
  assert.equal(text(), "Also on this ticket:");
  assert.equal(dot()?.className, "glpi-rt-status is-live");
  assert.equal(bar()?.querySelectorAll(".glpi-rt-avatar[data-uid]").length, 1);
});

test("connection lost: red, nobody shown (unknown until the server says again), back when live", () => {
  const { document, bar, text, dot } = item("Ticket:3", "fr");
  setStatus(document, "Ticket:3", "live", 1);
  render(document, "Ticket:3", [me, alice], 1);
  setStatus(document, "Ticket:3", "retrying", 1);
  assert.equal(text(), "Hors ligne");
  assert.equal(dot()?.className, "glpi-rt-status is-retrying");
  assert.match(dot()?.getAttribute("aria-label") ?? "", /nouvelle tentative/);
  assert.equal(bar()?.querySelectorAll(".glpi-rt-avatar[data-uid]").length, 0);
  setStatus(document, "Ticket:3", "offline", 1);
  assert.match(dot()?.getAttribute("aria-label") ?? "", /Rechargez la page/);
  setStatus(document, "Ticket:3", "live", 1);
  assert.equal(text(), "Également sur ce ticket :");
  assert.equal(bar()?.querySelectorAll(".glpi-rt-avatar[data-uid]").length, 1);
});

test("connecting, then unavailable for an item the server refused", () => {
  const { document, text, dot } = item("Change:4");
  setStatus(document, "Change:4", "connecting", 1);
  assert.equal(text(), "Connecting…");
  assert.equal(dot()?.className, "glpi-rt-status is-connecting");
  setStatus(document, "Change:4", "unavailable", 1);
  assert.equal(text(), "Not live");
});

test("no title bar yet: nothing drawn, drawn once it is there", () => {
  const { document } = page(`<!doctype html><html lang="en"><head></head><body></body></html>`);
  setStatus(document, "Ticket:5", "live", 1);
  assert.equal(document.querySelector(".glpi-rt-presence") === null, true);
  document.body.insertAdjacentHTML("beforeend", `<div id="navigationheader"></div>`);
  setStatus(document, "Ticket:5", "live", 1);
  assert.equal(document.querySelector(".glpi-rt-presence .glpi-rt-label")?.textContent, "Live");
});
