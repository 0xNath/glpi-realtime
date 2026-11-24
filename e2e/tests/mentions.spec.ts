import { expect, login, openAnswer, openTicketAsAllowed, room, test, ticketId, waitForFrame } from "./helpers.ts";

test("a mention in a followup notifies the mentioned user at once", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  const aliceId = (await waitForFrame(alice, (f) => f.t === "hello", "hello")).user.id;
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

  // Bob writes "@rt-alice" (GLPI's mention markup, as its editor inserts it) and adds it.
  await openAnswer(bob.page, "ITILFollowup");
  const text = `mention e2e ${Date.now()}`;
  await expect.poll(() => bob.page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>("#new-ITILFollowup-block textarea[name='content']");
    return !!(area && (window as any).tinymce?.get(area.id)?.initialized);
  })).toBe(true);
  await bob.page.evaluate(({ uid, text }) => {
    const area = document.querySelector<HTMLTextAreaElement>("#new-ITILFollowup-block textarea[name='content']")!;
    (window as any).tinymce.get(area.id).setContent(`<p><span data-user-mention="true" data-user-id="${uid}">@rt-alice</span> ${text}</p>`);
  }, { uid: aliceId, text });
  await bob.page.locator("#new-ITILFollowup-block button[type=submit][name=add]").click();
  await expect(bob.page.locator(".itil-timeline")).toContainText(text, { timeout: 20_000 });

  // Alice, elsewhere in GLPI, is told live: her bell rings, the notification says why.
  await waitForFrame(alice, (f) => f.t === "notification" && JSON.stringify(f).includes("mentioned"), "notification");
  await alice.page.locator(".glpi-rt-bell-button").click();
  const row = alice.page.locator(`.glpi-rt-bell-panel .glpi-rt-n[data-key="Ticket:${ticketId}"]`);
  await expect(row).toContainText(/mentioned in a followup|mentionné dans un suivi/i);
});
