import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export type Who = "alice" | "bob" | "carol";

export const ticketId = Number(process.env.RT_TICKET_ID);
export const room = `Ticket:${ticketId}`;

export interface Session {
  who: Who;
  context: BrowserContext;
  page: Page;
  /** JSON frames received on /ws, in order. */
  frames: Array<Record<string, any>>;
}

function password(who: Who): string {
  const p = process.env[`RT_${who.toUpperCase()}_PASSWORD`];
  if (!p) throw new Error(`RT_${who.toUpperCase()}_PASSWORD missing in .e2e.env`);
  return p;
}

/** Logs a test account in, in its own isolated browser context. */
export async function login(browser: Browser, who: Who): Promise<Session> {
  const context = await browser.newContext();
  const page = await focusedPage(context);
  const frames: Session["frames"] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/ws")) return;
    ws.on("framereceived", (f) => {
      if (typeof f.payload === "string") {
        try {
          frames.push(JSON.parse(f.payload));
        } catch {
          /* not JSON */
        }
      }
    });
  });
  await page.goto("/");
  await page.fill("#login_name", `rt-${who}`);
  await page.fill("#login_password", password(who));
  await Promise.all([page.waitForURL((u) => !u.pathname.endsWith("/") || u.search !== ""), page.click("button[name=submit]")]);
  await expect(page.locator("#login_name")).toHaveCount(0); // logged in
  return { who, context, page, frames };
}

/**
 * Headless tabs are never "focused" by default: emulate a tab in the foreground,
 * like a real user looking at it.
 */
export async function focusedPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return page;
}

/** Simulates the tab going to the background (or back). */
export async function setTabVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}

/** Switches the active GLPI profile (the account must have it). */
export async function useProfile(s: Session, name: string): Promise<void> {
  const button = s.page.locator("form[action$='/Session/ChangeProfile'] button", { hasText: name }).first();
  await expect(button, `rt-${s.who} must have the ${name} profile`).toHaveCount(1);
  await Promise.all([s.page.waitForEvent("load"), button.evaluate((b: HTMLButtonElement) => b.form!.submit())]);
  await expect(s.page.locator("body")).toContainText(name);
}

/** Opens the test ticket; returns the HTTP status of the page. */
export async function openTicket(s: Session): Promise<number> {
  const resp = await s.page.goto(`/front/ticket.form.php?id=${ticketId}`);
  return resp?.status() ?? 0;
}

/** Test accounts must be set up as documented in e2e/README.md. */
export async function openTicketAsAllowed(s: Session): Promise<void> {
  const status = await openTicket(s);
  expect(status, `rt-${s.who} must be able to open ticket ${ticketId} (default profile Technician?)`).toBe(200);
}

export async function clientState(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as any).glpiRealtime?.state);
}

export async function waitForFrame(s: Session, pred: (f: Record<string, any>) => boolean, label: string) {
  await expect.poll(() => s.frames.some(pred), { message: `${s.who}: waiting for ${label}` }).toBe(true);
  return s.frames.find(pred)!;
}
