import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv({ path: new URL("../.e2e.env", import.meta.url).pathname, quiet: true });

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1, // tests share the same GLPI ticket
  reporter: [["list"]],
  use: {
    baseURL: process.env.GLPI_URL,
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" },
    trace: "retain-on-failure",
  },
});
