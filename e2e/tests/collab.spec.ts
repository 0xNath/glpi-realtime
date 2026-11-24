import { expect, type Page, test } from "@playwright/test";

import { login, openTicketAsAllowed, room, ticketId, waitForFrame } from "./helpers.ts";

/** Opens one of GLPI's answer forms (followup, solution...) and waits for its editor. */
async function openAnswer(page: Page, cls: string): Promise<void> {
  await page.evaluate((cls) => {
    const block = document.getElementById(`new-${cls}-block`);
    if (!block) throw new Error(`no ${cls} answer form`);
    (window as any).bootstrap.Collapse.getOrCreateInstance(block, { toggle: false }).show();
  }, cls);
  await expect(page.locator(`#new-${cls}-block textarea[name='content']`)).toBeAttached();
}

async function closeAnswer(page: Page, cls: string): Promise<void> {
  await page.evaluate((cls) => {
    (window as any).bootstrap.Collapse.getOrCreateInstance(document.getElementById(`new-${cls}-block`)!).hide();
  }, cls);
}

/** Types into the TinyMCE editor of an answer form. */
async function typeAnswer(page: Page, cls: string, text: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((cls) => {
      const area = document.querySelector<HTMLTextAreaElement>(`#new-${cls}-block textarea[name='content']`);
      return !!(area && (window as any).tinymce?.get(area.id));
    }, cls))
    .toBe(true);
  await page.evaluate(({ cls, text }) => {
    const area = document.querySelector<HTMLTextAreaElement>(`#new-${cls}-block textarea[name='content']`)!;
    const ed = (window as any).tinymce.get(area.id);
    ed.setContent(`<p>${text}</p>`);
    ed.fire("input");
  }, { cls, text });
}

test("while one technician edits the fields, the other's are read-only", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

  // Alice starts editing a field of the fields panel.
  await alice.page.locator("#itil-form select, #itil-form input:not([type=hidden])").first().focus();
  await waitForFrame(bob, (f) => f.t === "lock" && f.scope === "fields" && /alice/i.test(f.holder?.name ?? ""), "fields lock");
  await expect(bob.page.locator(".glpi-rt-editor")).toContainText(/alice/i);
  await expect(bob.page.locator("button[name='update'][form='itil-form']")).toBeDisabled();

  // Alice closes her tab: the lock goes, Bob may edit.
  await alice.context.close();
  await expect(bob.page.locator("button[name='update'][form='itil-form']")).toBeEnabled();
  await bob.context.close();
});

test("who is writing shows in the timeline, and the draft can be followed live", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

  await openAnswer(alice.page, "ITILFollowup");
  const placeholder = bob.page.locator(".itil-timeline > .glpi-rt-composing");
  await expect(placeholder).toContainText(/alice/i);

  const draft = `brouillon e2e ${Date.now()}`;
  await typeAnswer(alice.page, "ITILFollowup", draft);
  await placeholder.getByRole("button", { name: /rejoindre|join/i }).click();
  const frame = placeholder.locator("iframe[sandbox]");
  await expect(frame).toHaveAttribute("srcdoc", new RegExp(draft));
  await expect(frame).toHaveAttribute("sandbox", ""); // no script in the draft can run

  await closeAnswer(alice.page, "ITILFollowup");
  await expect(placeholder).toHaveCount(0);
  await alice.context.close();
  await bob.context.close();
});

test("a solution cannot be written while someone edits the fields", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

  await alice.page.locator("#itil-form select, #itil-form input:not([type=hidden])").first().focus();
  await waitForFrame(bob, (f) => f.t === "lock" && f.scope === "fields" && !!f.holder, "fields lock");
  const solution = bob.page.locator("[data-bs-target='#new-ITILSolution-block']:not(#new-ITILSolution-block *)").first();
  if ((await solution.count()) === 0) test.skip(true, "rt-bob cannot solve the test ticket");
  await expect(solution).toHaveAttribute("aria-disabled", "true");
  await alice.context.close();
  await bob.context.close();
});

test("the ticket list shows who is on each ticket", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

  await alice.page.goto("/front/ticket.php");
  await waitForFrame(alice, (f) => f.t === "watching", "watching");
  const watching = alice.frames.find((f) => f.t === "watching")!;
  test.skip(!watching.rooms.includes(room), `ticket ${ticketId} is not on the first page of rt-alice's list`);
  await expect(alice.page.locator(".glpi-rt-row-presence .glpi-rt-mini[title*='bob' i]")).toBeVisible();
  // Looking at the list does not put Alice on the ticket.
  await bob.page.waitForTimeout(1000);
  const last = [...bob.frames].reverse().find((f) => f.t === "presence" && f.room === room);
  expect(last.users.some((u: any) => /alice/i.test(u.name))).toBe(false);
  await alice.context.close();
  await bob.context.close();
});
