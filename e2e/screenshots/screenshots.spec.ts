import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { closeAnswer, expect, items, login, openAnswer, openTicketAsAllowed, room, test, typeAnswer, waitForFrame } from "../tests/helpers.ts";

const out = (name: string) => fileURLToPath(new URL(`../../docs/img/${name}.png`, import.meta.url));

/** A screenshot of the region around elements, with a margin, inside the viewport. */
async function shoot(page: Page, name: string, around: Locator[], margin = 24, minHeight = 0) {
  const boxes = (await Promise.all(around.map((l) => l.first().boundingBox()))).filter((b) => b) as { x: number; y: number; width: number; height: number }[];
  const vp = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + margin);
  const bottom = Math.min(vp.height, Math.max(Math.max(...boxes.map((b) => b.y + b.height)) + margin, y + minHeight));
  await page.mouse.move(0, vp.height - 1); // no stray hover
  await page.screenshot({ path: out(name), clip: { x, y, width: right - x, height: bottom - y } });
}

test.describe.configure({ mode: "serial" });

test("logo", async ({ page }) => {
  await page.setViewportSize({ width: 256, height: 256 });
  await page.setContent(`<body style="margin:0;background:transparent">
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="56" fill="#1d3a6e"/>
      <circle cx="96" cy="112" r="34" fill="#fec95c"/>
      <path d="M40 200c6-34 30-52 56-52s50 18 56 52z" fill="#fec95c"/>
      <circle cx="170" cy="100" r="26" fill="#9ec5fe"/>
      <path d="M126 196c4-26 22-40 44-40s40 14 44 40z" fill="#9ec5fe"/>
      <path d="M184 44a52 52 0 0 1 36 36M184 62a32 32 0 0 1 18 18" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round"/>
    </svg></body>`);
  await page.locator("svg").screenshot({ path: out("logo"), omitBackground: true });
});

test("presence, user card, fields lock, writing", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  const carol = await login(browser, "carol");
  for (const s of [alice, carol, bob]) await openTicketAsAllowed(s);
  await waitForFrame(bob, (f) => f.t === "presence" && f.room === room && f.users.length >= 3, "three people");
  const bar = bob.page.locator(`.glpi-rt-presence[data-room="${room}"]`);
  await expect(bar.locator(".glpi-rt-avatar")).toHaveCount(2);

  // Presence in the title bar, with GLPI's user card on hover.
  await bar.locator(".glpi-rt-avatar").first().hover();
  const card = bob.page.locator(".popover.glpi-rt-card");
  await expect(card.locator(".user-info-card")).toBeVisible();
  await expect(card).toHaveCSS("opacity", "1"); // fade-in done
  await bob.page.screenshot({ path: out("presence"), clip: { x: 0, y: 0, width: 1360, height: 420 } });

  // Alice edits the fields: Bob's are read-only, with who edits.
  await alice.page.locator("#itil-form select, #itil-form input:not([type=hidden])").first().focus();
  await expect(bob.page.locator(".glpi-rt-editor")).toContainText(/alice/i);
  await bob.page.mouse.move(0, 819);
  await expect(card).toHaveCount(0); // the user card is gone
  await shoot(bob.page, "fields-lock", [bob.page.locator(".glpi-rt-editor"), bob.page.locator(".itil-timeline")], 16);

  // Carol writes a followup; Bob follows the draft live.
  await openAnswer(carol.page, "ITILFollowup");
  await typeAnswer(carol.page, "ITILFollowup", "The printer on the 2nd floor is back online; I am checking the print queue now.");
  const placeholder = bob.page.locator(".itil-timeline > .glpi-rt-composing:not(.glpi-rt-draft-left)");
  await expect(placeholder).toContainText(/carol/i);
  await placeholder.getByRole("button", { name: /join|rejoindre/i }).click();
  await expect(placeholder.locator("iframe[sandbox]")).toHaveAttribute("srcdoc", /printer/);
  await placeholder.scrollIntoViewIfNeeded();
  await shoot(bob.page, "draft", [placeholder], 24);
  await closeAnswer(carol.page, "ITILFollowup"); // ends the shared draft: the tests start clean
});

test("bell, with a mention", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  const aliceId = (await waitForFrame(alice, (f) => f.t === "hello", "hello")).user.id;
  // Bob mentions Alice in a followup.
  await openTicketAsAllowed(bob);
  await openAnswer(bob.page, "ITILFollowup");
  await expect.poll(() => bob.page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>("#new-ITILFollowup-block textarea[name='content']");
    return !!(area && (window as any).tinymce?.get(area.id)?.initialized);
  })).toBe(true);
  await bob.page.evaluate((uid) => {
    const area = document.querySelector<HTMLTextAreaElement>("#new-ITILFollowup-block textarea[name='content']")!;
    (window as any).tinymce.get(area.id).setContent(`<p><span data-user-mention="true" data-user-id="${uid}">@Alice Martin</span> could you check the toner?</p>`);
  }, aliceId);
  await bob.page.locator("#new-ITILFollowup-block button[type=submit][name=add]").click();
  await waitForFrame(alice, (f) => f.t === "notification" && JSON.stringify(f).includes("mentioned"), "the mention");
  await alice.page.locator(".glpi-rt-bell-button").click();
  const panel = alice.page.locator(".glpi-rt-bell-panel");
  await expect(panel.locator(".glpi-rt-n").first()).toContainText(/mentioned|mentionné/i);
  await shoot(alice.page, "bell", [panel, alice.page.locator(".glpi-rt-bell-button")], 24);
});

test("asset: presence and the single editor", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  const id = items.computer;
  for (const s of [alice, bob]) await s.page.goto(`/front/computer.form.php?id=${id}`);
  await waitForFrame(alice, (f) => f.t === "presence" && f.room === `Computer:${id}` && f.users.length >= 2, "both");
  const form = bob.page.locator("form").filter({ has: bob.page.locator(`input[name='id'][value='${id}']`) }).filter({ has: bob.page.locator("[name='update']") });
  await form.locator("input[name='name']").focus();
  await expect(alice.page.locator(".glpi-rt-editor")).toContainText(/bob/i);
  await alice.page.mouse.move(0, 819);
  await alice.page.screenshot({ path: out("asset"), clip: { x: 0, y: 0, width: 1360, height: 520 } });
});

test("list", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(bob);
  await waitForFrame(bob, (f) => f.t === "subscribed" && f.room === room, "subscribed");
  await alice.page.goto("/front/ticket.php");
  const mini = alice.page.locator(".glpi-rt-row-presence .glpi-rt-mini").first();
  await expect(mini).toBeVisible();
  await shoot(alice.page, "list", [alice.page.locator("table.search-results")], 16);
});

test("configuration page", async ({ browser }) => {
  const bob = await login(browser, "bob");
  await bob.page.setViewportSize({ width: 1360, height: 1400 });
  await bob.page.goto("/plugins/realtime/front/config.php");
  await expect(bob.page.locator("#glpi-rt-browser-checks tr")).toHaveCount(2, { timeout: 15_000 });
  // Not an element screenshot: it scrolls, and GLPI's sticky header would cover the title.
  const box = (await bob.page.locator("#glpi-rt-health").boundingBox())!;
  await bob.page.screenshot({ path: out("checks"), clip: { x: box.x, y: box.y - 8, width: box.width, height: box.height + 8 }, fullPage: true });
});
