import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanHtml, DRAFT_BLOCKS, frameDoc } from "../src/drafts.ts";

test("pasted images and scripts are not shared", () => {
  const html = `<p>Voir <img src="data:image/png;base64,AAAA" alt="x"> et <img src="/front/document.send.php?docid=3"></p><script>alert(1)</script>`;
  const out = cleanHtml(html);
  assert.ok(!out.includes("data:"), "data URLs removed");
  assert.ok(out.includes("[image]"));
  assert.ok(out.includes("/front/document.send.php?docid=3"), "uploaded documents kept");
  assert.ok(!out.includes("<script"), "scripts removed");
});

test("the frame forbids every load, the sandbox every script", () => {
  const doc = frameDoc("<p>hi</p>");
  assert.match(doc, /default-src 'none'/);
  assert.ok(doc.includes("<body><p>hi</p></body>"));
});

test("which answer forms are shared", () => {
  assert.equal(DRAFT_BLOCKS.ITILFollowup, "followup");
  assert.equal(DRAFT_BLOCKS.ChangeTask, "task");
  assert.equal(DRAFT_BLOCKS.ITILSolution, "solution");
  assert.equal((DRAFT_BLOCKS as Record<string, string>).TicketValidation, undefined, "approvals are not drafts");
});

test("the editor is found at once, or once it starts", async () => {
  const { findEditor } = await import("../src/drafts.ts");
  const ed = { initialized: true, getContent: () => "<p>x</p>", setContent() {}, on() {} };
  const block = { querySelector: () => ({ id: "content_1" }) } as unknown as Element;
  const tm = { get: (id: string) => (id === "content_1" ? ed : null) };
  assert.equal(await findEditor(block, 0, tm), ed, "timeout 0 still looks once");
  let ready = false;
  setTimeout(() => (ready = true), 250);
  const late = { get: () => (ready ? ed : null) };
  assert.equal(await findEditor(block, 2000, late), ed, "waits for TinyMCE");
  assert.equal(await findEditor(block, 0, { get: () => null }), null);
});

test("GLPI images of a followed draft are inlined, nothing else", async () => {
  const { imageSources, inlineImages } = await import("../src/drafts.ts");
  const html = `<p><img src="/front/document.send.php?docid=3&amp;itemtype=Ticket"><img src="https://evil.example/x.png"><img src="//evil.example/y.png"></p>`;
  assert.deepEqual(imageSources(html), ["/front/document.send.php?docid=3&itemtype=Ticket"], "same origin only");
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(url);
    return { ok: true, blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) };
  }) as unknown as typeof fetch;
  const out = await inlineImages(html, new Map(), fake);
  assert.match(out, /src="data:image\/png;base64,iVBORw=="/);
  assert.ok(out.includes("https://evil.example/x.png"), "foreign images untouched (the frame's CSP blocks them)");
  assert.deepEqual(asked, ["/front/document.send.php?docid=3&itemtype=Ticket"]);
  const notImage = (async () => ({ ok: true, blob: async () => new Blob(["<html>"], { type: "text/html" }) })) as unknown as typeof fetch;
  assert.ok((await inlineImages(html, new Map(), notImage)).includes('src="/front/document.send.php'), "not an image: left as is");
});
