import { expect, test } from "@playwright/test";

import { login, openTicketAsAllowed, room, ticketId, waitForFrame } from "./helpers.ts";

const banner = `.glpi-rt-updates[data-room="${room}"]`;

/**
 * Posts a public followup with GLPI's own timeline form (same fields, same CSRF token),
 * without going through the rich-text editor. Leaves a followup on the test ticket.
 */
async function addFollowup(page: import("@playwright/test").Page, text: string): Promise<number> {
  return page.evaluate(
    async ({ text, ticketId }) => {
      const form = document.querySelector<HTMLFormElement>("form[action*='itilfollowup.form.php']");
      if (!form) throw new Error("no followup form on the ticket page");
      const data = new FormData(form);
      data.set("itemtype", "Ticket");
      data.set("items_id", String(ticketId));
      data.set("content", text);
      data.set("is_private", "0");
      data.set("add", "1");
      const resp = await fetch(form.action, { method: "POST", body: data, credentials: "same-origin" });
      return resp.status;
    },
    { text, ticketId },
  );
}

test("a followup added by one technician is announced to the other, without content", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");
  await expect(bob.page.locator(banner)).toHaveCount(0);

  const secret = `e2e followup ${Date.now()}`;
  expect(await addFollowup(alice.page, secret)).toBeLessThan(400);

  const ev = await waitForFrame(bob, (f) => f.t === "event" && f.kind === "followup.add", "followup.add");
  expect(ev.by.name).toMatch(/alice/i);
  expect(ev.item.type).toBe("ITILFollowup");
  expect(JSON.stringify(bob.frames)).not.toContain(secret); // no content in transit

  await expect(bob.page.locator(banner)).toBeVisible();
  await expect(bob.page.locator(`${banner} .glpi-rt-updates-text`)).toContainText(/alice/i);
  // Refresh shows the followup, loaded by GLPI.
  await Promise.all([bob.page.waitForEvent("load"), bob.page.locator(`${banner} .glpi-rt-refresh`).click()]);
  await expect(bob.page.locator("body")).toContainText(secret);

  await alice.context.close();
  await bob.context.close();
});
