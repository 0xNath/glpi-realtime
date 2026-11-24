import config from "./playwright.config.ts";

// The README's and GLPI catalog's screenshots, from the disposable environment:
//   env/up.sh && E2E_ENV_FILE=../.e2e.local.env npx playwright test --config screenshots.config.ts
export default {
  ...config,
  testDir: "./screenshots",
  use: { ...config.use, viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1, trace: "off" },
};
