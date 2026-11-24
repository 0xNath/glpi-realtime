import { execSync } from "node:child_process";

import { expect, login, openTicketAsAllowed, room, test, waitForFrame } from "./helpers.ts";

// Valkey restarts without persistence: sessions and grants are lost. Open pages recover by
// themselves: GLPI issues a new token (ajax/session.php) and grant, nobody reloads.
test("after a Valkey restart, open pages come back by themselves", async ({ browser }) => {
  const restart = process.env.E2E_VALKEY_RESTART;
  test.skip(!restart, "E2E_VALKEY_RESTART is not set (disposable environment only)");
  test.setTimeout(120_000);
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  const bobId = (await waitForFrame(bob, (f) => f.t === "hello", "hello")).user.id;
  const avatar = alice.page.locator(`.glpi-rt-presence[data-room="${room}"] .glpi-rt-avatar[data-uid="${bobId}"]`);
  await expect(avatar).toBeVisible();

  const refreshes: number[] = [];
  alice.page.on("response", (r) => r.url().includes("/plugins/realtime/ajax/session.php") && refreshes.push(r.status()));
  const hellos = () => alice.frames.filter((f) => f.t === "hello").length;
  const before = hellos();
  execSync(restart!, { stdio: "ignore" });

  // Alice's tab was told its session ended, got a new one from GLPI and is back.
  await expect.poll(hellos, { timeout: 60_000, message: "alice reconnected" }).toBeGreaterThan(before);
  await expect(avatar).toBeVisible({ timeout: 30_000 });
  expect(await alice.page.evaluate(() => (window as any).glpiRealtime?.state)).toBe("open");
  expect(refreshes, "GLPI was asked for a new token").toContain(200);
});
