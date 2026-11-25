import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, items, login, openAnswer, openItem, openTicketAsAllowed, room, test, waitForFrame } from "./helpers.ts";

/** WCAG 2.1 A and AA violations in the real-time layer's own elements (not GLPI's). */
async function violations(page: Page, selectors: string[]) {
  const present = [];
  for (const s of selectors) if ((await page.locator(s).count()) > 0) present.push(s);
  expect(present.length, `none of ${selectors.join(", ")} is on the page`).toBeGreaterThan(0);
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const s of present) builder.include(s);
  const res = await builder.analyze();
  return res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ") + " [" + (n.any[0]?.message ?? "") + "]").join("; ")}`);
}

test("accessibility: presence, fields lock, writing placeholder", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");
  await alice.page.locator("#itil-form select, #itil-form input:not([type=hidden])").first().focus();
  await openAnswer(alice.page, "ITILFollowup");
  await expect(bob.page.locator(".glpi-rt-editor")).toBeVisible();
  await expect(bob.page.locator(".itil-timeline > .glpi-rt-composing:not(.glpi-rt-draft-left)")).toBeVisible();
  expect(await violations(bob.page, [".glpi-rt-presence", ".glpi-rt-editor", ".itil-timeline > .glpi-rt-composing:not(.glpi-rt-draft-left)"])).toEqual([]);
});

test("accessibility: the bell, its list and its preferences", async ({ browser }) => {
  const alice = await login(browser, "alice");
  await alice.page.locator(".glpi-rt-bell-button").click();
  await expect(alice.page.locator(".glpi-rt-bell-panel")).toBeVisible();
  expect(await violations(alice.page, [".glpi-rt-bell"])).toEqual([]);
  await alice.page.locator(".glpi-rt-bell-panel").getByRole("button", { name: /^(preferences|préférences)$/i }).click();
  await expect(alice.page.locator(".glpi-rt-prefs")).toBeVisible();
  expect(await violations(alice.page, [".glpi-rt-prefs"])).toEqual([]);
});

test("accessibility: the configuration page's checks", async ({ browser }) => {
  const bob = await login(browser, "bob");
  await bob.page.goto("/plugins/realtime/front/config.php");
  await expect(bob.page.locator("#glpi-rt-browser-checks tr")).toHaveCount(2, { timeout: 15_000 });
  expect(await violations(bob.page, ["#glpi-rt-health"])).toEqual([]);
});

test("accessibility: the connection status, offline", async ({ browser }) => {
  const alice = await login(browser, "alice");
  await openTicketAsAllowed(alice);
  await waitForFrame(alice, (f) => f.t === "subscribed" && f.room === room, "subscribed");
  await alice.page.evaluate(() => (window as any).glpiRealtime.stop());
  await expect(alice.page.locator(".glpi-rt-presence .glpi-rt-status")).toHaveClass(/is-offline/);
  expect(await violations(alice.page, [".glpi-rt-presence"])).toEqual([]);
});

test("accessibility: the notifications page", async ({ browser }) => {
  const alice = await login(browser, "alice");
  await alice.page.goto("/plugins/realtime/front/notifications.php");
  await expect(alice.page.locator(".glpi-rt-page .glpi-rt-tabs")).toBeVisible();
  expect(await violations(alice.page, [".glpi-rt-page"])).toEqual([]);
});

test("accessibility: a list's and an item's change banners", async ({ browser }) => {
  test.skip(!items.computer, "RT_COMPUTER_ID is not set");
  const alice = await login(browser, "alice");
  const watcher = await login(browser, "carol");
  const bob = await login(browser, "bob");
  await alice.page.goto("/front/computer.php");
  const watching = await waitForFrame(alice, (f) => f.t === "watching", "watching");
  test.skip(!watching.rooms.includes(`Computer:${items.computer}`), "the computer is not on the first page of rt-alice's list");
  expect(await openItem(watcher, "Computer", items.computer)).toBe(200);
  await waitForFrame(watcher, (f) => f.t === "subscribed" && f.room === `Computer:${items.computer}`, "subscribed");
  expect(await openItem(bob, "Computer", items.computer)).toBe(200);
  const form = bob.page.locator("form").filter({ has: bob.page.locator(`input[name='id'][value='${items.computer}']`) }).filter({ has: bob.page.locator("[name='update']") });
  await form.locator("input[name='comment'], textarea[name='comment']").first().fill(`a11y e2e ${Date.now()}`);
  await Promise.all([bob.page.waitForEvent("load"), form.locator("[name='update']").first().click()]);
  await expect(alice.page.locator(".glpi-rt-list-changed")).toBeVisible();
  expect(await violations(alice.page, [".glpi-rt-list-changed"])).toEqual([]);
  await expect(watcher.page.locator(".glpi-rt-updates")).toBeVisible();
  expect(await violations(watcher.page, [".glpi-rt-updates"])).toEqual([]);
});
