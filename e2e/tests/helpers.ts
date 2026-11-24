import { test as base, type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export { expect };

/** Browser contexts opened by login(), closed after each test whatever its outcome. */
const open = new Set<BrowserContext>();

/**
 * Playwright's test, closing the sessions a test opened even when it fails or is skipped
 * half-way: a tab left open on the test ticket would show up in the next tests' presence.
 */
export const test = base.extend<{ closeSessions: void }>({
  closeSessions: [
    async ({}, use) => {
      await use();
      for (const c of open) await c.close().catch(() => {});
      open.clear();
    },
    { auto: true },
  ],
});

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
  open.add(context);
  context.on("close", () => open.delete(context));
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
  // The web server may rate-limit logins (HTTP 429, e.g. nginx limit_req on login.php):
  // several tests log in quickly one after the other, so wait and try again.
  for (let attempt = 1; ; attempt++) {
    await page.goto("/");
    await page.fill("#login_name", `rt-${who}`);
    await page.fill("#login_password", password(who));
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/login.php")),
      page.click("button[name=submit]"),
    ]);
    if (resp.status() === 429 && attempt < 8) {
      await page.waitForTimeout(1_000 * attempt);
      continue;
    }
    expect(resp.status(), `rt-${who}: login answered HTTP ${resp.status()}`).toBeLessThan(400);
    break;
  }
  await page.waitForLoadState();
  // Logged in: GLPI's user menu is there, not the login form.
  await expect(page.locator("#login_name")).toHaveCount(0);
  await expect(page.locator("header .avatar").first()).toBeVisible();
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

/** Opens one of GLPI's answer forms (followup, solution...) and waits for its editor. */
export async function openAnswer(page: Page, cls: string): Promise<void> {
  await page.evaluate((cls) => {
    const block = document.getElementById(`new-${cls}-block`);
    if (!block) throw new Error(`no ${cls} answer form`);
    (window as any).bootstrap.Collapse.getOrCreateInstance(block, { toggle: false }).show();
  }, cls);
  await expect(page.locator(`#new-${cls}-block textarea[name='content']`)).toBeAttached();
}

export async function closeAnswer(page: Page, cls: string): Promise<void> {
  await page.evaluate((cls) => {
    (window as any).bootstrap.Collapse.getOrCreateInstance(document.getElementById(`new-${cls}-block`)!).hide();
  }, cls);
}

/** Types into the TinyMCE editor of an answer form. */
export async function typeAnswer(page: Page, cls: string, text: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((cls) => {
      const area = document.querySelector<HTMLTextAreaElement>(`#new-${cls}-block textarea[name='content']`);
      return !!(area && (window as any).tinymce?.get(area.id));
    }, cls))
    .toBe(true);
  await page.evaluate(({ cls, text }) => {
    const area = document.querySelector<HTMLTextAreaElement>(`#new-${cls}-block textarea[name='content']`)!;
    const ed = (window as any).tinymce.get(area.id);
    ed.setContent(`<p>${text}</p>`);
    ed.fire("input");
  }, { cls, text });
}

