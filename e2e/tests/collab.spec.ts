import { expect, test } from "@playwright/test";

import { closeAnswer, login, openAnswer, openTicketAsAllowed, room, ticketId, typeAnswer, waitForFrame } from "./helpers.ts";

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

  // Real people may be on the test ticket too (an rt-alice tab left open...): compare.
  await bob.page.waitForTimeout(1000);
  const before = [...bob.frames].reverse().find((f) => f.t === "presence" && f.room === room)?.users.length ?? 0;
  await alice.page.goto("/front/ticket.php");
  await waitForFrame(alice, (f) => f.t === "watching", "watching");
  const watching = alice.frames.find((f) => f.t === "watching")!;
  test.skip(!watching.rooms.includes(room), `ticket ${ticketId} is not on the first page of rt-alice's list`);
  await expect(alice.page.locator(".glpi-rt-row-presence .glpi-rt-mini[title*='bob' i]")).toBeVisible();
  // Looking at the list does not put Alice on the ticket.
  await bob.page.waitForTimeout(1000);
  const last = [...bob.frames].reverse().find((f) => f.t === "presence" && f.room === room);
  expect(last.users.length, "nobody added by looking at the list").toBe(before);
  await alice.context.close();
  await bob.context.close();
});
