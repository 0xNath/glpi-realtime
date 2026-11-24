import { expect, items, login, openItem, test, waitForFrame } from "./helpers.ts";

// Changes and problems have the features of tickets.
for (const itemtype of ["Change", "Problem"] as const) {
  const id = itemtype === "Change" ? items.change : items.problem;
  const room = `${itemtype}:${id}`;

  test(`${itemtype}: presence and the fields lock`, async ({ browser }) => {
    test.skip(!id, `RT_${itemtype.toUpperCase()}_ID is not set`);
    const alice = await login(browser, "alice");
    const bob = await login(browser, "bob");
    expect(await openItem(alice, itemtype, id), `rt-alice must be able to open ${room}`).toBe(200);
    expect(await openItem(bob, itemtype, id), `rt-bob must be able to open ${room}`).toBe(200);
    await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");

    const hello = await waitForFrame(bob, (f) => f.t === "hello", "hello");
    await expect(alice.page.locator(`.glpi-rt-presence[data-room="${room}"] .glpi-rt-avatar[data-uid="${hello.user.id}"]`)).toBeVisible();

    await alice.page.locator("#itil-form select, #itil-form input:not([type=hidden])").first().focus();
    await waitForFrame(bob, (f) => f.t === "lock" && f.room === room && f.scope === "fields" && /alice/i.test(f.holder?.name ?? ""), "fields lock");
    await expect(bob.page.locator(".glpi-rt-editor")).toContainText(/alice/i);
    await expect(bob.page.locator("button[name='update'][form='itil-form']")).toBeDisabled();
  });
}
