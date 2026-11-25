import assert from "node:assert/strict";
import { test } from "node:test";

import { ListPresence } from "../src/list.ts";
import { page } from "./dom.ts";

// A GLPI list page without a browser: rows that changed since it was displayed are marked,
// and a banner offers to refresh it.

function table(ids: number[]): string {
  const rows = ids
    .map((id) => `<tr><td><input type="checkbox" class="massive_action_checkbox" name="item[Ticket][${id}]"></td><td data-searchopt-content-id="1"><a href="/front/ticket.form.php?id=${id}">T${id}</a></td></tr>`)
    .join("");
  return `<!doctype html><html><head></head><body><div class="table-responsive"><table class="search-results"><tbody>${rows}</tbody></table></div></body></html>`;
}

function setup(ids: number[], lang = "en") {
  const { document } = page(table(ids));
  const handlers = new Map<string, (m: any) => void>();
  const watched: string[][] = [];
  const client = {
    user: { id: 1 },
    watch: (rooms: string[]) => watched.push(rooms),
    on: (type: string, h: (m: any) => void) => (handlers.set(type, h), () => {}),
  };
  let reloads = 0;
  const list = new ListPresence(document, client, async (items) => items, lang, () => reloads++);
  const emit = (type: string, m: any) => handlers.get(type)?.(m);
  const rowOf = (id: number) => document.querySelector(`input[name='item[Ticket][${id}]']`)!.closest("tr")!;
  const bannerText = () => document.querySelector(".glpi-rt-list-changed-text")?.textContent ?? null;
  return { document, list, emit, watched, rowOf, bannerText, reloads: () => reloads };
}

/** scan() waits 300 ms (GLPI redraws in bursts), then asks for grants. */
async function scanned(list: ListPresence) {
  list.scan();
  await new Promise((r) => setTimeout(r, 350));
}

test("a changed row is marked; a banner counts them and refreshes the list", async () => {
  const { document, list, emit, watched, rowOf, bannerText, reloads } = setup([1, 2, 3]);
  await scanned(list);
  assert.deepEqual(watched.at(-1), ["Ticket:1", "Ticket:2", "Ticket:3"]);
  assert.equal(bannerText(), null, "no banner before a change");

  emit("changed", { room: "Ticket:2" });
  assert.equal(rowOf(2).classList.contains("glpi-rt-row-changed"), true);
  assert.equal(rowOf(2).getAttribute("title"), "Changed since the list was displayed");
  assert.equal(rowOf(1).classList.contains("glpi-rt-row-changed"), false);
  assert.equal(bannerText(), "Items changed in this list: 1");

  emit("changed", { room: "Ticket:3" });
  emit("changed", { room: "Ticket:3" });
  assert.equal(bannerText(), "Items changed in this list: 2", "each row counts once");
  assert.equal(document.querySelectorAll(".glpi-rt-list-changed").length, 1, "one banner");
  assert.equal(document.querySelector(".glpi-rt-list-changed")!.nextElementSibling?.classList.contains("table-responsive"), true, "above the list");

  (document.querySelector(".glpi-rt-list-changed button") as HTMLElement).click();
  assert.equal(reloads(), 1);
});

test("rows not on the page are ignored", async () => {
  const { list, emit, bannerText } = setup([1]);
  await scanned(list);
  emit("changed", { room: "Ticket:9" });
  assert.equal(bannerText(), null);
});

test("another page of the list starts afresh", async () => {
  const { document, list, emit, rowOf, bannerText } = setup([1, 2]);
  await scanned(list);
  emit("changed", { room: "Ticket:1" });
  assert.equal(bannerText(), "Items changed in this list: 1");
  // GLPI shows the next page (rows 2 and 3).
  rowOf(1).remove();
  document.querySelector("tbody")!.insertAdjacentHTML("beforeend", `<tr><td><input type="checkbox" class="massive_action_checkbox" name="item[Ticket][3]"></td><td data-searchopt-content-id="1">T3</td></tr>`);
  await scanned(list);
  assert.equal(bannerText(), null, "banner gone");
  assert.equal(document.querySelectorAll(".glpi-rt-row-changed").length, 0);
});

test("the same rows redrawn by GLPI keep their mark", async () => {
  const { document, list, emit, bannerText } = setup([1, 2]);
  await scanned(list);
  emit("changed", { room: "Ticket:1" });
  // GLPI redraws the same rows (an AJAX refresh of the same page).
  const tbody = document.querySelector("tbody")!;
  tbody.innerHTML = tbody.innerHTML.replace(/ class="glpi-rt-row-changed"| title="[^"]*"/g, "");
  await scanned(list);
  const row = document.querySelector("input[name='item[Ticket][1]']")!.closest("tr")!;
  assert.equal(row.classList.contains("glpi-rt-row-changed"), true);
  assert.equal(bannerText(), "Items changed in this list: 1");
});

test("in French", async () => {
  const { list, emit, bannerText } = setup([1, 2], "fr-FR");
  await scanned(list);
  emit("changed", { room: "Ticket:1" });
  assert.equal(bannerText(), "Éléments modifiés dans cette liste : 1");
  emit("changed", { room: "Ticket:2" });
  assert.equal(bannerText(), "Éléments modifiés dans cette liste : 2");
});
