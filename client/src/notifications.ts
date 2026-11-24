import type { Actor } from "./protocol.ts";
import { lang, who } from "./updates.ts";

/**
 * Toasts for the self-service interface, which has no bell: one per notification, in
 * the tabs the server asks to alert. Built with textContent: names come from other
 * users' sessions.
 */

export interface Notification {
  nid: string;
  kind: string;
  room: string;
  by: Actor;
}

type Lang = "fr" | "en";

const TEXT: Record<Lang, Record<string, (by: string, ref: string) => string>> = {
  fr: {
    assigned: (by, ref) => `${by} vous a attribué ${ref}`,
    created: (by, ref) => `${by} a créé ${ref}`,
    commented: (by, ref) => `${by} a ajouté un suivi sur ${ref}`,
    task_added: (by, ref) => `${by} a ajouté une tâche sur ${ref}`,
    solution: (by, ref) => `${by} a proposé une solution pour ${ref}`,
    solution_refused: (by, ref) => `${by} a refusé la solution de ${ref}`,
    status_changed: (by, ref) => `${by} a changé le statut de ${ref}`,
    validation_asked: (by, ref) => `${by} demande votre validation sur ${ref}`,
    validation_done: (by, ref) => `${by} a répondu à la validation de ${ref}`,
    transferred: (by, ref) => `${by} a transféré ${ref}`,
    other: (by, ref) => `${by} a modifié ${ref}`,
  },
  en: {
    assigned: (by, ref) => `${by} assigned you ${ref}`,
    created: (by, ref) => `${by} created ${ref}`,
    commented: (by, ref) => `${by} added a followup on ${ref}`,
    task_added: (by, ref) => `${by} added a task on ${ref}`,
    solution: (by, ref) => `${by} proposed a solution for ${ref}`,
    solution_refused: (by, ref) => `${by} refused the solution of ${ref}`,
    status_changed: (by, ref) => `${by} changed the status of ${ref}`,
    validation_asked: (by, ref) => `${by} requests your approval on ${ref}`,
    validation_done: (by, ref) => `${by} answered the approval of ${ref}`,
    transferred: (by, ref) => `${by} transferred ${ref}`,
    other: (by, ref) => `${by} updated ${ref}`,
  },
};

const ITEM: Record<Lang, Record<string, string>> = {
  fr: { Ticket: "le ticket", Change: "le changement", Problem: "le problème" },
  en: { Ticket: "ticket", Change: "change", Problem: "problem" },
};

const UI = {
  fr: { title: "Notification", open: "Ouvrir", close: "Fermer" },
  en: { title: "Notification", open: "Open", close: "Close" },
};

function parseRoom(room: string): { itemtype: string; id: number } | null {
  const m = /^([A-Za-z_]+):([1-9][0-9]*)$/.exec(room);
  return m ? { itemtype: m[1], id: Number(m[2]) } : null;
}

export function text(n: Notification, selfId: number | undefined, l: Lang): string {
  const r = parseRoom(n.room);
  const ref = r ? `${ITEM[l][r.itemtype] ?? r.itemtype} ${l === "fr" ? "n°" : "#"}${r.id}` : n.room;
  return (TEXT[l][n.kind] ?? TEXT[l].other)(who(n.by, selfId, l), ref);
}

/** Form URL of the item, same origin: `/front/ticket.form.php?id=42`. */
export function link(room: string, rootDoc: string): string | null {
  const r = parseRoom(room);
  return r ? `${rootDoc}/front/${r.itemtype.toLowerCase()}.form.php?id=${r.id}` : null;
}

const CSS = `
.glpi-rt-toasts { position:fixed; right:1rem; bottom:1rem; z-index:1090; display:flex; flex-direction:column; gap:.5rem; max-width:22rem; }
.glpi-rt-toasts .toast { display:block; opacity:1; }
`;

export class Toasts {
  private readonly seen = new Set<string>();
  private readonly doc: Document;
  private readonly rootDoc: string;
  private readonly delayMs: number;

  constructor(doc: Document, rootDoc: string, delayMs = 15_000) {
    this.doc = doc;
    this.rootDoc = rootDoc;
    this.delayMs = delayMs;
  }

  show(n: Notification, selfId: number | undefined): void {
    if (this.seen.has(n.nid)) return;
    this.seen.add(n.nid);
    const l = lang(this.doc.documentElement.lang || this.doc.defaultView?.navigator.language || "en");
    const ui = UI[l];

    const toast = this.doc.createElement("div");
    toast.className = "toast show glpi-rt-toast";
    toast.dataset.kind = n.kind;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    const header = this.doc.createElement("div");
    header.className = "toast-header";
    const title = this.doc.createElement("strong");
    title.className = "me-auto";
    title.textContent = ui.title;
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "btn-close";
    close.setAttribute("aria-label", ui.close);
    close.addEventListener("click", () => toast.remove());
    header.append(title, close);
    const body = this.doc.createElement("div");
    body.className = "toast-body";
    const msg = this.doc.createElement("div");
    msg.textContent = text(n, selfId, l);
    body.append(msg);
    const href = link(n.room, this.rootDoc);
    if (href) {
      const a = this.doc.createElement("a");
      a.href = href;
      a.className = "btn btn-sm btn-primary mt-2";
      a.textContent = ui.open;
      body.append(a);
    }
    toast.append(header, body);
    this.container().appendChild(toast);
    setTimeout(() => {
      // Keep it while the user reads it.
      if (!toast.matches(":hover")) toast.remove();
    }, this.delayMs);
  }

  private container(): HTMLElement {
    let c = this.doc.querySelector<HTMLElement>(".glpi-rt-toasts");
    if (!c) {
      const style = this.doc.createElement("style");
      style.textContent = CSS;
      this.doc.head.appendChild(style);
      c = this.doc.createElement("div");
      c.className = "glpi-rt-toasts";
      this.doc.body.appendChild(c);
    }
    return c;
  }
}
