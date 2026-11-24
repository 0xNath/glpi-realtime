
import { closeAnswer, expect, items, login, openAnswer, openItem, openTicketAsAllowed, room, test, ticketId, typeAnswer, waitForFrame } from "./helpers.ts";

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
  const placeholder = bob.page.locator(".itil-timeline > .glpi-rt-composing:not(.glpi-rt-draft-left)");
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

test("a draft left by a closed tab can be taken over, with its text", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

  await openAnswer(alice.page, "ITILFollowup");
  const draft = `reprise e2e ${Date.now()}`;
  await typeAnswer(alice.page, "ITILFollowup", draft);
  await expect(bob.page.locator(".itil-timeline > .glpi-rt-composing:not(.glpi-rt-draft-left)")).toContainText(/alice/i);
  await alice.page.waitForTimeout(1500); // the draft is shared as she types (debounced)

  // Alice's tab goes: Bob may take the draft over, into his own followup form.
  await alice.context.close();
  const left = bob.page.locator(".itil-timeline > .glpi-rt-draft-left[data-kind='followup']");
  await left.getByRole("button", { name: /take over|prendre la suite/i }).click();
  await expect
    .poll(() => bob.page.evaluate(() => {
      const area = document.querySelector<HTMLTextAreaElement>("#new-ITILFollowup-block textarea[name='content']");
      try {
        return area ? ((window as any).tinymce?.get(area.id)?.getContent() ?? "") : "";
      } catch {
        return ""; // editor not initialized yet
      }
    }))
    .toContain(draft);
  await closeAnswer(bob.page, "ITILFollowup");
});

test("GLPI refuses a second solution, whatever the browser does", async ({ browser }) => {
  test.skip(!items.solutionTicket, "RT_SOLUTION_TICKET_ID is not set (a ticket rt-alice and rt-bob may solve, which the test solves)");
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  expect(await openItem(alice, "Ticket", items.solutionTicket)).toBe(200);
  expect(await openItem(bob, "Ticket", items.solutionTicket)).toBe(200);
  // Bob's page is loaded before Alice's solution exists. (Had he opened his solution form
  // first, Alice's would be locked: one solution is written at a time.)
  await openAnswer(alice.page, "ITILSolution");
  await typeAnswer(alice.page, "ITILSolution", `solution e2e ${Date.now()}`);
  // GLPI 12 saves it without reloading the page; GLPI 11 reloads it.
  await alice.page.locator("#new-ITILSolution-block button[type=submit][name=add]").click();
  await expect(alice.page.locator(".itil-timeline")).toContainText("solution e2e", { timeout: 20_000 });

  // Bob's page now says the solution is taken, and blocks his: he sends it anyway, as a
  // browser without the real-time client would, from his old page.
  await openAnswer(bob.page, "ITILSolution");
  await typeAnswer(bob.page, "ITILSolution", "second solution e2e");
  const answer = await bob.page.evaluate(async () => {
    const form = document.querySelector<HTMLFormElement>("#new-ITILSolution-block form")!;
    (window as any).tinymce?.triggerSave?.();
    const body = new FormData(form);
    body.set("add", "1");
    const resp = await fetch(form.action, { method: "POST", body, credentials: "same-origin" });
    return resp.text(); // after GLPI's redirect: the page with its message
  });
  expect(answer).toMatch(/already been proposed|déjà été proposée/i);
  await bob.page.reload();
  await expect(bob.page.locator(".itil-timeline")).not.toContainText("second solution e2e");
});
