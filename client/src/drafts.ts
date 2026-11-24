import { register } from "./i18n.ts";
import { h, icon } from "./dom.ts";
import type { Holder } from "./protocol.ts";

/**
 * Shared answer drafts (step 5): one per item and kind (followup, task, solution).
 *
 * - The writer keeps GLPI's editor (TinyMCE); what they type is shared as they type,
 *   without pasted images (too large: shown as "[image]").
 * - Others see "Join" on the "Alice is writing…" placeholder and follow the draft live,
 *   read-only, in a sandboxed frame (no script, no remote content): another user's HTML
 *   never runs in this page.
 * - "Take over" is offered when the writer's tab is inactive or closed: the draft opens
 *   in one's own answer form, which then becomes the shared one.
 */

export type DraftKind = "followup" | "task" | "solution";

/** GLPI answer blocks (`#new-{Class}-block`) whose drafts are shared. */
export const DRAFT_BLOCKS: Record<string, DraftKind> = {
  ITILFollowup: "followup",
  TicketTask: "task",
  ChangeTask: "task",
  ProblemTask: "task",
  ITILSolution: "solution",
};

export interface DraftInfo {
  writer: Holder | null;
  private: boolean;
  away: boolean;
}

/** Largest draft the server accepts (bytes of HTML). */
export const MAX_HTML = 48 * 1024;

/** Removes what must not be shared: pasted images (data URLs, huge) and scripts. */
export function cleanHtml(html: string): string {
  return html
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']?data:[^>]*>/gi, "[image]")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
}

/**
 * Document shown in the sandboxed frame. The CSP forbids every load (no tracking pixel,
 * no remote content); the sandbox forbids scripts whatever the HTML contains.
 */
export function frameDoc(html: string): string {
  return (
    "<!doctype html><html><head><meta charset=utf-8>" +
    // Images only as data: URLs, inlined by the page from GLPI (see inlineImages).
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    "<style>body{font:14px/1.4 system-ui,sans-serif;margin:.5rem;color:#1d273b;word-wrap:break-word}img{max-width:100%}</style>" +
    `</head><body>${html}</body></html>`
  );
}

/** Same-origin image sources of a draft (documents uploaded to GLPI). */
export function imageSources(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const src = m[1].replace(/&amp;/g, "&");
    if (/^\/(?!\/)[A-Za-z0-9/._~?=&%+-]*$/.test(src)) out.add(src);
  }
  return [...out];
}

/** Largest image inlined in a followed draft. */
const MAX_IMAGE = 2 * 1024 * 1024;

/**
 * The sandboxed frame cannot load anything: the page fetches the draft's GLPI images itself
 * (same origin, the user's session, so GLPI's rights on the documents apply) and puts
 * them in as data: URLs. Cached per source.
 */
export async function inlineImages(html: string, cache: Map<string, Promise<string | null>>, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<string> {
  let out = html;
  for (const src of imageSources(html)) {
    let p = cache.get(src);
    if (!p) {
      p = (async () => {
        try {
          const resp = await fetchFn(src, { credentials: "same-origin" });
          const blob = resp.ok ? await resp.blob() : null;
          if (!blob || !blob.type.startsWith("image/") || blob.size > MAX_IMAGE) return null;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return `data:${blob.type};base64,${btoa(bin)}`;
        } catch {
          return null;
        }
      })();
      cache.set(src, p);
    }
    const data = await p;
    if (data) {
      const esc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(src\\s*=\\s*["'])${esc.replace(/&/g, "(?:&|&amp;)")}(["'])`, "g"), `$1${data}$2`);
    }
  }
  return out;
}

type Lang = "fr" | "en";
const KIND_NAME = register<Record<Lang, Record<DraftKind, string>>>("drafts.kinds", {
  fr: { followup: "suivi", task: "tâche", solution: "solution" },
  en: { followup: "followup", task: "task", solution: "solution" },
});
const TEXT = register("drafts", {
  fr: {
    join: "Rejoindre",
    leave: "Quitter",
    take: "Prendre la suite",
    left: (n: string, k: string) => `Brouillon de ${k} laissé par ${n}`,
    taken: (n: string) => `${n} a pris la suite de ce brouillon : envoyez-le seulement si vous en êtes sûr.`,
    shared: (n: string) => `${n} rédige déjà ce brouillon partagé : le vôtre reste personnel.`,
    tooLarge: "Brouillon trop volumineux pour être partagé.",
  },
  en: {
    join: "Join",
    leave: "Leave",
    take: "Take over",
    left: (n: string, k: string) => `${k} draft left by ${n}`,
    taken: (n: string) => `${n} took over this draft: only send it if you are sure.`,
    shared: (n: string) => `${n} already writes this shared draft: yours stays personal.`,
    tooLarge: "Draft too large to be shared.",
  },
});

const STYLE = `
.glpi-rt-draft-view { margin-top:.5rem; }
.glpi-rt-draft-view iframe { width:100%; height:12rem; border:1px solid var(--tblr-border-color, #e6e7e9); border-radius:4px; background:#fff; }
.glpi-rt-draft-actions { display:flex; gap:.4rem; margin-top:.4rem; flex-wrap:wrap; }
.glpi-rt-draft-note { font-size:.8rem; color:var(--tblr-warning, #f59f00); margin:.25rem 0; }
`;

export interface DraftClient {
  conn: string | null;
  user: { id: number } | null;
  send(msg: any): number;
  on(type: string, h: (msg: any) => void): () => void;
}

export interface Editor {
  getContent(): string;
  setContent(html: string): void;
  on(events: string, fn: () => void): void;
}

/**
 * The TinyMCE editor of an answer block. Looks at least once (timeout 0: right now), then
 * every 200 ms until `timeoutMs`, since GLPI loads the form and starts TinyMCE late.
 */
export async function findEditor(block: Element, timeoutMs: number, tm: any = (globalThis as any).tinymce): Promise<Editor | null> {
  const started = Date.now();
  for (;;) {
    const area = block.querySelector<HTMLTextAreaElement>("textarea[name='content']");
    const ed = area?.id ? (tm ?? (globalThis as any).tinymce)?.get?.(area.id) : null;
    if (ed && ed.initialized !== false) return ed as Editor;
    if (Date.now() - started >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export class SharedDrafts {
  private readonly doc: Document;
  private readonly client: DraftClient;
  private readonly room: string;
  private readonly lang: Lang;
  private readonly infos = new Map<DraftKind, DraftInfo>();
  /** Draft we write: kind, and whether the server accepted us as its writer. */
  private writing: { kind: DraftKind; block: Element; shared: boolean; timer?: ReturnType<typeof setTimeout> } | null = null;
  private watching: DraftKind | null = null;
  private readonly frames = new Map<DraftKind, HTMLIFrameElement>();
  private readonly pending = new Map<number, DraftKind>();
  private readonly images = new Map<string, Promise<string | null>>();
  /** Called when placeholders must be drawn again (infos changed). */
  onChange: () => void = () => {};

  constructor(doc: Document, client: DraftClient, room: string, lang: string) {
    this.doc = doc;
    this.client = client;
    this.room = room;
    this.lang = lang.slice(0, 2).toLowerCase() === "fr" ? "fr" : "en";
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head.appendChild(style);

    doc.addEventListener("shown.bs.collapse", (e) => this.opened(e.target as Element));
    doc.addEventListener("hidden.bs.collapse", (e) => {
      if (this.writing?.block === e.target) this.stopWriting();
    });
    doc.addEventListener(
      "submit",
      (e) => {
        if (this.writing && this.writing.block.contains(e.target as Node)) this.stopWriting();
      },
      true,
    );

    client.on("draft_info", (m) => {
      if (m.room !== room) return;
      const was = this.infos.get(m.kind);
      if (m.writer) this.infos.set(m.kind, { writer: m.writer, private: m.private, away: m.away });
      else this.infos.delete(m.kind);
      // Someone took over the draft we were writing.
      const w = this.writing;
      if (w && w.kind === m.kind && w.shared && m.writer && m.writer.conn !== client.conn) {
        w.shared = false;
        this.note(w.block, TEXT[this.lang].taken(m.writer.name));
      }
      if (was?.writer?.conn !== m.writer?.conn || was?.away !== m.away) this.onChange();
    });
    client.on("draft", (m) => {
      if (m.room !== room) return;
      if (m.draft?.writer?.conn && m.draft.writer.conn === client.conn) {
        void this.continueWith(m.kind, m.draft.html, m.draft.private); // our takeover
        return;
      }
      const frame = this.frames.get(m.kind);
      if (frame) {
        const html = m.draft?.html ?? "";
        frame.srcdoc = frameDoc(html);
        // Then with GLPI's images, once fetched (only if no newer version arrived).
        if (imageSources(html).length) {
          void inlineImages(html, this.images).then((full) => {
            if (this.frames.get(m.kind) === frame && full !== html) frame.srcdoc = frameDoc(full);
          });
        }
      }
      if (!m.draft && this.watching === m.kind) this.unwatch();
    });
    client.on("error", (m) => {
      const kind = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!kind || !this.writing || this.writing.kind !== kind) return;
      this.pending.delete(m.id);
      if (m.code === "locked") {
        this.writing.shared = false;
        this.note(this.writing.block, TEXT[this.lang].shared(this.infos.get(kind)?.writer?.name ?? "?"));
      } else if (m.code === "too_large") {
        this.note(this.writing.block, TEXT[this.lang].tooLarge);
      }
    });
    client.on("subscribed", (m) => {
      // Reconnected: our draft is ours again only if nobody took it meanwhile.
      if (m.room === room && this.writing?.shared) this.share();
    });
  }

  info(kind: DraftKind): DraftInfo | undefined {
    return this.infos.get(kind);
  }

  /** Drafts whose writer left: shown even without an "is writing" placeholder. */
  leftBehind(): Array<[DraftKind, DraftInfo]> {
    return [...this.infos].filter(([, i]) => i.away && i.writer?.conn !== this.client.conn);
  }

  /** Buttons and live view for a placeholder of `kind` written by `uid`. */
  decorate(el: HTMLElement, kind: DraftKind, uid: number): void {
    const info = this.infos.get(kind);
    const body = el.querySelector(".card-body") ?? el;
    body.querySelector(".glpi-rt-draft-actions")?.remove();
    body.querySelector(".glpi-rt-draft-view")?.remove();
    if (!info?.writer || info.writer.id !== uid || info.writer.conn === this.client.conn) return;
    const t = TEXT[this.lang];
    const actions = h("div", { class: "glpi-rt-draft-actions" });
    if (this.watching === kind) {
      const frame = this.frames.get(kind) ?? (h("iframe", { sandbox: "", title: KIND_NAME[this.lang][kind], referrerpolicy: "no-referrer" }) as HTMLIFrameElement);
      this.frames.set(kind, frame);
      body.append(h("div", { class: "glpi-rt-draft-view" }, frame));
      actions.append(h("button", { type: "button", class: "btn btn-sm btn-outline-secondary", text: t.leave, onclick: () => this.unwatch() }));
    } else {
      actions.append(h("button", { type: "button", class: "btn btn-sm btn-outline-primary", onclick: () => this.watch(kind) }, icon("eye"), " ", t.join));
    }
    if (info.away) {
      actions.append(h("button", { type: "button", class: "btn btn-sm btn-primary", text: t.take, onclick: () => this.take(kind) }));
    }
    body.append(actions);
  }

  leftLabel(kind: DraftKind, info: DraftInfo): string {
    return TEXT[this.lang].left(info.writer?.name ?? "?", KIND_NAME[this.lang][kind]);
  }

  private watch(kind: DraftKind): void {
    if (this.watching && this.watching !== kind) this.unwatch();
    this.watching = kind;
    this.client.send({ t: "draft_watch", room: this.room, kind, on: true });
    this.onChange();
  }

  private unwatch(): void {
    if (!this.watching) return;
    this.client.send({ t: "draft_watch", room: this.room, kind: this.watching, on: false });
    this.frames.delete(this.watching);
    this.watching = null;
    this.onChange();
  }

  private take(kind: DraftKind): void {
    this.client.send({ t: "draft_take", room: this.room, kind });
  }

  private blockOf(kind: DraftKind): Element | null {
    for (const [cls, k] of Object.entries(DRAFT_BLOCKS)) {
      const el = this.doc.getElementById(`new-${cls}-block`);
      if (k === kind && el) return el;
    }
    return null;
  }

  private kindOf(block: Element): DraftKind | null {
    const m = block.id?.match(/^new-(\w+)-block$/);
    return m ? (DRAFT_BLOCKS[m[1]] ?? null) : null;
  }

  /** GLPI loads the answer form when the block opens: wait for its editor. */
  private editorIn(block: Element, timeoutMs = 10_000): Promise<Editor | null> {
    return findEditor(block, timeoutMs);
  }

  private async opened(block: Element): Promise<void> {
    const kind = this.kindOf(block);
    if (!kind) return;
    const holder = this.infos.get(kind)?.writer;
    const shared = !holder || holder.conn === this.client.conn;
    this.writing = { kind, block, shared };
    if (!shared) this.note(block, TEXT[this.lang].shared(holder!.name));
    const ed = await this.editorIn(block);
    if (!ed || this.writing?.block !== block) return;
    const schedule = () => {
      if (!this.writing?.shared) return;
      clearTimeout(this.writing.timer);
      this.writing.timer = setTimeout(() => this.share(), 700);
    };
    ed.on("input change keyup undo redo SetContent", schedule);
    block.querySelector("input[name='is_private']")?.addEventListener("change", schedule);
    // What was typed (or prefilled by a GLPI template) before we listened is shared too.
    schedule();
  }

  /** Sends our draft (we become its writer, or learn that someone else is). */
  private async share(): Promise<void> {
    const w = this.writing;
    if (!w?.shared) return;
    const ed = await this.editorIn(w.block, 0);
    const html = cleanHtml(ed?.getContent() ?? "");
    if (!html.trim()) return;
    const priv = !!w.block.querySelector<HTMLInputElement>("input[name='is_private']")?.checked;
    const id = this.client.send({ t: "draft", room: this.room, kind: w.kind, html, private: priv });
    this.pending.set(id, w.kind);
  }

  private stopWriting(): void {
    const w = this.writing;
    if (!w) return;
    clearTimeout(w.timer);
    if (w.shared) this.client.send({ t: "draft_end", room: this.room, kind: w.kind });
    this.writing = null;
  }

  /** After a takeover: open our own form with the draft, which is now ours. */
  private async continueWith(kind: DraftKind, html: string, priv: boolean): Promise<void> {
    if (this.watching === kind) this.unwatch();
    const block = this.blockOf(kind);
    if (!block) return;
    const bs = (globalThis as any).bootstrap;
    bs?.Collapse?.getOrCreateInstance?.(block, { toggle: false })?.show?.();
    const ed = await this.editorIn(block);
    if (!ed) return;
    ed.setContent(html);
    const box = block.querySelector<HTMLInputElement>("input[name='is_private']");
    if (box && box.checked !== priv) box.click();
    this.writing = { kind, block, shared: true };
    // A solution taken over brings its locks along (same rules: the writer was away).
    if (kind === "solution") {
      this.client.send({ t: "lock", room: this.room, scope: "solution", force: true });
      this.client.send({ t: "lock", room: this.room, force: true, reason: "solution" });
    }
  }

  private note(block: Element, text: string): void {
    const body = block.querySelector(".card-body") ?? block;
    let el = body.querySelector<HTMLElement>(".glpi-rt-draft-note");
    if (!el) {
      el = h("div", { class: "glpi-rt-draft-note", role: "status" });
      body.prepend(el);
    }
    el.textContent = text;
  }
}
