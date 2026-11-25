import type { Page } from "@playwright/test";

import {
  expect,
  focusedPage,
  login,
  openTicket,
  openTicketAsAllowed,
  room,
  type Session,
  setTabVisible,
  test,
  useProfile,
  waitForFrame,
} from "./helpers.ts";

// Real users may be on the test ticket too: assertions only look at the test accounts.
const bar = `.glpi-rt-presence[data-room="${room}"]`;

async function uid(s: Session): Promise<number> {
  const hello = await waitForFrame(s, (f) => f.t === "hello", "hello");
  return hello.user.id;
}

function avatar(page: Page, id: number) {
  return page.locator(`${bar} .glpi-rt-avatar[data-uid="${id}"]`);
}

test("technicians on the same ticket see each other, never themselves", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  const aliceId = await uid(alice);
  await waitForFrame(alice, (f) => f.t === "presence", "presence");
  await expect(avatar(alice.page, aliceId)).toHaveCount(0); // never oneself

  await openTicketAsAllowed(bob);
  const bobId = await uid(bob);
  await expect(avatar(alice.page, bobId)).toBeVisible();
  await expect(avatar(alice.page, bobId)).toHaveAttribute("aria-label", /bob/i);
  await expect(avatar(bob.page, aliceId)).toBeVisible();
  await expect(avatar(bob.page, bobId)).toHaveCount(0);
  // The bar sits in GLPI's title bar.
  await expect(alice.page.locator(`#navigationheader ${bar}`)).toHaveCount(1);

  // A second tab of Bob does not add a second avatar.
  const bobTab2 = await focusedPage(bob.context);
  await bobTab2.goto(`/front/ticket.form.php?id=${room.split(":")[1]}`);
  await expect(bobTab2.locator(bar)).toBeAttached();
  await alice.page.waitForTimeout(1000);
  await expect(avatar(alice.page, bobId)).toHaveCount(1);

  // Bob closes one tab: still there. Closes the last one: gone for Alice.
  await bob.page.close();
  await alice.page.waitForTimeout(1000);
  await expect(avatar(alice.page, bobId)).toHaveCount(1);
  await bobTab2.close();
  await expect(avatar(alice.page, bobId)).toHaveCount(0);

  await alice.context.close();
  await bob.context.close();
});

test("a user without access to the ticket never appears", async ({ browser }) => {
  const alice = await login(browser, "alice");
  await openTicketAsAllowed(alice);
  await waitForFrame(alice, (f) => f.t === "presence", "presence");

  const carol = await login(browser, "carol");
  await useProfile(carol, "Self-Service");
  const carolId = await uid(carol);
  expect(await openTicket(carol)).not.toBe(200);
  await carol.page.evaluate((r) => (window as any).glpiRealtime.subscribe(r), room);
  await waitForFrame(carol, (f) => f.t === "error" && f.code === "forbidden", "forbidden");

  await alice.page.waitForTimeout(1500);
  await expect(avatar(alice.page, carolId)).toHaveCount(0);
  expect(alice.frames.some((f) => f.t === "presence" && f.users.some((u: any) => u.id === carolId))).toBe(false);
  expect(carol.frames.some((f) => f.t === "presence" && f.room === room)).toBe(false);

  await alice.context.close();
  await carol.context.close();
});

test("the ring shows whether the other user is active on their tab", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  const bobId = await uid(bob);
  const bobAvatar = avatar(alice.page, bobId);

  await expect(bobAvatar).toHaveAttribute("data-active", "true");
  await expect(bobAvatar).toHaveClass(/is-active/);
  await expect(bobAvatar).toHaveAttribute("aria-label", /bob.*(actif|active)/i);

  // Bob switches to another tab: grey ring for Alice (after the 1 s settle delay).
  await setTabVisible(bob.page, false);
  await expect(bobAvatar).toHaveAttribute("data-active", "false");
  await expect(bobAvatar).toHaveClass(/is-inactive/);
  await expect(bobAvatar).toHaveAttribute("aria-label", /(inactif|inactive)/i);

  // Back to the ticket: green again.
  await setTabVisible(bob.page, true);
  await expect(bobAvatar).toHaveAttribute("data-active", "true");

  await alice.context.close();
  await bob.context.close();
});

test("avatars are GLPI's, and hovering one shows GLPI's user card", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);
  const bobId = await uid(bob);
  const inPresence = avatar(alice.page, bobId);
  await expect(inPresence).toBeVisible();

  // Same avatar as the one GLPI draws for Bob in his own header.
  const glpiAvatar = bob.page.locator("header .avatar").first();
  const glpi = await glpiAvatar.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { text: el.textContent!.trim(), bg: cs.backgroundColor, image: cs.backgroundImage };
  });
  const ours = await inPresence.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { text: el.textContent!.trim(), bg: cs.backgroundColor, image: cs.backgroundImage };
  });
  if (glpi.image && glpi.image !== "none") {
    expect(ours.image).toBe(glpi.image); // profile picture
  } else {
    expect(ours).toEqual({ text: glpi.text, bg: glpi.bg, image: "none" }); // initials on GLPI's color
  }

  // Hover: GLPI's user card, below the avatar, kept open while hovered.
  const page = alice.page;
  const popover = page.locator(".popover.glpi-rt-card");
  const card = popover.locator(".user-info-card");
  // A point away from both the avatar and the card, where nothing keeps the card open.
  const away = async () => {
    const boxes = [await inPresence.boundingBox()];
    if ((await popover.count()) > 0) boxes.push(await popover.first().boundingBox());
    boxes.splice(0, boxes.length, ...boxes.filter((b) => b));
    const vp = page.viewportSize()!;
    const candidates = [
      { x: 5, y: vp.height - 5 },
      { x: vp.width - 5, y: vp.height - 5 },
      { x: 5, y: vp.height / 2 },
    ];
    const free = candidates.find((p) => boxes.every((b) => p.x < b!.x - 10 || p.x > b!.x + b!.width + 10 || p.y < b!.y - 10 || p.y > b!.y + b!.height + 10));
    await page.mouse.move(free!.x, free!.y);
  };
  // The card comes from an ajax request and opens only if the avatar is still hovered when
  // it arrives: leave and enter again until it shows (a fresh mouseenter each time).
  await expect(async () => {
    await away();
    await inPresence.hover();
    await expect(card).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(card).toContainText(/bob/i);
  await expect(popover).toHaveAttribute("data-popper-placement", /bottom|top/);

  // Kept open while the card itself is hovered, well past the 300 ms hide delay.
  await card.hover();
  await page.waitForTimeout(800);
  await expect(card).toBeVisible();

  // Closed once the pointer is elsewhere.
  await away();
  await expect(popover).toBeHidden({ timeout: 5_000 });

  await alice.context.close();
  await bob.context.close();
});

test("the bar shows the link's status, alone on the ticket too", async ({ browser }) => {
  const alice = await login(browser, "alice");
  await openTicketAsAllowed(alice);
  await waitForFrame(alice, (f) => f.t === "subscribed" && f.room === room, "subscribed");
  const status = alice.page.locator(`${bar} .glpi-rt-status`);
  // Whether others are there or not (real users may be), the dot says live.
  await expect(status).toHaveClass(/is-live/);
  await expect(status).toHaveAttribute("aria-label", /^(Connected|Connecté)/);
  // The link goes away: the bar says so, and shows nobody.
  await alice.page.evaluate(() => (window as any).glpiRealtime.stop());
  await expect(status).toHaveClass(/is-offline/);
  await expect(alice.page.locator(`${bar} .glpi-rt-label`)).toHaveText(/^(Offline|Hors ligne)$/);
  await expect(alice.page.locator(`${bar} .glpi-rt-avatar`)).toHaveCount(0);
});
