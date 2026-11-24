import assert from "node:assert/strict";
import { test } from "node:test";

import { glpiHeaders } from "../src/http.ts";

/** The part of Document glpiHeaders reads. */
function page(token: string | null): Document {
  return { querySelector: (sel: string) => (token !== null && sel === 'meta[property="glpi:csrf_token"]' ? { content: token } : null) } as unknown as Document;
}

test("GLPI 11: the page's CSRF token goes with every request", () => {
  assert.deepEqual(glpiHeaders(page("abc123"), true), {
    "X-Requested-With": "XMLHttpRequest",
    "X-Glpi-Csrf-Token": "abc123",
    "Content-Type": "application/json",
  });
});

test("GLPI 12: no token in the page, no header", () => {
  assert.deepEqual(glpiHeaders(page(null)), { "X-Requested-With": "XMLHttpRequest" });
  assert.deepEqual(glpiHeaders(undefined), { "X-Requested-With": "XMLHttpRequest" });
});
