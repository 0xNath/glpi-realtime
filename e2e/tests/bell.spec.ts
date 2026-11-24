import type { Page } from "@playwright/test";

import { expect, items, login, test, waitForFrame } from "./helpers.ts";

/** Opens the bell, with read notifications shown too (they stay listed once read). */
async function openBell(page: Page) {
  await page.locator(".glpi-rt-bell-button").click();
  const panel = page.locator(".glpi-rt-bell-panel");
  await expect(panel).toBeVisible();
  const showRead = panel.locator(".glpi-rt-bell-foot input[type=checkbox]");
  if (!(await showRead.isChecked())) await showRead.check();
  return panel;
}

/** The answer of the plugin endpoint a click sends (its POST, GLPI 11's CSRF token included). */
async function posted(page: Page, endpoint: string, click: () => Promise<void>) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/plugins/realtime/ajax/${endpoint}`)),
    click(),
  ]);
  expect(resp.status(), `${endpoint}: HTTP ${resp.status()}`).toBe(200);
  return resp.json();
}

test("a notification can be marked read and unread", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const panel = await openBell(alice.page);
  // Any notification (opening an item reads its notifications: other tests do).
  await expect(panel.locator(".glpi-rt-n, .glpi-rt-empty").first()).toBeVisible();
  if ((await panel.locator(".glpi-rt-n").count()) === 0) test.skip(true, "rt-alice has no notification");
  const key = await panel.locator(".glpi-rt-n").first().getAttribute("data-key");
  const row = panel.locator(`.glpi-rt-n[data-key="${key}"]`);
  const read = row.getByRole("button", { name: /^(mark as read|marquer comme lu)$/i });
  const unread = row.getByRole("button", { name: /^(mark as unread|marquer comme non lu)$/i });

  const wasUnread = await row.evaluate((el) => el.classList.contains("is-unread"));
  if (!wasUnread) await posted(alice.page, "inbox.php", () => unread.click());
  await expect(row).toHaveClass(/is-unread/);
  await posted(alice.page, "inbox.php", () => read.click());
  await expect(row).not.toHaveClass(/is-unread/);
  if (wasUnread) await posted(alice.page, "inbox.php", () => unread.click());
  await expect(row).toHaveClass(wasUnread ? /is-unread/ : /^(?!.*is-unread)/);
});

test("notification preferences are saved", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const toggle = async (expected?: boolean) => {
    const panel = await openBell(alice.page);
    await panel.getByRole("button", { name: /^(preferences|préférences)$/i }).click();
    const form = alice.page.locator(".glpi-rt-prefs");
    const box = form.locator("input[name='sound_ended']");
    const before = await box.isChecked();
    if (expected !== undefined) expect(before, "the saved value is shown").toBe(expected);
    await box.setChecked(!before);
    await posted(alice.page, "preferences.php", () => form.getByRole("button", { name: /^(save|enregistrer)$/i }).click());
    return !before;
  };
  const saved = await toggle();
  await alice.page.reload();
  await toggle(saved); // and back to how it was
});

test("assume: a technician assigns themselves an unassigned ticket from the bell", async ({ browser }) => {
  test.skip(!items.assignTicket, "RT_ASSIGN_TICKET_ID is not set (an unassigned ticket rt-alice may take)");
  const alice = await login(browser, "alice");
  // The test assigns the ticket for good: on an environment where it already ran, there is
  // nothing left to test (a fresh one, as in the CI, always runs it).
  const aliceId = (await waitForFrame(alice, (f) => f.t === "hello", "hello")).user.id;
  await alice.page.goto(`/front/ticket.form.php?id=${items.assignTicket}`);
  const assigned = alice.page.locator("select[data-actor-type='assign']");
  await expect(assigned).toBeAttached();
  test.skip(await assigned.locator(`option[value='User_${aliceId}']`).count() > 0, "already assigned to rt-alice by an earlier run in this environment");
  const panel = await openBell(alice.page);
  const row = panel.locator(`.glpi-rt-n[data-key="Ticket:${items.assignTicket}"]`);
  await expect(row).toBeVisible();
  const res = await posted(alice.page, "assign.php", () => row.getByRole("button", { name: /^(assume|prendre en charge)$/i }).click());
  expect(res.ok, res.message).toBe(true);
  await alice.page.goto(`/front/ticket.form.php?id=${items.assignTicket}`);
  await expect(alice.page.locator("#itil-form")).toContainText(/alice/i); // her login or her name
});
