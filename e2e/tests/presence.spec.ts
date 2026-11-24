import { expect, type Page, test } from "@playwright/test";

import {
  focusedPage,
  login,
  openTicket,
  openTicketAsAllowed,
  room,
  type Session,
  setTabVisible,
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
  await inPresence.hover();
  const card = alice.page.locator(".popover.glpi-rt-card .user-info-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("rt-bob");
  await expect(alice.page.locator(".popover.glpi-rt-card")).toHaveAttribute("data-popper-placement", /bottom|top/);
  await card.hover();
  await alice.page.waitForTimeout(600);
  await expect(card).toBeVisible();
  await alice.page.mouse.move(400, 400);
  await expect(card).toBeHidden();

  await alice.context.close();
  await bob.context.close();
});
