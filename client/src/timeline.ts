import { type DraftKind, SharedDrafts } from "./drafts.ts";
import { h, icon } from "./dom.ts";
import { noun } from "./updates.ts";
import { look } from "./presence.ts";
import type { Holder, PresenceUser } from "./protocol.ts";

/**
 * The ticket timeline, live:
 * - "Alice is writing a followup…" placeholders, from presence (`composing`);
 * - new, edited and deleted followups, tasks, solutions, approvals and documents appear
 *   without reloading: the tab is fetched again as GLPI renders it for this user (rights
 *   included) and only the timeline items that changed are inserted, replaced or removed;
 * - one solution at a time: writing one takes the `solution` lock, and the Solution button
 *   is disabled while someone else writes one or once one was proposed. GLPI enforces it
 *   too (the plugin refuses a second solution).
 */

type Lang = "fr" | "en";

/** Answer forms of GLPI's timeline (`#new-{Class}-block`) → `compose` kind. */
export const ANSWER_KINDS: Record<string, string> = {
  ITILFollowup: "followup",
  TicketTask: "task",
  ChangeTask: "task",
  ProblemTask: "task",
  ITILSolution: "solution",
  TicketValidation: "validation",
  ChangeValidation: "validation",
  Document_Item: "document",
};

/** Item events that change the timeline (the others change the fields). */
export const TIMELINE_EVENTS = /^(followup|task|solution|validation|document)\.(add|update|delete)$/;

const TEXT = {
  fr: {
    composing: {
      followup: (n: string) => `${n} rédige un suivi…`,
      task: (n: string) => `${n} rédige une tâche…`,
      solution: (n: string) => `${n} rédige une solution…`,
      validation: (n: string) => `${n} prépare une demande de validation…`,
      document: (n: string) => `${n} ajoute un document…`,
    } as Record<string, (n: string) => string>,
    solutionBusy: (n: string) => `${n} rédige déjà une solution.`,
    solutionDone: (n: string) => `${n} a déjà proposé une solution. Actualisez la page pour la voir.`,
    solutionLost: (n: string) => `${n} a pris la main sur la solution : la vôtre ne peut pas être enregistrée.`,
    fieldsBusy: (n: string, it: string) => `${n} modifie les champs de ${it} : attendez qu'il ait enregistré avant d'ajouter une solution ou de le mettre en attente.`,
  },
  en: {
    composing: {
      followup: (n: string) => `${n} is writing a followup…`,
      task: (n: string) => `${n} is writing a task…`,
      solution: (n: string) => `${n} is writing a solution…`,
      validation: (n: string) => `${n} is preparing an approval request…`,
      document: (n: string) => `${n} is adding a document…`,
    } as Record<string, (n: string) => string>,
    solutionBusy: (n: string) => `${n} is already writing a solution.`,
    solutionDone: (n: string) => `${n} already proposed a solution. Refresh the page to see it.`,
    solutionLost: (n: string) => `${n} took over the solution: yours cannot be saved.`,
    fieldsBusy: (n: string, it: string) => `${n} is editing the fields of ${it}: wait until they save before adding a solution or putting it on hold.`,
  },
};

export function langOf(raw: string): Lang {
  return raw.slice(0, 2).toLowerCase() === "fr" ? "fr" : "en";
}

const ITEM_SEL = ":scope > .timeline-item[data-itemtype][data-items-id]";

export function itemKey(el: Element): string {
  return `${el.getAttribute("data-itemtype")}:${el.getAttribute("data-items-id")}`;
}

/** Timeline entries (followups, tasks...), without the main description. */
function entries(timeline: Element): Element[] {
  return Array.from(timeline.querySelectorAll(ITEM_SEL)).filter((e) => !e.classList.contains("ITILContent"));
}

/** Newest first (user preference "reverse"): GLPI then puts the answer forms on top. */
export function isReversed(timeline: Element): boolean {
  const answer = timeline.querySelector(":scope > #new-itilobject-form");
  const content = timeline.querySelector(":scope > .ITILContent");
  return !!answer && !!content && !!(answer.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** Where new items appear: [parent, before]. */
function newItemsPlace(timeline: Element): [Element, Node | null] {
  const list = entries(timeline);
  const content = timeline.querySelector(":scope > .ITILContent");
  if (isReversed(timeline)) {
    const first = list[0] ?? content;
    return [timeline, first ?? null];
  }
  const last = list[list.length - 1] ?? content;
  return [timeline, last ? last.nextSibling : null];
}

export interface SyncResult {
  added: string[];
  replaced: string[];
  removed: string[];
}

export type SyncOp =
  | { op: "remove"; key: string }
  | { op: "replace"; key: string }
  /** After the entry `after` (a key already placed), or before the first one when null. */
  | { op: "insert"; key: string; after: string | null };

/**
 * What to do so that the page's timeline (`local`, keys in page order) shows what GLPI
 * renders now (`remote`): remove what GLPI no longer shows, replace `changed` entries,
 * insert new ones next to their neighbours. Entries being edited here and `fixed` ones
 * (the main description) are never removed or replaced.
 */
export function planSync(local: string[], remote: string[], changed: Set<string>, editing: Set<string>, fixed: Set<string>): SyncOp[] {
  const ops: SyncOp[] = [];
  const theirs = new Set(remote);
  const mine = new Set(local);
  for (const k of local) {
    if (!theirs.has(k) && !fixed.has(k) && !editing.has(k)) {
      ops.push({ op: "remove", key: k });
      mine.delete(k);
    }
  }
  let prev: string | null = null;
  for (const k of remote) {
    if (mine.has(k)) {
      if (changed.has(k) && !editing.has(k) && !fixed.has(k)) ops.push({ op: "replace", key: k });
    } else {
      ops.push({ op: "insert", key: k, after: prev });
    }
    prev = k;
  }
  return ops;
}

/**
 * Applies planSync() to the DOM. `insert` puts HTML after or before a node (jQuery in
 * GLPI, so that the inline scripts of timeline items run) and returns the new item.
 */
export function syncTimeline(
  local: Element,
  remote: Element,
  changed: Set<string>,
  insert: (html: string, where: { after?: Element; before?: Node | null; parent: Element }) => Element | null,
): SyncResult {
  const res: SyncResult = { added: [], replaced: [], removed: [] };
  const els = new Map<string, Element>();
  const localKeys: string[] = [];
  const editing = new Set<string>();
  const fixed = new Set<string>();
  for (const el of Array.from(local.querySelectorAll(ITEM_SEL))) {
    const k = itemKey(el);
    els.set(k, el);
    localKeys.push(k);
    if (el.querySelector(".edit-content.show")) editing.add(k);
    if (el.classList.contains("ITILContent")) fixed.add(k);
  }
  const html = new Map<string, string>();
  for (const el of Array.from(remote.querySelectorAll(ITEM_SEL))) html.set(itemKey(el), el.outerHTML);

  for (const op of planSync(localKeys, [...html.keys()], changed, editing, fixed)) {
    if (op.op === "remove") {
      els.get(op.key)?.remove();
      els.delete(op.key);
      res.removed.push(op.key);
      continue;
    }
    const where =
      op.op === "replace"
        ? { after: els.get(op.key)!, parent: local }
        : op.after && els.has(op.after)
          ? { after: els.get(op.after)!, parent: local }
          : { before: local.querySelector(ITEM_SEL), parent: local };
    const fresh = insert(html.get(op.key)!, where);
    if (!fresh) continue;
    fresh.classList.add("glpi-rt-new");
    if (op.op === "replace") {
      els.get(op.key)?.remove();
      res.replaced.push(op.key);
    } else {
      res.added.push(op.key);
    }
    els.set(op.key, fresh);
  }
  return res;
}

const STYLE = `
.glpi-rt-composing .timeline-content { border-style:dashed; opacity:.85; }
.glpi-rt-composing .glpi-rt-dots::after { content:"…"; animation:glpi-rt-dots 1.2s steps(4) infinite; display:inline-block; width:1.2em; overflow:hidden; vertical-align:bottom; }
@keyframes glpi-rt-dots { 0% { width:0 } 100% { width:1.2em } }
.glpi-rt-composing .glpi-rt-avatar { width:2.5rem; height:2.5rem; border-radius:50%; display:inline-flex; align-items:center; justify-content:center;
  font-weight:600; background-size:cover; background-position:center; }
.timeline-item.glpi-rt-new { animation:glpi-rt-new 2.5s ease-out; }
@keyframes glpi-rt-new { 0% { box-shadow:0 0 0 3px var(--tblr-primary, #206bc4); border-radius:6px; } 100% { box-shadow:none; } }
.glpi-rt-solution-note { font-size:.8rem; color:var(--tblr-warning, #f59f00); margin:.25rem 0; }
`;

export interface TimelineClient {
  conn: string | null;
  user: { id: number; name: string } | null;
  lockTtl: number;
  lock(room: string, force?: boolean, scope?: "fields" | "solution", reason?: "solution" | "pending"): void;
  unlock(room: string, scope?: "fields" | "solution"): void;
  compose(room: string, kind: string | null): void;
  on(type: string, h: (msg: any) => void): () => void;
}

export class LiveTimeline {
  private readonly doc: Document;
  private readonly client: TimelineClient;
  private readonly room: string;
  private readonly t: (typeof TEXT)["en"];
  private composing: string | null = null;
  private solutionHolder: Holder | null = null;
  /** Who holds the item's fields (step 4 lock). */
  private fieldsHolder: Holder | null = null;
  /** We hold the fields for an answer that changes the status. */
  private heldFor: "solution" | "pending" | null = null;
  /** "ce ticket", "this change"... */
  private readonly it: string;
  private solutionDoneBy: string | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private users: PresenceUser[] = [];
  /** Shared answer drafts (step 5): Join / Take over on the placeholders. */
  readonly drafts: SharedDrafts;

  constructor(doc: Document, client: TimelineClient, room: string, lang: string) {
    this.doc = doc;
    this.client = client;
    this.room = room;
    this.t = TEXT[langOf(lang)];
    this.it = noun(room.split(":")[0], langOf(lang)).this;
    this.drafts = new SharedDrafts(doc, client as any, room, lang);
    // "Put on hold" changes the status like a solution: the fields must be free.
    doc.addEventListener("change", (e) => this.onPending(e.target as Element), true);
    this.drafts.onChange = () => this.renderComposing();
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head.appendChild(style);

    // Bootstrap's collapse events bubble: GLPI's answer blocks open and close.
    doc.addEventListener("shown.bs.collapse", (e) => this.onAnswer(e.target as Element, true));
    doc.addEventListener("hidden.bs.collapse", (e) => this.onAnswer(e.target as Element, false));
    doc.addEventListener("submit", (e) => this.onSubmit(e), true);
    doc.addEventListener("click", (e) => this.onClick(e), true);

    client.on("presence", (m) => {
      if (m.room !== room) return;
      this.users = m.users;
      this.renderComposing();
    });
    client.on("lock", (m) => {
      if (m.room === room && m.scope === "fields") {
        this.fieldsHolder = m.holder;
        this.applySolution();
        return;
      }
      if (m.room !== room || m.scope !== "solution") return;
      const wasMine = this.solutionHolder?.conn === client.conn && !!client.conn;
      this.solutionHolder = m.holder;
      if (wasMine && m.holder && m.holder.conn !== client.conn) this.note(this.t.solutionLost(m.holder.name));
      this.applySolution();
    });
    client.on("event", (m) => {
      if (m.room !== room || !TIMELINE_EVENTS.test(m.kind)) return;
      if (m.kind === "solution.add" && m.by.id !== client.user?.id) {
        this.solutionDoneBy = m.by.name || "GLPI";
        this.applySolution();
      }
      if (m.item) this.pending.add(`${m.item.type}:${m.item.id}`);
      this.schedule();
    });
    client.on("subscribed", (m) => {
      // Reconnected: tell again what we are writing.
      if (m.room === room && this.composing) {
        client.compose(room, this.composing);
        if (this.composing === "solution") client.lock(room, false, "solution");
        if (this.heldFor) client.lock(room, false, "fields", this.heldFor);
      }
    });
    const renew = () => {
      if (this.composing === "solution") client.lock(room, false, "solution");
      if (this.heldFor) client.lock(room, false, "fields", this.heldFor);
      setTimeout(renew, Math.max(1, client.lockTtl / 3) * 1000);
    };
    setTimeout(renew, Math.max(1, client.lockTtl / 3) * 1000);
  }

  private timeline(): Element | null {
    return this.doc.querySelector(".itil-timeline");
  }

  private kindOf(block: Element | null): string | null {
    const m = block?.id.match(/^new-(\w+)-block$/);
    return m ? (ANSWER_KINDS[m[1]] ?? null) : null;
  }

  private onAnswer(target: Element, shown: boolean): void {
    const kind = this.kindOf(target);
    if (!kind) return;
    if (shown) {
      this.composing = kind;
      this.client.compose(this.room, kind);
      if (kind === "solution") {
        this.client.lock(this.room, false, "solution");
        this.holdFields("solution");
      }
      // GLPI loads the form after the block opens; "on hold" may be checked by default.
      for (const ms of [300, 1000, 2500]) setTimeout(() => this.checkPending(target), ms);
    } else if (this.composing === kind) {
      this.done();
    }
  }

  private done(): void {
    if (this.composing === "solution") this.client.unlock(this.room, "solution");
    this.releaseFields();
    this.composing = null;
    this.client.compose(this.room, null);
  }

  private onSubmit(e: Event): void {
    const form = e.target as Element;
    const block = form.closest?.("[id^='new-'][id$='-block']");
    const kind = this.kindOf(block ?? null);
    if (!kind) return;
    if (kind === "solution" && !this.solutionFree()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.applySolution();
      return;
    }
    // Saved: the page reloads; nothing more to show to the others.
    this.client.compose(this.room, null);
  }

  /** The Solution button while someone else writes one, or once one was proposed. */
  private onClick(e: Event): void {
    const btn = (e.target as Element).closest?.("[data-bs-target='#new-ITILSolution-block']");
    if (!btn || this.solutionFree() || btn.closest("#new-ITILSolution-block")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.applySolution();
  }

  private solutionFree(): boolean {
    const h = this.solutionHolder;
    return !this.solutionDoneBy && (!h || h.conn === this.client.conn) && !this.fieldsBusy();
  }

  /** Someone else holds the fields: no status change may be prepared meanwhile. */
  private fieldsBusy(): boolean {
    const h = this.fieldsHolder;
    return !!h && h.conn !== this.client.conn;
  }

  /** Holds the fields for an answer that changes the status. False when someone else has them. */
  private holdFields(reason: "solution" | "pending"): boolean {
    if (this.fieldsBusy()) return false;
    this.heldFor = reason;
    this.client.lock(this.room, false, "fields", reason);
    return true;
  }

  private releaseFields(): void {
    if (!this.heldFor) return;
    this.heldFor = null;
    this.client.unlock(this.room, "fields");
  }

  /** The "Put on hold" switch of a followup or task being written. */
  private onPending(el: Element | null): void {
    if (!(el instanceof HTMLInputElement) || el.name !== "pending" || el.type !== "checkbox") return;
    const block = el.closest("[id^='new-'][id$='-block']");
    if (!block) return;
    if (el.checked) {
      if (!this.holdFields("pending")) {
        el.click(); // unchecks it, and closes GLPI's pending reasons
        this.blockNote(block, this.t.fieldsBusy(this.fieldsHolder?.name ?? "", this.it));
      }
    } else if (this.heldFor === "pending") {
      this.releaseFields();
    }
  }

  private checkPending(block: Element): void {
    const box = block.querySelector<HTMLInputElement>("input[type=checkbox][name='pending']");
    if (box?.checked && this.heldFor !== "pending" && block.classList.contains("show")) this.onPending(box);
  }

  private blockNote(block: Element, text: string): void {
    const body = block.querySelector(".card-body") ?? block;
    let el = body.querySelector<HTMLElement>(".glpi-rt-solution-note");
    if (!el) {
      el = h("div", { class: "glpi-rt-solution-note", role: "status" });
      body.prepend(el);
    }
    el.textContent = text;
  }

  private note(text: string): void {
    const block = this.doc.getElementById("new-ITILSolution-block");
    const target = block?.querySelector(".card-body") ?? null;
    let el = this.doc.getElementById("glpi-rt-solution-note");
    if (!text) return el?.remove();
    if (!el) el = h("div", { id: "glpi-rt-solution-note", class: "glpi-rt-solution-note", role: "status" });
    el.textContent = text;
    if (target && !target.contains(el)) target.prepend(el);
  }

  private applySolution(): void {
    const h = this.solutionHolder;
    const other = h && h.conn !== this.client.conn ? h.name : null;
    const fields = this.fieldsBusy() ? this.fieldsHolder!.name : null;
    const why = this.solutionDoneBy
      ? this.t.solutionDone(this.solutionDoneBy)
      : other
        ? this.t.solutionBusy(other)
        : fields
          ? this.t.fieldsBusy(fields, this.it)
          : "";
    this.doc.querySelectorAll<HTMLElement>("[data-bs-target='#new-ITILSolution-block']").forEach((b) => {
      if (b.closest("#new-ITILSolution-block")) return; // its own close button
      b.classList.toggle("disabled", !!why);
      b.setAttribute("aria-disabled", String(!!why));
      if (why) b.title = why;
      else b.removeAttribute("title");
    });
    // Already writing one: keep the text, but it cannot be saved.
    this.doc.querySelectorAll<HTMLButtonElement>("#new-ITILSolution-block button[type=submit]").forEach((b) => (b.disabled = !!why));
    this.note(why);
  }

  /** One placeholder per other user writing something here, and per draft left behind. */
  private renderComposing(): void {
    const timeline = this.timeline();
    if (!timeline) return;
    const writers = this.users.filter((u) => u.composing && u.id !== this.client.user?.id);
    const existing = new Map<string, Element>();
    timeline.querySelectorAll(":scope > .glpi-rt-composing:not(.glpi-rt-draft-left)").forEach((el) => existing.set((el as HTMLElement).dataset.uid!, el));
    for (const u of writers) {
      const text = (this.t.composing[u.composing!] ?? this.t.composing.followup)(u.name).replace(/…$/, "");
      let el = existing.get(String(u.id)) as HTMLElement | undefined;
      existing.delete(String(u.id));
      if (!el) {
        el = h("div", { class: "timeline-item mb-3 glpi-rt-composing", "data-uid": String(u.id), "aria-live": "polite" });
        const [parent, before] = newItemsPlace(timeline);
        parent.insertBefore(el, before);
      }
      const l = look(u);
      const avatar = h("span", { class: "glpi-rt-avatar", "aria-hidden": "true", text: l.text });
      avatar.style.backgroundImage = l.picture ? `url("${l.picture}")` : "";
      avatar.style.backgroundColor = l.picture ? "transparent" : l.bg;
      avatar.style.color = l.fg;
      el.replaceChildren(
        h("div", { class: "row" },
          h("div", { class: "col-auto d-flex flex-column" }, avatar),
          h("div", { class: "col-12 col-sm" },
            h("div", { class: "mt-2 timeline-content card" },
              h("div", { class: "card-body px-3 py-2 text-secondary" }, icon("pencil"), " ", h("span", { class: "glpi-rt-dots", text })),
            ),
          ),
        ),
      );
    }
    for (const el of existing.values()) el.remove();

    // Join / Take over on shared drafts (followups, tasks, solutions).
    for (const u of writers) {
      const el = timeline.querySelector<HTMLElement>(`:scope > .glpi-rt-composing[data-uid="${u.id}"]`);
      if (el && ["followup", "task", "solution"].includes(u.composing!)) this.drafts.decorate(el, u.composing as DraftKind, u.id);
    }
    const left = this.drafts.leftBehind().filter(([, i]) => !writers.some((u) => u.id === i.writer?.id));
    const keep = new Set(left.map(([k]) => k));
    timeline.querySelectorAll<HTMLElement>(":scope > .glpi-rt-draft-left").forEach((el) => {
      if (!keep.has(el.dataset.kind as DraftKind)) el.remove();
    });
    for (const [kind, info] of left) {
      let el = timeline.querySelector<HTMLElement>(`:scope > .glpi-rt-draft-left[data-kind="${kind}"]`);
      if (!el) {
        el = h("div", { class: "timeline-item mb-3 glpi-rt-composing glpi-rt-draft-left", "data-kind": kind });
        const [parent, before] = newItemsPlace(timeline);
        parent.insertBefore(el, before);
      }
      el.replaceChildren(
        h("div", { class: "mt-2 timeline-content card" },
          h("div", { class: "card-body px-3 py-2 text-secondary" }, icon("file-text"), " ", this.drafts.leftLabel(kind, info)),
        ),
      );
      this.drafts.decorate(el, kind, info.writer!.id);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 400);
  }

  /** Fetches the tab as GLPI renders it now and merges its timeline into the page. */
  async refresh(): Promise<SyncResult | null> {
    const timeline = this.timeline();
    const pane = timeline?.closest(".tab-pane");
    const link = pane?.id ? this.doc.querySelector<HTMLElement>(`a[data-bs-target="#${CSS.escape(pane.id)}"][data-glpi-ajax-content]`) : null;
    const url = link?.dataset.glpiAjaxContent;
    if (!timeline || !url) return null;
    const changed = this.pending;
    this.pending = new Set();
    const resp = await fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } }).catch(() => null);
    if (!resp?.ok) return null;
    const remote = new DOMParser().parseFromString(await resp.text(), "text/html").querySelector(".itil-timeline");
    if (!remote) return null;
    const $ = (globalThis as any).jQuery;
    const res = syncTimeline(timeline, remote, changed, (html, where) => {
      // jQuery runs the inline scripts GLPI puts in timeline items (rich text, tooltips).
      if ($) {
        const nodes = $($.parseHTML(html, this.doc, true));
        if (where.after) $(where.after).after(nodes);
        else if (where.before) $(where.before).before(nodes);
        else $(where.parent).prepend(nodes);
        return nodes.filter(".timeline-item")[0] ?? null;
      }
      const tpl = this.doc.createElement("template");
      tpl.innerHTML = html;
      const el = tpl.content.firstElementChild;
      if (!el) return null;
      if (where.after) where.after.after(el);
      else where.parent.insertBefore(el, where.before ?? where.parent.firstChild);
      return el;
    });
    // Placeholders stay where new items go.
    this.renderComposing();
    return res;
  }
}
