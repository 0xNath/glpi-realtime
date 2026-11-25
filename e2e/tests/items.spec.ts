import type { Page } from "@playwright/test";

import { expect, items, login, openItem, test, waitForFrame } from "./helpers.ts";

/** The form that saves the item (its `id` field and a Save button), as the client finds it. */
function itemForm(page: Page, id: number) {
  return page.locator("form").filter({ has: page.locator(`input[name='id'][value='${id}']`) }).filter({ has: page.locator("[name='update']") });
}

// Projects, project tasks and assets: presence and the single editor of their form.
for (const [itemtype, key] of [["Computer", "computer"], ["Project", "project"], ["ProjectTask", "projectTask"]] as const) {
  test(`${itemtype}: presence and the single editor of its form`, async ({ browser }) => {
    const id = items[key];
    test.skip(!id, `RT_${key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}_ID is not set`);
    const room = `${itemtype}:${id}`;
    const alice = await login(browser, "alice");
    const bob = await login(browser, "bob");
    expect(await openItem(alice, itemtype, id), `rt-alice must be able to open ${room}`).toBe(200);
    expect(await openItem(bob, itemtype, id), `rt-bob must be able to open ${room}`).toBe(200);
    await waitForFrame(alice, (f) => f.t === "subscribed" && f.room === room, "subscribed");

    const hello = await waitForFrame(bob, (f) => f.t === "hello", "hello");
    await expect(alice.page.locator(`.glpi-rt-presence[data-room="${room}"] .glpi-rt-avatar[data-uid="${hello.user.id}"]`)).toBeVisible();

    // Bob edits: Alice's form is read-only, and says who edits.
    await itemForm(bob.page, id).locator("input[name='name']").focus();
    await waitForFrame(alice, (f) => f.t === "lock" && f.room === room && /bob/i.test(f.holder?.name ?? ""), "lock");
    await expect(alice.page.locator(".glpi-rt-editor")).toContainText(/bob/i);
    await expect(itemForm(alice.page, id).locator("[name='update']").first()).toBeDisabled();
    await expect(itemForm(alice.page, id).locator("input[name='name']")).toBeDisabled();

    // Bob saves: Alice's form is outdated, she is told to refresh.
    const name = `glpi-realtime e2e ${itemtype} ${Date.now()}`;
    await itemForm(bob.page, id).locator("input[name='name']").fill(name);
    await Promise.all([bob.page.waitForEvent("load"), itemForm(bob.page, id).locator("[name='update']").first().click()]);
    await expect(alice.page.locator(".glpi-rt-editor")).toContainText(/refresh|actualis/i);
    await alice.page.reload();
    await expect(itemForm(alice.page, id).locator("input[name='name']")).toHaveValue(name);
  });
}

test("GLPI refuses to save an asset's form older than the asset", async ({ browser }) => {
  test.skip(!items.computer, "RT_COMPUTER_ID is not set");
  const bob = await login(browser, "bob");
  const old = await browser.newPage({ storageState: await bob.context.storageState() });
  expect(await openItem(bob, "Computer", items.computer)).toBe(200);
  await old.goto(`/front/computer.form.php?id=${items.computer}`);
  // Saved meanwhile from another tab.
  await itemForm(bob.page, items.computer).locator("input[name='comment'], textarea[name='comment']").first().fill(`changed ${Date.now()}`);
  await Promise.all([bob.page.waitForEvent("load"), itemForm(bob.page, items.computer).locator("[name='update']").first().click()]);
  // The old page sends its form anyway (as a browser without the real-time client would).
  const html = await old.evaluate(async (id) => {
    const form = [...document.querySelectorAll("form")].find((f) => f.querySelector(`input[name='id'][value='${id}']`) && f.querySelector("[name='update']"))!;
    const body = new FormData(form);
    body.set("update", "1");
    return (await fetch(form.action, { method: "POST", body, credentials: "same-origin" })).text();
  }, items.computer);
  expect(html).toMatch(/changed this item while you were editing it|a modifié cet élément pendant que vous l'éditiez/i);
  await old.close();
});

test("the asset list shows who is on each asset", async ({ browser }) => {
  test.skip(!items.computer, "RT_COMPUTER_ID is not set");
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  expect(await openItem(bob, "Computer", items.computer)).toBe(200);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === `Computer:${items.computer}`, "subscribed");
  await alice.page.goto("/front/computer.php");
  const watching = await waitForFrame(alice, (f) => f.t === "watching", "watching");
  test.skip(!watching.rooms.includes(`Computer:${items.computer}`), "the computer is not on the first page of rt-alice's list");
  await expect(alice.page.locator(".glpi-rt-row-presence .glpi-rt-mini[title*='bob' i]")).toBeVisible();
});

test("a list marks the rows someone else changed, and offers to refresh", async ({ browser }) => {
  test.skip(!items.computer, "RT_COMPUTER_ID is not set");
  const room = `Computer:${items.computer}`;
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await alice.page.goto("/front/computer.php");
  const watching = await waitForFrame(alice, (f) => f.t === "watching", "watching");
  test.skip(!watching.rooms.includes(room), "the computer is not on the first page of rt-alice's list");
  await expect(alice.page.locator(".glpi-rt-list-changed")).toHaveCount(0);

  // Bob saves the computer.
  expect(await openItem(bob, "Computer", items.computer)).toBe(200);
  await itemForm(bob.page, items.computer).locator("input[name='comment'], textarea[name='comment']").first().fill(`list e2e ${Date.now()}`);
  await Promise.all([bob.page.waitForEvent("load"), itemForm(bob.page, items.computer).locator("[name='update']").first().click()]);

  // Alice's list says so: the frame carries nothing but the item.
  const changed = await waitForFrame(alice, (f) => f.t === "changed" && f.room === room, "changed");
  expect(Object.keys(changed).sort()).toEqual(["room", "t", "v"]);
  const row = alice.page.locator(`tr:has(input[name='item[Computer][${items.computer}]'])`);
  await expect(row).toHaveClass(/glpi-rt-row-changed/);
  const banner = alice.page.locator(".glpi-rt-list-changed");
  await expect(banner).toContainText(/Items changed in this list: 1|Éléments modifiés dans cette liste : 1/);
  await Promise.all([alice.page.waitForEvent("load"), banner.getByRole("button", { name: /^(refresh|actualiser)$/i }).click()]);
  await expect(alice.page.locator(".glpi-rt-list-changed")).toHaveCount(0);
});
