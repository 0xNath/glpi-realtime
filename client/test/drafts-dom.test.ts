import assert from "node:assert/strict";
import { test } from "node:test";

import { type DraftClient, SharedDrafts } from "../src/drafts.ts";
import { event, page, tick } from "./dom.ts";

// Shared drafts in a DOM without a browser: writing, being taken over, following a
// colleague's draft, taking over one left by a closed tab. End-to-end tests check the same
// in GLPI (e2e/tests/collab.spec.ts).

const ROOM = "Ticket:1";
const ME = { id: 1, name: "Me", conn: "c-me" };
const BOB = { id: 2, name: "Bob", conn: "c-bob" };

/** A fake real-time client: what was sent, and a way to deliver server messages. */
function fakeClient() {
  const sent: any[] = [];
  const handlers = new Map<string, ((m: any) => void)[]>();
  const client: DraftClient = {
    conn: ME.conn,
    user: { id: ME.id },
    send: (msg) => (sent.push(msg), sent.length),
    on: (type, h) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
      return () => {};
    },
  };
  const emit = (type: string, msg: any) => (handlers.get(type) ?? []).forEach((h) => h(msg));
  return { client, sent, emit, last: (t: string) => sent.filter((m) => m.t === t).at(-1) };
}

/** GLPI's answer block with its TinyMCE (a fake, through `globalThis.tinymce`). */
function answerBlock(document: Document, cls = "ITILFollowup") {
  const block = document.createElement("div");
  block.id = `new-${cls}-block`;
  block.innerHTML = `<div class="card-body"><form><textarea name="content" id="content_${cls}"></textarea><input type="checkbox" name="is_private"></form></div>`;
  document.body.append(block);
  let content = "";
  const listeners: (() => void)[] = [];
  const editor = {
    initialized: true,
    getContent: () => content,
    setContent: (html: string) => {
      content = html;
      listeners.forEach((l) => l());
    },
    on: (_events: string, fn: () => void) => listeners.push(fn),
    type: (html: string) => ((content = html), listeners.forEach((l) => l())),
  };
  const editors = ((globalThis as any).tinymce ??= { editors: {} as Record<string, unknown>, get: (id: string) => (globalThis as any).tinymce.editors[id] ?? null });
  editors.editors[`content_${cls}`] = editor;
  return { block, editor };
}

function setup() {
  const { document } = page();
  delete (globalThis as any).tinymce;
  delete (globalThis as any).bootstrap;
  const fake = fakeClient();
  const drafts = new SharedDrafts(document, fake.client, ROOM, "en");
  let changes = 0;
  drafts.onChange = () => changes++;
  return { document, drafts, ...fake, changes: () => changes };
}

const debounce = () => new Promise((r) => setTimeout(r, 750)); // the 700 ms of share()

test("writing: the draft is shared once typing pauses, with its privacy; sending it ends it", async () => {
  const { document, sent, last } = setup();
  const { block, editor } = answerBlock(document);
  block.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  await tick();
  editor.type("<p>Hello <script>x()</script></p>");
  block.querySelector<HTMLInputElement>("input[name='is_private']")!.checked = true;
  await debounce();
  const d = last("draft");
  assert.equal(d.room, ROOM);
  assert.equal(d.kind, "followup");
  assert.equal(d.private, true);
  assert.ok(d.html.includes("Hello") && !d.html.includes("<script"), "cleaned before it leaves");
  assert.equal(sent.filter((m) => m.t === "draft").length, 1, "one send per pause");

  block.querySelector("form")!.dispatchEvent(event("submit", {}, { bubbles: true }));
  assert.deepEqual(last("draft_end"), { t: "draft_end", room: ROOM, kind: "followup" });
});

test("someone already writes it: ours stays personal and is not sent", async () => {
  const { document, emit, sent } = setup();
  emit("draft_info", { room: ROOM, kind: "followup", writer: BOB, private: false, away: false });
  const { block, editor } = answerBlock(document);
  block.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  await tick();
  assert.match(block.querySelector(".glpi-rt-draft-note")!.textContent!, /Bob already writes this shared draft/);
  editor.type("<p>mine</p>");
  await debounce();
  assert.equal(sent.filter((m) => m.t === "draft").length, 0);
});

test("refused as locked: a note names the writer, nothing more is sent", async () => {
  const { document, emit, sent } = setup();
  const { block, editor } = answerBlock(document);
  block.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  await tick();
  editor.type("<p>v1</p>");
  await debounce();
  // Bob got it first (his draft_info not yet seen): the server refuses ours.
  const id = sent.length; // send() returns the message's id
  emit("error", { id, code: "locked" });
  assert.match(block.querySelector(".glpi-rt-draft-note")?.textContent ?? "", /already writes this shared draft/);
  editor.type("<p>v2</p>");
  await debounce();
  assert.equal(sent.filter((m) => m.t === "draft").length, 1, "no more sends");
});

test("taken over while writing: a note says who, nothing more is sent", async () => {
  const { document, emit, sent } = setup();
  const { block, editor } = answerBlock(document);
  block.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  await tick();
  editor.type("<p>v1</p>");
  await debounce();
  emit("draft_info", { room: ROOM, kind: "followup", writer: BOB, private: false, away: false });
  assert.match(block.querySelector(".glpi-rt-draft-note")?.textContent ?? "", /Bob took over this draft/);
  editor.type("<p>v2</p>");
  await debounce();
  assert.equal(sent.filter((m) => m.t === "draft").length, 1, "no more sends");
});

test("a colleague's draft: join shows it live in a sandboxed frame, leave stops it", async () => {
  const { document, drafts, emit, last, changes } = setup();
  emit("draft_info", { room: ROOM, kind: "followup", writer: BOB, private: false, away: false });
  assert.equal(changes(), 1);
  const placeholder = document.createElement("div");
  placeholder.innerHTML = `<div class="card-body"></div>`;
  drafts.decorate(placeholder, "followup", BOB.id);
  const join = [...placeholder.querySelectorAll("button")].find((b) => b.textContent!.includes("Join"))!;
  assert.ok(join, "a Join button");
  assert.equal([...placeholder.querySelectorAll("button")].some((b) => b.textContent === "Take over"), false, "no takeover while Bob is there");
  join.click();
  assert.deepEqual(last("draft_watch"), { t: "draft_watch", room: ROOM, kind: "followup", on: true });

  drafts.decorate(placeholder, "followup", BOB.id); // redrawn on onChange
  const frame = placeholder.querySelector("iframe")!;
  assert.equal(frame.getAttribute("sandbox"), "", "no script, no same-origin");
  emit("draft", { room: ROOM, kind: "followup", draft: { html: "<p>Bob's text</p>", writer: BOB } });
  assert.match((frame as HTMLIFrameElement).srcdoc, /Bob's text/);
  assert.match((frame as HTMLIFrameElement).srcdoc, /default-src 'none'/);

  [...placeholder.querySelectorAll("button")].find((b) => b.textContent === "Leave")!.click();
  assert.deepEqual(last("draft_watch"), { t: "draft_watch", room: ROOM, kind: "followup", on: false });
});

test("no buttons on our own draft, nor on another user's placeholder", () => {
  const { document, drafts, emit } = setup();
  emit("draft_info", { room: ROOM, kind: "followup", writer: ME, private: false, away: false });
  const mine = document.createElement("div");
  drafts.decorate(mine, "followup", ME.id);
  assert.ok(mine.querySelector("button") === null);
  emit("draft_info", { room: ROOM, kind: "task", writer: BOB, private: false, away: false });
  const other = document.createElement("div");
  drafts.decorate(other, "task", 99);
  assert.ok(other.querySelector("button") === null);
});

test("a draft left by a closed tab: listed, taken over into our own form, then ours", async () => {
  const { document, drafts, emit, last, sent } = setup();
  const { block, editor } = answerBlock(document, "ITILSolution");
  emit("draft_info", { room: ROOM, kind: "solution", writer: BOB, private: true, away: true });
  assert.deepEqual(drafts.leftBehind().map(([k]) => k), ["solution"]);
  assert.equal(drafts.leftLabel("solution", drafts.info("solution")!), "solution draft left by Bob");

  // GLPI's Bootstrap: showing the closed answer form fires shown.bs.collapse.
  (globalThis as any).bootstrap = {
    Collapse: { getOrCreateInstance: (el: Element) => ({ show: () => el.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true })) }) },
  };
  const placeholder = document.createElement("div");
  drafts.decorate(placeholder, "solution", BOB.id);
  [...placeholder.querySelectorAll("button")].find((b) => b.textContent === "Take over")!.click();
  assert.deepEqual(last("draft_take"), { t: "draft_take", room: ROOM, kind: "solution" });

  // The server makes us the writer and sends the text.
  emit("draft", { room: ROOM, kind: "solution", draft: { html: "<p>Bob's solution</p>", private: true, writer: ME } });
  await tick();
  await tick();
  assert.equal(editor.getContent(), "<p>Bob's solution</p>");
  assert.equal(block.querySelector<HTMLInputElement>("input[name='is_private']")!.checked, true, "its privacy too");
  const locks = sent.filter((m) => m.t === "lock");
  assert.deepEqual(locks, [
    { t: "lock", room: ROOM, scope: "solution", force: true },
    { t: "lock", room: ROOM, force: true, reason: "solution" },
  ], "a solution brings its locks along");

  // Ours now: edits are shared, a reconnection shares it again.
  editor.type("<p>Bob's solution, finished</p>");
  await debounce();
  assert.match(last("draft").html, /finished/);
  const before = sent.length;
  emit("subscribed", { room: ROOM });
  await tick();
  assert.equal(sent.length, before + 1);
  assert.equal(last("draft").kind, "solution");
});

test("the followed draft ended: we stop following it", () => {
  const { document, drafts, emit, last } = setup();
  emit("draft_info", { room: ROOM, kind: "task", writer: BOB, private: false, away: false });
  const placeholder = document.createElement("div");
  drafts.decorate(placeholder, "task", BOB.id);
  placeholder.querySelector("button")!.click();
  emit("draft", { room: ROOM, kind: "task", draft: null });
  assert.deepEqual(last("draft_watch"), { t: "draft_watch", room: ROOM, kind: "task", on: false });
});

test("messages of other rooms are ignored", () => {
  const { drafts, emit, changes } = setup();
  emit("draft_info", { room: "Ticket:2", kind: "followup", writer: BOB, private: false, away: true });
  assert.equal(drafts.info("followup"), undefined);
  assert.equal(changes(), 0);
});

test("a followed draft with GLPI's images: shown at once, then with the images inlined", async () => {
  const { document, drafts, emit } = setup();
  (globalThis as any).fetch = async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) });
  emit("draft_info", { room: ROOM, kind: "followup", writer: BOB, private: false, away: false });
  const ph = document.createElement("div");
  drafts.decorate(ph, "followup", BOB.id);
  ph.querySelector("button")!.click(); // join
  drafts.decorate(ph, "followup", BOB.id);
  const frame = ph.querySelector("iframe") as HTMLIFrameElement;
  emit("draft", { room: ROOM, kind: "followup", draft: { html: `<p><img src="/front/document.send.php?docid=9"></p>`, writer: BOB } });
  assert.match(frame.srcdoc, /document\.send\.php\?docid=9/, "first as is");
  for (let i = 0; i < 10; i++) await tick();
  assert.match(frame.srcdoc, /data:image\/png;base64,AQID/, "then inlined (the frame loads nothing itself)");
});

test("an image that cannot be read stays as it is", async () => {
  const { inlineImages } = await import("../src/drafts.ts");
  const html = `<img src="/front/document.send.php?docid=1">`;
  const broken = (async () => ({ ok: true, blob: async () => ({ type: "image/png", arrayBuffer: async () => { throw new Error("aborted"); } }) })) as unknown as typeof fetch;
  assert.equal(await inlineImages(html, new Map(), broken), html);
});

test("a draft ended by its writer is forgotten; too large to share: said", async () => {
  const { document, drafts, emit, sent, changes } = setup();
  emit("draft_info", { room: ROOM, kind: "task", writer: BOB, private: false, away: true });
  emit("draft_info", { room: ROOM, kind: "task", writer: null, private: false, away: false });
  assert.equal(drafts.info("task"), undefined);
  assert.equal(changes(), 2);
  const { block, editor } = answerBlock(document);
  block.dispatchEvent(event("shown.bs.collapse", {}, { bubbles: true }));
  await tick();
  editor.type("<p>huge</p>");
  await debounce();
  emit("error", { id: sent.length, code: "too_large" });
  assert.equal(block.querySelector(".glpi-rt-draft-note")?.textContent, "Draft too large to be shared.");
});

test("taking over a draft whose answer form is not on this page: nothing breaks", async () => {
  const { emit, sent } = setup();
  emit("draft", { room: ROOM, kind: "solution", draft: { html: "<p>x</p>", private: false, writer: ME } });
  await tick();
  assert.equal(sent.some((m) => m.t === "lock"), false, "no form, no locks taken");
});
