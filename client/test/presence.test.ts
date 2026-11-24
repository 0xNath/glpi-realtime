import assert from "node:assert/strict";
import { test } from "node:test";

import { hue, initials, labels, look, others } from "../src/presence.ts";

test("initials", () => {
  assert.equal(initials("Alice Martin"), "AM");
  assert.equal(initials("rt-bob"), "RB");
  assert.equal(initials("glpi"), "GL");
  assert.equal(initials("Élodie d'Arc"), "ÉD");
  assert.equal(initials(""), "?");
});

test("own tabs are not shown", () => {
  const users = [
    { id: 1, name: "a", since: 1, active: true },
    { id: 2, name: "b", since: 2, active: false },
  ];
  assert.deepEqual(others(users, 1).map((u) => u.id), [2]);
  assert.deepEqual(others(users, undefined).map((u) => u.id), [1, 2]);
});

test("stable colors and labels", () => {
  assert.equal(hue(5), hue(5));
  assert.notEqual(hue(5), hue(6));
  assert.equal(labels("fr-FR").also, "Également sur ce ticket :");
  assert.equal(labels("de").also, "Also on this ticket:");
  assert.equal(labels("fr").more(2), "et 2 autres");
});

test("GLPI avatar: picture, else GLPI initials and colors, else fallback", () => {
  const base = { id: 7, name: "Alice Martin", since: 1, active: true };
  const pic = look({ ...base, avatar: { picture: "/front/document.send.php?file=_pictures/a.png", initials: "AM", color: "#5a7f9e", fg: "#fff" } });
  assert.equal(pic.picture, "/front/document.send.php?file=_pictures/a.png");
  assert.equal(pic.text, "");
  const ini = look({ ...base, avatar: { picture: "", initials: "AL", color: "#5a7f9e", fg: "#000000" } });
  assert.deepEqual(ini, { picture: null, text: "AL", bg: "#5a7f9e", fg: "#000000" });
  const none = look(base);
  assert.equal(none.text, "AM");
  assert.equal(none.bg, `hsl(${hue(7)} 55% 42%)`);
});

test("hostile avatar values are ignored", () => {
  const u = { id: 1, name: "x", since: 1, active: true };
  for (const picture of ['/a.png") ; background:url(//evil', "//evil.example/a.png", "https://evil.example/a.png", "javascript:alert(1)"]) {
    assert.equal(look({ ...u, avatar: { picture, initials: "X", color: "#fff", fg: "#000" } }).picture, null, picture);
  }
  assert.equal(look({ ...u, avatar: { picture: "", initials: "X", color: "red;x:y", fg: "#000" } }).bg, `hsl(${hue(1)} 55% 42%)`);
});
