import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, login, openAnswer, openTicketAsAllowed, room, test, waitForFrame } from "./helpers.ts";

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
