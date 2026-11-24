import { expect, test } from "@playwright/test";

import { clientState, login, openTicket, openTicketAsAllowed, room, useProfile, waitForFrame } from "./helpers.ts";

test("two technicians on the same ticket are connected and subscribed", async ({ browser }) => {
  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  await openTicketAsAllowed(alice);
  await openTicketAsAllowed(bob);

  for (const s of [alice, bob]) {
    const hello = await waitForFrame(s, (f) => f.t === "hello", "hello");
    expect(hello.user.id).toBeGreaterThan(0);
    await waitForFrame(s, (f) => f.t === "subscribed" && f.room === room, `subscribed ${room}`);
    await expect.poll(() => clientState(s.page)).toBe("open");
  }
  await alice.context.close();
  await bob.context.close();
});

test("a user who cannot see the ticket gets no subscription", async ({ browser }) => {
  const carol = await login(browser, "carol");
  await useProfile(carol, "Self-Service");
  expect(await openTicket(carol), "rt-carol must NOT be able to open the test ticket").not.toBe(200);
  await waitForFrame(carol, (f) => f.t === "hello", "hello");
  // Even forcing a subscription from the browser console is refused by the server.
  await carol.page.evaluate((r) => (window as any).glpiRealtime.subscribe(r), room);
  const err = await waitForFrame(carol, (f) => f.t === "error", "error");
  expect(err.code).toBe("forbidden");
  expect(carol.frames.some((f) => f.t === "subscribed")).toBe(false);
  await carol.context.close();
});

test("logging out of GLPI revokes the WebSocket", async ({ browser }) => {
  const alice = await login(browser, "alice");
  await openTicketAsAllowed(alice);
  await waitForFrame(alice, (f) => f.t === "subscribed", "subscribed");

  // Log out from another tab of the same browser: the ticket tab keeps its socket open.
  const other = await alice.context.newPage();
  await other.goto("/front/logout.php");
  const bye = await waitForFrame(alice, (f) => f.t === "bye", "bye");
  expect(bye.reason).toBe("revoked");
  await expect.poll(() => clientState(alice.page)).toBe("revoked");
  await alice.context.close();
});
