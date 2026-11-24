import assert from "node:assert/strict";
import { test } from "node:test";

import { rowKey } from "../src/list.ts";

/** Minimal search-result row: a massive action box and/or links. */
function row(box: string | null, hrefs: string[]): Element {
  return {
    querySelector: (sel: string) => (sel.startsWith("input") && box ? { name: box } : null),
    querySelectorAll: () => hrefs.map((h) => ({ getAttribute: () => h })),
  } as unknown as Element;
}

test("rows are recognized by their massive action box", () => {
  assert.equal(rowKey(row("item[Ticket][42]", [])), "Ticket:42");
  assert.equal(rowKey(row("item[Problem][7]", [])), "Problem:7");
  // Any item type: GLPI's grants.php says which are enabled and readable.
  assert.equal(rowKey(row("item[Computer][3]", [])), "Computer:3");
  assert.equal(rowKey(row("item[Glpi\\CustomAsset\\ServerAsset][4]", [])), "Glpi\\CustomAsset\\ServerAsset:4", "custom assets");
  assert.equal(rowKey(row("item[Computer][0]", [])), null, "no id");
});

test("or by their form link when there is no box (self-service, no rights)", () => {
  assert.equal(rowKey(row(null, ["/front/change.form.php?id=12"])), "Change:12");
  assert.equal(rowKey(row(null, ["/glpi/front/ticket.form.php?forcetab=x&id=5"])), "Ticket:5");
  assert.equal(rowKey(row(null, ["/front/user.form.php?id=2", "/front/ticket.form.php?id=9"])), "Ticket:9", "the item's link, not the requester's");
  assert.equal(rowKey(row(null, ["/front/ticket.form.php?id=0"])), null);
});
