import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCatalog, needsCatalog, register, template } from "../src/i18n.ts";

test("a catalog replaces English for other languages, French stays", () => {
  const t = register("test.ns", {
    fr: { hello: (n: string) => `Bonjour ${n}`, title: "Titre", list: ["a"] },
    en: { hello: (n: string) => `Hello ${n}`, title: "Title", list: ["a"], nested: { x: "X" } },
  });
  assert.deepEqual((template()["test.ns"] as any).hello, "Hello {0}");
  applyCatalog({ "test.ns": { hello: "Hallo {0}!", title: "Titel", list: ["b"], nested: { x: "Y" }, unknown: "ignored" }, other: { a: 1 } });
  assert.equal(t.en.hello("Anna"), "Hallo Anna!");
  assert.equal(t.en.title, "Titel");
  assert.deepEqual(t.en.list, ["b"]);
  assert.equal(t.en.nested.x, "Y");
  assert.equal((t.en as any).unknown, undefined, "only known texts");
  assert.equal(t.fr.hello("Anna"), "Bonjour Anna", "built-in French untouched");
});

test("which languages need a catalog", () => {
  assert.equal(needsCatalog("de_DE"), true);
  assert.equal(needsCatalog("fr_FR"), false);
  assert.equal(needsCatalog("en-GB"), false);
});
