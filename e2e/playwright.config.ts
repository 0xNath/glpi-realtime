import { existsSync } from "node:fs";

import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Your GLPI (../.e2e.env), or the disposable one of e2e/env/up.sh (E2E_ENV_FILE).
loadEnv({ path: process.env.E2E_ENV_FILE ?? new URL("../.e2e.env", import.meta.url).pathname, quiet: true });

// The system's Chromium when there is one, else Playwright's (npx playwright install chromium).
const chromium = process.env.CHROMIUM ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1, // tests share the same GLPI ticket
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.GLPI_URL,
    headless: true,
    // The disposable environment's certificate is self-signed.
    ignoreHTTPSErrors: process.env.E2E_INSECURE === "1",
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: "retain-on-failure",
  },
});
