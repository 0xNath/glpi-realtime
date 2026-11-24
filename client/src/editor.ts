import { register } from "./i18n.ts";
import { h, icon } from "./dom.ts";
import type { Holder, PresenceUser } from "./protocol.ts";
import { noun } from "./updates.ts";

/**
 * Single editor of an item's fields (step 4). Tickets, changes and problems: the
 * right-hand fields panel (`form#itil-form`, its Save button) and the title/description
 * edit of the main item; the timeline (followups, tasks, solutions) stays free. Other items
 * (projects, assets...): their main form.
 *
 * - The first edit (focus, typing, a select2 opening) takes the lock; it is renewed while
 *   editing and released after a minute without input (if nothing is left unsaved). The
 *   page reload after Save, or closing the tab, releases it on the server.
 * - Others see the fields disabled and who edits; they may take over only when the
 *   editor's tab is inactive (the server checks).
 * - Once someone else changed the ticket, fields stay read-only until the page is
 *   refreshed: nobody saves values older than what is in GLPI.
 */

/** Events that change what the fields panel shows. */
const FIELD_EVENTS = /^(item\.(update|delete|restore|purge)|actor\.(add|update|delete))$/;

/** Without input for this long and nothing unsaved, the lock is released. */
export const IDLE_MS = 60_000;

export type Mode = "free" | "mine" | "mine-stale" | "other" | "stale" | "lost";

export class EditorState {
  holder: Holder | null = null;
  conn: string | null = null;
  selfId: number | undefined;
  /** Someone else changed the ticket since the page was loaded. */
  stale = false;
  staleBy = "";
  /** Our lock was taken over. */
  lost = false;
  dirty = false;
  lastInput = 0;
  /** The server refused the lock (no update right): never take it, still respect others'. */
  forbidden = false;

  mine(): boolean {
    return !!this.holder && this.holder.conn === this.conn;
  }

  onLock(holder: Holder | null): void {
    if (this.mine() && holder?.conn !== this.conn && holder !== null) this.lost = true;
    this.holder = holder;
  }

  onEvent(kind: string, by: { id: number; name: string }): void {
    if (!FIELD_EVENTS.test(kind)) return;
    // Our own save from this tab reloads the page; anything else changed the values.
    if (this.mine() && by.id === this.selfId && by.id !== 0) return;
    this.stale = true;
    this.staleBy = by.name;
  }

  mode(): Mode {
    if (this.lost) return "lost";
    if (this.mine()) return this.stale ? "mine-stale" : "mine";
    if (this.holder) return "other";
    return this.stale ? "stale" : "free";
  }

  canEdit(): boolean {
    return ["free", "mine", "mine-stale"].includes(this.mode());
  }

  /** What to tell the server on each keepalive tick. */
  tick(now: number, focused: boolean): "renew" | "release" | null {
    // Held for a solution or a pending answer: the timeline renews and releases it.
    if (!this.mine() || this.holder?.reason) return null;
    return this.dirty || focused || now - this.lastInput < IDLE_MS ? "renew" : "release";
  }
}

const TEXT = register("editor", {
  fr: {
    other: (n: string, since: string, it: string) => `${n} modifie les champs de ${it} ${since}.`,
    solution: (n: string, it: string) => `${n} ajoute une solution : le statut de ${it} va changer, ses champs sont bloqués jusqu'à l'envoi.`,
    pending: (n: string, it: string) => `${n} met ${it} en attente : ses champs sont bloqués jusqu'à l'envoi.`,
    takeOver: "Prendre la main",
    stale: (n: string, it: string) => `${n || "Quelqu'un"} a modifié ${it}. Actualisez avant de modifier ses champs.`,
    mineStale: (n: string, it: string) => `${n || "Quelqu'un"} a modifié ${it} pendant votre saisie : vérifiez avant d'enregistrer.`,
    lost: (n: string) => `${n} a pris la main sur les champs. Vos modifications non enregistrées ne peuvent plus être enregistrées.`,
    refresh: "Actualiser",
    since: (m: number) => (m < 1 ? "depuis un instant" : `depuis ${m} min`),
  },
  en: {
    other: (n: string, since: string, it: string) => `${n} has been editing the fields of ${it} ${since}.`,
    solution: (n: string, it: string) => `${n} is adding a solution: the status of ${it} will change, its fields are locked until it is sent.`,
    pending: (n: string, it: string) => `${n} is putting ${it} on hold: its fields are locked until it is sent.`,
    takeOver: "Take over",
    stale: (n: string, it: string) => `${n || "Someone"} changed ${it}. Refresh before editing its fields.`,
    mineStale: (n: string, it: string) => `${n || "Someone"} changed ${it} while you were editing: check before saving.`,
    lost: (n: string) => `${n} took over the fields. Your unsaved changes can no longer be saved.`,
    refresh: "Refresh",
    since: (m: number) => (m < 1 ? "for a moment" : `for ${m} min`),
  },
});

const CONTROLS = "input, select, textarea, [contenteditable=''], [contenteditable=true], .select2-selection, .edit-timeline-item";

const CSS = `
.glpi-rt-editor { margin:.5rem; padding:.5rem .75rem; border-radius:var(--tblr-border-radius, 4px); display:flex; gap:.5rem;
  align-items:center; flex-wrap:wrap; font-size:.85rem; background:var(--tblr-warning-lt, #fdf3e3); border:1px solid var(--tblr-warning, #f59f00); }
.glpi-rt-editor[hidden] { display:none; }
.glpi-rt-editor .glpi-rt-editor-text { flex:1 1 12rem; }
.glpi-rt-editor.is-flash { animation:glpi-rt-flash .6s; }
@keyframes glpi-rt-flash { 50% { box-shadow:0 0 0 4px var(--tblr-warning, #f59f00); } }
.glpi-rt-fields-locked .ITILContent .timeline-item-buttons { visibility:hidden; }
`;

/** The form whose fields have a single editor. */
export interface FormTarget {
  form(): HTMLFormElement | null;
  /** Its Save buttons outside the form (`form="…"` attribute). */
  outside(): Element[];
  /** Whether an element is one of the locked fields or buttons. */
  contains(el: Element): boolean;
}

/** Tickets, changes, problems: the fields panel, and the description's edit buttons. */
export function itilTarget(doc: Document): FormTarget {
  return {
    form: () => doc.getElementById("itil-form") as HTMLFormElement | null,
    outside: () => Array.from(doc.querySelectorAll("button[form='itil-form']")),
    contains: (el) =>
      !!el.closest("#itil-form") ||
      el.matches("button[form='itil-form']") ||
      !!el.closest("button[form='itil-form']") ||
      !!el.closest(".ITILContent .timeline-item-buttons, .ITILContent .edit-content"),
  };
}

/**
 * Other items: the form that saves this very item (its `id` field, a Save button). Its
 * `form.id` cannot be used: GLPI's forms hold an input named "id", which hides it.
 */
export function itemTarget(doc: Document, room: string): FormTarget {
  const id = room.slice(room.lastIndexOf(":") + 1);
  const form = (): HTMLFormElement | null =>
    Array.from(doc.querySelectorAll("form")).find((f) => {
      const field = f.querySelector<HTMLInputElement>(":scope input[name='id']");
      return field?.value === id && !!f.querySelector("button[name='update'], input[name='update']");
    }) ?? null;
  return {
    form,
    outside: () => {
      const name = form()?.getAttribute("id");
      return name ? Array.from(doc.querySelectorAll(`button[form="${attr(name)}"]`)) : [];
    },
    contains: (el) => {
      const f = form();
      if (!f) return false;
      const name = f.getAttribute("id");
      return f.contains(el) || (!!name && !!el.closest(`button[form="${attr(name)}"]`));
    },
  };
}

/** A value inside a double-quoted attribute selector. */
function attr(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

/** The form of a room: tickets, changes and problems have their own. */
export function targetFor(doc: Document, room: string): FormTarget {
  return ["Ticket", "Change", "Problem"].includes(room.split(":")[0]) ? itilTarget(doc) : itemTarget(doc, room);
}

export interface EditorClient {
  conn: string | null;
  user: { id: number } | null;
  /** Lifetime of a lock on the server, seconds (from `hello`). */
  lockTtl: number;
  lock(room: string, force?: boolean): void;
  unlock(room: string): void;
  lockOf(room: string): Holder | null;
  on(type: string, h: (msg: any) => void): () => void;
}

/** DOM side: intercepts edits, disables fields, shows who edits. */
export class FieldsEditor {
  readonly state = new EditorState();
  private readonly doc: Document;
  private readonly client: EditorClient;
  private readonly room: string;
  private readonly t: (typeof TEXT)["en"];
  /** "ce ticket", "this change"... */
  private readonly it: string;
  private readonly bar: HTMLElement;
  private holderActive = true;
  private disabled: HTMLElement[] = [];
  /** The form the bar and disabled fields belong to (GLPI may reload it). */
  private formEl: HTMLFormElement | null = null;
  private readonly target: FormTarget;

  constructor(doc: Document, client: EditorClient, room: string, lang: string, target: FormTarget = targetFor(doc, room)) {
    this.doc = doc;
    this.target = target;
    this.client = client;
    this.room = room;
    const code = lang.slice(0, 2).toLowerCase() === "fr" ? "fr" : "en";
    this.t = TEXT[code];
    this.it = noun(room.split(":")[0], code).this;
    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.appendChild(style);
    this.bar = h("div", { class: "glpi-rt-editor", role: "status", hidden: true });
    // The lock state may have arrived before the form did.
    this.state.conn = client.conn;
    this.state.onLock(client.lockOf(room));
    this.attach();

    for (const type of ["focusin", "mousedown", "keydown", "input", "change", "click", "paste"]) {
      doc.addEventListener(type, (e) => this.intent(e), true);
    }
    client.on("lock", (m) => {
      if (m.room !== this.room || (m.scope ?? "fields") !== "fields") return;
      this.state.conn = this.client.conn;
      if (m.id !== undefined && m.holder && m.holder.conn !== this.client.conn) {
        // We asked and someone else has it: our edit started at the same time as theirs.
        this.flash();
      }
      this.state.onLock(m.holder);
      this.apply();
    });
    client.on("error", (m) => {
      if (m.code === "forbidden" && m.message === "cannot edit this item") this.state.forbidden = true;
    });
    client.on("event", (m) => {
      if (m.room !== this.room) return;
      this.state.selfId = this.client.user?.id;
      this.state.onEvent(m.kind, m.by);
      this.apply();
    });
    client.on("presence", (m) => {
      if (m.room !== this.room) return;
      const u = (m.users as PresenceUser[]).find((x) => x.id === this.state.holder?.id);
      this.holderActive = u ? u.active : false;
      this.apply();
    });
    // Reconnected while editing: the server released our lock with the old connection.
    client.on("subscribed", (m) => {
      if (m.room === this.room && this.state.dirty && !this.state.lost) this.client.lock(this.room);
    });
    // Renewed every third of its lifetime: one lost message never loses the lock.
    const tick = () => {
      const focused = !!this.form()?.contains(doc.activeElement) && doc.hasFocus();
      const action = this.state.tick(Date.now(), focused);
      if (action === "renew") this.client.lock(this.room);
      else if (action === "release") this.client.unlock(this.room);
      setTimeout(tick, Math.max(1, this.client.lockTtl / 3) * 1000);
    };
    setTimeout(tick, Math.max(1, this.client.lockTtl / 3) * 1000);
  }

  private form(): HTMLFormElement | null {
    return this.target.form();
  }

  /** Whether an event target belongs to the locked fields. */
  private inFields(el: Element): boolean {
    if (el.closest(".accordion-button, .accordion-header")) return false; // opening sections is reading
    return this.target.contains(el);
  }

  private intent(e: Event): void {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !this.inFields(el)) return;
    const control = el.closest(CONTROLS) ?? el.closest("button[type=submit], input[type=submit], button[form]");
    if (!control) return;
    if (!this.state.canEdit()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (el instanceof HTMLElement) el.blur();
      this.flash();
      return;
    }
    if (e.type === "input" || e.type === "change" || e.type === "paste") this.state.dirty = true;
    this.state.lastInput = Date.now();
    if (!this.state.mine() && !this.state.forbidden) this.client.lock(this.room);
  }

  private flash(): void {
    this.bar.classList.remove("is-flash");
    void this.bar.offsetWidth;
    this.bar.classList.add("is-flash");
  }

  /**
   * Follows the form: GLPI loads the ticket tab after the page, and reloads it (tabs,
   * reloadTab()). A new form gets the bar and, if needed, its fields disabled again.
   */
  attach(): void {
    const form = this.form();
    if (form === this.formEl && (!form || this.bar.isConnected)) return;
    this.formEl = form;
    this.disabled = []; // those were in the old form
    if (form) form.parentElement?.insertBefore(this.bar, form);
    this.apply();
  }

  private apply(): void {
    const mode = this.state.mode();
    const blocked = !this.state.canEdit();
    this.setDisabled(blocked);
    this.doc.body.classList.toggle("glpi-rt-fields-locked", blocked);
    const t = this.t;
    const holder = this.state.holder;
    const children: Array<Node | string> = [];
    const refresh = () =>
      h("button", { type: "button", class: "btn btn-sm btn-primary", text: t.refresh, onclick: () => this.doc.defaultView?.location.reload() });
    switch (mode) {
      case "other": {
        const minutes = Math.floor((Date.now() / 1000 - (holder?.since ?? 0)) / 60);
        const name = holder?.name ?? "";
        const text = holder?.reason === "solution" ? t.solution(name, this.it) : holder?.reason === "pending" ? t.pending(name, this.it) : t.other(name, t.since(minutes), this.it);
        children.push(icon("lock"), h("span", { class: "glpi-rt-editor-text", text }));
        // Held for an answer being written: taking it over would change the status under them.
        if (!this.holderActive && !holder?.reason) {
          children.push(h("button", { type: "button", class: "btn btn-sm btn-outline-warning", text: t.takeOver, onclick: () => this.client.lock(this.room, true) }));
        }
        break;
      }
      case "stale":
        children.push(icon("refresh"), h("span", { class: "glpi-rt-editor-text", text: t.stale(this.state.staleBy, this.it) }), refresh());
        break;
      case "mine-stale":
        children.push(icon("alert-triangle"), h("span", { class: "glpi-rt-editor-text", text: t.mineStale(this.state.staleBy, this.it) }), refresh());
        break;
      case "lost":
        children.push(icon("lock"), h("span", { class: "glpi-rt-editor-text", text: t.lost(holder?.name ?? "") }), refresh());
        break;
    }
    this.bar.replaceChildren(...children);
    this.bar.hidden = children.length === 0;
  }

  /** Disables the fields (and Save) while someone else edits; restores exactly what we changed. */
  private setDisabled(on: boolean): void {
    if (!on) {
      for (const el of this.disabled) (el as HTMLInputElement).disabled = false;
      this.disabled = [];
      return;
    }
    if (this.disabled.length) return;
    const form = this.form();
    if (!form) return;
    const els = [
      ...Array.from(form.elements),
      ...this.target.outside(),
    ] as HTMLInputElement[];
    for (const el of els) {
      if (el.disabled || el.closest(".accordion-header") || el.type === "hidden") continue;
      el.disabled = true; // select2 follows its <select>
      this.disabled.push(el);
    }
  }
}
