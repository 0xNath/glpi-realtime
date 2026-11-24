import { expect, login, test } from "./helpers.ts";

test("the plugin's settings are changed from GLPI, checked before saving", async ({ browser }) => {
  const bob = await login(browser, "bob");
  await bob.page.goto("/plugins/realtime/front/config.php");
  const form = bob.page.locator("#glpi-rt-settings");
  await expect(form).toBeVisible();
  const software = form.locator("input[name='itemtypes[]'][value='Software']");
  const wasChecked = await software.isChecked();

  // An item type more: saved, and the page (with its checks) shows it.
  await software.setChecked(!wasChecked);
  await Promise.all([bob.page.waitForEvent("load"), form.getByRole("button", { name: /^(save|enregistrer)$/i }).click()]);
  await expect(bob.page.locator("body")).toContainText(/settings saved|réglages enregistrés/i);
  await expect(bob.page.locator("#glpi-rt-settings input[name='itemtypes[]'][value='Software']")).toBeChecked({ checked: !wasChecked });

  // A wrong value: refused, nothing saved.
  await bob.page.locator("#glpi-rt-settings input[name='ws_path']").fill("ws");
  await Promise.all([bob.page.waitForEvent("load"), bob.page.locator("#glpi-rt-settings").getByRole("button", { name: /^(save|enregistrer)$/i }).click()]);
  await expect(bob.page.locator("body")).toContainText(/starts with \/|commence par \//i);
  await expect(bob.page.locator("#glpi-rt-settings input[name='ws_path']")).toHaveValue("/ws");

  // Back as it was; the WebSocket still works with the saved settings.
  await bob.page.locator("#glpi-rt-settings input[name='itemtypes[]'][value='Software']").setChecked(wasChecked);
  await Promise.all([bob.page.waitForEvent("load"), bob.page.locator("#glpi-rt-settings").getByRole("button", { name: /^(save|enregistrer)$/i }).click()]);
  await expect(bob.page.locator("#glpi-rt-browser-checks tr").nth(1)).toContainText(/connected|connecté/i, { timeout: 15_000 });
});
