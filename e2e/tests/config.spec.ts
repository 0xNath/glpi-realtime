import { expect, test } from "@playwright/test";

import { login } from "./helpers.ts";

/** Every check of the plugin's configuration page: [status, label, detail and fix]. */
async function checks(page: import("@playwright/test").Page): Promise<Array<[string, string, string]>> {
  return page.evaluate(() =>
    [...document.querySelectorAll("#glpi-rt-health tr")].map((tr) => {
      const td = tr.querySelectorAll("td");
      return [td[0]?.textContent?.trim() ?? "", td[1]?.textContent?.trim() ?? "", td[2]?.textContent?.trim() ?? ""] as [string, string, string];
    }),
  );
}

test("the configuration page finds everything in order", async ({ browser }) => {
  // rt-bob may change GLPI's configuration (Setup > Plugins).
  const bob = await login(browser, "bob");
  const resp = await bob.page.goto("/plugins/realtime/front/config.php");
  expect(resp?.status(), "rt-bob must be allowed to change GLPI's configuration").toBe(200);
  await expect(bob.page.locator("#glpi-rt-health h1")).toBeVisible();

  // The browser checks (/ws location, WebSocket) replace the "Checking…" row.
  const browserRows = bob.page.locator("#glpi-rt-browser-checks tr");
  await expect(browserRows).toHaveCount(2, { timeout: 15_000 });

  const rows = await checks(bob.page);
  console.log(rows.map((r) => r.join(" | ")).join("\n"));
  const failing = rows.filter(([status]) => /erreur|error/i.test(status));
  expect(failing, "no check in error").toEqual([]);
  await bob.context.close();
});

test("the page is for administrators only", async ({ browser }) => {
  const carol = await login(browser, "carol");
  const resp = await carol.page.goto("/plugins/realtime/front/config.php");
  expect(resp?.status()).not.toBe(200);
  await carol.context.close();
});
