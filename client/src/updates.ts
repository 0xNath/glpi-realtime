import type { Actor, ItemEvent } from "./protocol.ts";

/**
 * "Bob added a followup · Refresh": shown on the item when someone else changes it.
 * Events carry no content, and the page may hold unsaved input: we never reload by
 * ourselves, the user decides.
 */

type Lang = "fr" | "en";

/** "le ticket", "this change"...: every message names the kind of item it is about. */
const NOUNS: Record<Lang, Record<string, { the: string; this: string }>> = {
  fr: {
    Ticket: { the: "le ticket", this: "ce ticket" },
    Change: { the: "le changement", this: "ce changement" },
    Problem: { the: "le problème", this: "ce problème" },
  },
  en: {
    Ticket: { the: "the ticket", this: "this ticket" },
    Change: { the: "the change", this: "this change" },
    Problem: { the: "the problem", this: "this problem" },
  },
};

export function noun(itemtype: string, l: Lang): { the: string; this: string } {
  return NOUNS[l][itemtype] ?? NOUNS[l].Ticket;
}

/** Changes of the item itself; `%` is replaced by its noun ("le ticket"). */
const ITEM_ACTIONS: Record<Lang, Record<string, string>> = {
  fr: { "item.update": "a modifié %", "item.delete": "a mis % à la corbeille", "item.restore": "a restauré %", "item.purge": "a supprimé %" },
  en: { "item.update": "updated %", "item.delete": "moved % to the trash", "item.restore": "restored %", "item.purge": "deleted %" },
};

const ACTIONS: Record<Lang, Record<string, string>> = {
  fr: {
    "followup.add": "a ajouté un suivi",
    "followup.update": "a modifié un suivi",
    "followup.delete": "a supprimé un suivi",
    "task.add": "a ajouté une tâche",
    "task.update": "a modifié une tâche",
    "task.delete": "a supprimé une tâche",
    "solution.add": "a proposé une solution",
    "solution.update": "a mis à jour la solution",
    "solution.delete": "a supprimé la solution",
    "validation.add": "a demandé une validation",
    "validation.update": "a mis à jour une validation",
    "validation.delete": "a supprimé une validation",
    "document.add": "a joint un document",
    "document.delete": "a retiré un document",
    "actor.add": "a ajouté un acteur",
    "actor.update": "a modifié un acteur",
    "actor.delete": "a retiré un acteur",
  },
  en: {
    "followup.add": "added a followup",
    "followup.update": "edited a followup",
    "followup.delete": "deleted a followup",
    "task.add": "added a task",
    "task.update": "edited a task",
    "task.delete": "deleted a task",
    "solution.add": "proposed a solution",
    "solution.update": "updated the solution",
    "solution.delete": "deleted the solution",
    "validation.add": "requested an approval",
    "validation.update": "updated an approval",
    "validation.delete": "deleted an approval",
    "document.add": "attached a document",
    "document.delete": "removed a document",
    "actor.add": "added an actor",
    "actor.update": "changed an actor",
    "actor.delete": "removed an actor",
  },
};

/** Names of the ticket fields users care about, for `item.update`. */
const FIELDS: Record<Lang, Record<string, string>> = {
  fr: {
    status: "le statut",
    priority: "la priorité",
    urgency: "l'urgence",
    impact: "l'impact",
    name: "le titre",
    content: "la description",
    itilcategories_id: "la catégorie",
    type: "le type",
    time_to_resolve: "l'échéance",
    locations_id: "le lieu",
    entities_id: "l'entité",
  },
  en: {
    status: "the status",
    priority: "the priority",
    urgency: "the urgency",
    impact: "the impact",
    name: "the title",
    content: "the description",
    itilcategories_id: "the category",
    type: "the type",
    time_to_resolve: "the due date",
    locations_id: "the location",
    entities_id: "the entity",
  },
};

const TEXT = {
  fr: {
    you: "Vous",
    glpi: "GLPI",
    changed: (what: string) => `a modifié ${what}`,
    and: " et ",
    more: (n: number) => ` (+${n} autre${n > 1 ? "s" : ""} modification${n > 1 ? "s" : ""})`,
    refresh: "Actualiser",
    dismiss: "Masquer",
    lost: (n: string) => `Vous n'avez plus accès à ${n}.`,
  },
  en: {
    you: "You",
    glpi: "GLPI",
    changed: (what: string) => `changed ${what}`,
    and: " and ",
    more: (n: number) => ` (+${n} more change${n > 1 ? "s" : ""})`,
    refresh: "Refresh",
    dismiss: "Dismiss",
    lost: (n: string) => `You no longer have access to ${n}.`,
  },
};

export function lang(raw: string): Lang {
  return raw.slice(0, 2).toLowerCase() === "fr" ? "fr" : "en";
}

export function who(by: Actor, selfId: number | undefined, l: Lang): string {
  if (by.id === 0) return TEXT[l].glpi;
  if (by.id === selfId) return TEXT[l].you;
  return by.name || `#${by.id}`;
}

/** One sentence for one event: "Bob changed the status and the priority". */
export function describe(ev: ItemEvent & { by: Actor }, selfId: number | undefined, l: Lang, itemtype = "Ticket"): string {
  const own = ITEM_ACTIONS[l][ev.kind] ?? (ACTIONS[l][ev.kind] ? null : ITEM_ACTIONS[l]["item.update"]);
  let action = own ? own.replace("%", noun(itemtype, l).the) : ACTIONS[l][ev.kind];
  if (ev.kind === "item.update" && ev.fields?.length) {
    const named = ev.fields.map((f) => FIELDS[l][f]).filter((f): f is string => !!f);
    // Only when every change has a name: "changed the status" must not hide other changes.
    if (named.length === ev.fields.length && named.length <= 3) {
      action = TEXT[l].changed(named.length > 1 ? named.slice(0, -1).join(", ") + TEXT[l].and + named[named.length - 1] : named[0]);
    }
  }
  return `${who(ev.by, selfId, l)} ${action}`;
}

export function summary(events: Array<ItemEvent & { by: Actor }>, selfId: number | undefined, l: Lang, itemtype = "Ticket"): string {
  if (events.length === 0) return "";
  const last = describe(events[events.length - 1], selfId, l, itemtype);
  return events.length > 1 ? last + TEXT[l].more(events.length - 1) : last;
}

const STYLE_ID = "glpi-rt-updates-style";
const CSS = `
.glpi-rt-updates { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.5rem 0; padding:.5rem .75rem;
  border-radius:var(--tblr-border-radius, 4px); background:var(--tblr-info-lt, #e8f3fc); color:var(--tblr-body-color, #1d273b);
  border:1px solid var(--tblr-info, #4299e1); position:sticky; top:0; z-index:10; }
.glpi-rt-updates[hidden] { display:none !important; }
.glpi-rt-updates.is-lost { background:var(--tblr-warning-lt, #fdf3e3); border-color:var(--tblr-warning, #f59f00); }
.glpi-rt-updates .glpi-rt-updates-text { flex:1 1 12rem; }
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function anchor(doc: Document): { parent: Element; before: Node | null } | null {
  const container = doc.getElementById("itil-object-container");
  if (container) return { parent: container, before: container.firstChild };
  const main = doc.querySelector("main, #page");
  return main ? { parent: main, before: main.firstChild } : null;
}

/** Banners per room, accumulating events until the user refreshes or dismisses. */
export class UpdatesBanner {
  private readonly events = new Map<string, Array<ItemEvent & { by: Actor }>>();
  private readonly doc: Document;
  private readonly reload: () => void;

  constructor(doc: Document, reload: () => void = () => doc.defaultView?.location.reload()) {
    this.doc = doc;
    this.reload = reload;
  }

  private l(): Lang {
    return lang(this.doc.documentElement.lang || this.doc.defaultView?.navigator.language || "en");
  }

  add(room: string, ev: ItemEvent & { by: Actor }, selfId: number | undefined): void {
    const list = this.events.get(room) ?? [];
    list.push(ev);
    this.events.set(room, list);
    const bar = this.bar(room);
    if (!bar || bar.classList.contains("is-lost")) return;
    bar.querySelector<HTMLElement>(".glpi-rt-updates-text")!.textContent = summary(list, selfId, this.l(), room.split(":")[0]);
    bar.hidden = false;
  }

  /** The session cannot read the item any more. */
  lost(room: string): void {
    const bar = this.bar(room);
    if (!bar) return;
    bar.classList.add("is-lost");
    bar.querySelector<HTMLElement>(".glpi-rt-updates-text")!.textContent = TEXT[this.l()].lost(noun(room.split(":")[0], this.l()).this);
    bar.querySelector<HTMLElement>(".glpi-rt-dismiss")!.hidden = true;
    bar.hidden = false;
  }

  private bar(room: string): HTMLElement | null {
    const id = `glpi-rt-updates-${room.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const existing = this.doc.getElementById(id);
    if (existing) return existing;
    const at = anchor(this.doc);
    if (!at) return null;
    ensureStyle(this.doc);
    const t = TEXT[this.l()];
    const bar = this.doc.createElement("div");
    bar.id = id;
    bar.className = "glpi-rt-updates";
    bar.dataset.room = room;
    bar.setAttribute("role", "status");
    bar.hidden = true;
    const text = this.doc.createElement("span");
    text.className = "glpi-rt-updates-text";
    const refresh = this.doc.createElement("button");
    refresh.type = "button";
    refresh.className = "btn btn-sm btn-primary glpi-rt-refresh";
    refresh.textContent = t.refresh;
    refresh.addEventListener("click", () => this.reload());
    const dismiss = this.doc.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn-close glpi-rt-dismiss";
    dismiss.setAttribute("aria-label", t.dismiss);
    dismiss.title = t.dismiss;
    dismiss.addEventListener("click", () => {
      bar.hidden = true;
      this.events.delete(room);
    });
    bar.append(text, refresh, dismiss);
    at.parent.insertBefore(bar, at.before);
    return bar;
  }
}
