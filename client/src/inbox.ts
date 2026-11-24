/**
 * The notification inbox ("bell"): data from GLPI (ajax/inbox.php), grouping and texts.
 * Queues, events and preferences follow the Notifier+ plugin.
 */

export type Queue = "new" | "mine" | "team" | "other" | "resolved" | "closed";
export type Tab = "all" | Queue | "ended";

export interface InboxItem {
  /** 0 for unassigned tickets offered to technicians (no row yet). */
  id: number;
  /** "Ticket:5" */
  key: string;
  event: string;
  channel: string;
  detail: { fields?: string[]; status?: number } | null;
  is_read: boolean;
  actor: number;
  /** "YYYY-MM-DD HH:MM:SS", GLPI server time. */
  date: string;
  queue: Queue;
}

export interface InboxObject {
  type: string;
  id: number;
  title: string;
  url: string;
  status: number;
  status_label?: string;
  priority?: number;
  can_assign?: boolean;
  priority_label?: string;
  entity?: string;
  type_label?: string;
  requesters?: string[];
}

export interface Preferences {
  [k: string]: boolean | string;
  update_message_style: "priority" | "combined" | "multiple";
  resolved_closed_style: "separate" | "ended";
}

export interface InboxList {
  enabled: true;
  items: InboxItem[];
  objects: Record<string, InboxObject>;
  users: Record<string, string>;
  counts: Record<Tab, number>;
  preferences: Preferences;
  can_see_others: boolean;
}

export interface Group {
  key: string;
  object: InboxObject;
  /** Newest first. */
  events: InboxItem[];
  unread: boolean;
  queue: Queue;
  date: string;
}

type Lang = "fr" | "en";

export const LABELS = {
  fr: {
    title: "Notifications",
    tabs: { all: "Tous", new: "Nouveaux", mine: "Mes tickets", team: "Équipe", other: "Autres", resolved: "Résolus", closed: "Clos", ended: "Terminés" },
    empty: "Aucune notification",
    markAll: "Tout marquer comme lu",
    showRead: "Afficher les lues",
    viewAll: "Tout voir",
    prefs: "Préférences",
    close: "Fermer",
    minimize: "Réduire",
    read: "Marquer comme lu",
    unread: "Marquer comme non lu",
    assume: "Prendre en charge",
    assumed: "Ticket pris en charge",
    open: "Ouvrir",
    updates: (n: number) => `${n} mises à jour`,
    glpi: "GLPI",
    ago: { now: "à l'instant", m: (n: number) => `il y a ${n} min`, h: (n: number) => `il y a ${n} h`, d: (n: number) => `il y a ${n} j` },
    events: {
      created: "Nouvel élément vous concernant",
      created_new: "Nouveau ticket non attribué",
      assigned: "Vous avez été attribué",
      assigned_group: "Votre groupe a été attribué",
      commented: "Nouveau suivi",
      task_added: "Nouvelle tâche",
      solution: "Solution proposée",
      solution_refused: "Solution refusée",
      status_changed: "Statut modifié",
      updated: "Élément mis à jour",
      validation_asked: "Validation demandée",
      validation_accepted: "Validation acceptée",
      validation_refused: "Validation refusée",
      transferred: "Transféré dans votre entité",
    } as Record<string, string>,
    fields: {
      itilcategories_id: "Catégorie modifiée",
      priority: "Priorité modifiée",
      content: "Description mise à jour",
      name: "Titre modifié",
      type: "Type modifié",
      time_to_resolve: "Échéance modifiée",
      plan_start_date: "Planning modifié",
      multiple: "Modifications multiples",
    } as Record<string, string>,
    columns: ["Élément", "N°", "Date", "Statut", "Priorité", "Entité", "Demandeur", "Type", "Utilisateur", "Événement", "Détail", "Actions"],
    allStatuses: "Tous les statuts",
    periods: { "": "Toutes les périodes", today: "Aujourd'hui", week: "7 derniers jours", month: "30 derniers jours" } as Record<string, string>,
    p: {
      receive: "Recevoir",
      direct: "Me concernant",
      group: "Mes groupes",
      types: { ticket: "Tickets", change: "Changements", problem: "Problèmes", projecttask: "Tâches de projet" } as Record<string, string>,
      others: "Activité des tickets, changements et problèmes que je peux voir (onglet Autres)",
      sound: "Son",
      soundQueues: { sound_new: "Nouveaux", sound_mine: "Mes tickets", sound_team: "Équipe", sound_other: "Autres", sound_ended: "Résolus / clos" } as Record<string, string>,
      style: "Plusieurs modifications",
      styles: { priority: "La plus importante", combined: "Combinées", multiple: "« Modifications multiples »" } as Record<string, string>,
      showResolved: "Afficher les résolus",
      showClosed: "Afficher les clos",
      ended: "Résolus et clos",
      endedStyles: { separate: "Onglets séparés", ended: "Un onglet « Terminés »" } as Record<string, string>,
      save: "Enregistrer",
      cancel: "Annuler",
    },
  },
  en: {
    title: "Notifications",
    tabs: { all: "All", new: "New", mine: "Mine", team: "Team", other: "Others", resolved: "Resolved", closed: "Closed", ended: "Ended" },
    empty: "No notifications",
    markAll: "Mark all as read",
    showRead: "Show read",
    viewAll: "View all",
    prefs: "Preferences",
    close: "Close",
    minimize: "Minimize",
    read: "Mark as read",
    unread: "Mark as unread",
    assume: "Assume",
    assumed: "Ticket assumed",
    open: "Open",
    updates: (n: number) => `${n} updates`,
    glpi: "GLPI",
    ago: { now: "just now", m: (n: number) => `${n} min ago`, h: (n: number) => `${n} h ago`, d: (n: number) => `${n} d ago` },
    events: {
      created: "New item concerning you",
      created_new: "New unassigned ticket",
      assigned: "You have been assigned",
      assigned_group: "Your group has been assigned",
      commented: "New followup",
      task_added: "New task",
      solution: "Solution proposed",
      solution_refused: "Solution refused",
      status_changed: "Status changed",
      updated: "Item updated",
      validation_asked: "Approval requested",
      validation_accepted: "Approval accepted",
      validation_refused: "Approval refused",
      transferred: "Transferred to your entity",
    } as Record<string, string>,
    fields: {
      itilcategories_id: "Category changed",
      priority: "Priority changed",
      content: "Description updated",
      name: "Title changed",
      type: "Type changed",
      time_to_resolve: "Due date changed",
      plan_start_date: "Planning changed",
      multiple: "Multiple changes",
    } as Record<string, string>,
    columns: ["Item", "No.", "Date", "Status", "Priority", "Entity", "Requester", "Type", "User", "Event", "Detail", "Actions"],
    allStatuses: "All statuses",
    periods: { "": "All periods", today: "Today", week: "Last 7 days", month: "Last 30 days" } as Record<string, string>,
    p: {
      receive: "Receive",
      direct: "Concerning me",
      group: "My groups",
      types: { ticket: "Tickets", change: "Changes", problem: "Problems", projecttask: "Project tasks" } as Record<string, string>,
      others: "Activity on tickets, changes and problems I can see (Others tab)",
      sound: "Sound",
      soundQueues: { sound_new: "New", sound_mine: "Mine", sound_team: "Team", sound_other: "Others", sound_ended: "Resolved / closed" } as Record<string, string>,
      style: "Several changes",
      styles: { priority: "The most important", combined: "Combined", multiple: "\"Multiple changes\"" } as Record<string, string>,
      showResolved: "Show resolved",
      showClosed: "Show closed",
      ended: "Resolved and closed",
      endedStyles: { separate: "Separate tabs", ended: "One \"Ended\" tab" } as Record<string, string>,
      save: "Save",
      cancel: "Cancel",
    },
  },
};

export type Labels = (typeof LABELS)["en"];

export function labelsFor(lang: string): Labels {
  return (lang.slice(0, 2).toLowerCase() === "fr" ? LABELS.fr : LABELS.en) as Labels;
}

/** Tabs shown, per preferences and rights. */
export function tabs(prefs: Preferences, canSeeOthers: boolean): Tab[] {
  const out: Tab[] = ["all", "new", "mine", "team"];
  if (canSeeOthers) out.push("other");
  const resolved = !!prefs.show_resolved;
  const closed = !!prefs.show_closed;
  if (prefs.resolved_closed_style === "ended") {
    if (resolved || closed) out.push("ended");
  } else {
    if (resolved) out.push("resolved");
    if (closed) out.push("closed");
  }
  return out;
}

export function inTab(queue: Queue, tab: Tab): boolean {
  return tab === "all" || queue === tab || (tab === "ended" && (queue === "resolved" || queue === "closed"));
}

/** Most important first: what the bell says when an item has several events. */
const IMPORTANCE = [
  "solution_refused", "validation_asked", "assigned", "transferred", "created", "solution",
  "validation_done", "commented", "task_added", "status_changed", "updated",
];

/** Field changes, most important first (Notifier+ "priority" style). */
const FIELD_ORDER = ["itilcategories_id", "priority", "urgency", "impact", "content", "name", "type", "time_to_resolve", "plan_start_date", "plan_end_date"];

function fieldText(field: string, t: Labels): string {
  if (field === "urgency" || field === "impact") return t.fields.priority;
  if (field === "plan_end_date") return t.fields.plan_start_date;
  return t.fields[field] ?? t.events.updated;
}

/** One event as a sentence: "Priority changed", "Approval refused". */
export function eventText(it: InboxItem, style: Preferences["update_message_style"], t: Labels): string {
  switch (it.event) {
    case "created":
      return it.channel === "broadcast" || it.channel === "seen" ? t.events.created_new : t.events.created;
    case "assigned":
      return it.channel === "group" ? t.events.assigned_group : t.events.assigned;
    case "validation_done":
      return it.detail?.status === 4 ? t.events.validation_refused : t.events.validation_accepted;
    case "updated": {
      const fields = it.detail?.fields ?? [];
      const texts = [...new Set([...fields].sort((a, b) => rank(FIELD_ORDER, a) - rank(FIELD_ORDER, b)).map((f) => fieldText(f, t)))];
      if (texts.length === 0) return t.events.updated;
      if (texts.length === 1 || style === "priority") return texts[0];
      return style === "combined" ? texts.join(" + ") : t.fields.multiple;
    }
    default:
      return t.events[it.event] ?? t.events.updated;
  }
}

function rank(order: string[], v: string): number {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
}

/** What a group says: one event, or several per the "several changes" style. */
export function groupText(g: Group, style: Preferences["update_message_style"], t: Labels): string {
  const unread = g.events.filter((e) => !e.is_read);
  const events = unread.length ? unread : g.events;
  if (events.length === 1) return eventText(events[0], style, t);
  if (style === "multiple") return t.updates(events.length);
  const sorted = [...events].sort((a, b) => rank(IMPORTANCE, a.event) - rank(IMPORTANCE, b.event));
  const texts = [...new Set(sorted.map((e) => eventText(e, style, t)))];
  return style === "combined" ? texts.join(" + ") : texts[0];
}

/** Items of the list, grouped per object, newest first. */
export function groups(list: InboxList, tab: Tab, withRead = false): Group[] {
  const by = new Map<string, Group>();
  for (const it of list.items) {
    const object = list.objects[it.key];
    if (!object || !inTab(it.queue, tab) || (!withRead && it.is_read)) continue;
    let g = by.get(it.key);
    if (!g) by.set(it.key, (g = { key: it.key, object, events: [], unread: false, queue: it.queue, date: it.date }));
    g.events.push(it);
    g.unread ||= !it.is_read;
    if (it.date > g.date) g.date = it.date;
  }
  const out = [...by.values()];
  for (const g of out) g.events.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Unread items that were not unread before: they make the bell ring. */
export function arrivals(prev: InboxList | null, next: InboxList): InboxItem[] {
  if (!prev) return [];
  const known = new Set(prev.items.filter((i) => !i.is_read).map((i) => `${i.key}|${i.id}|${i.event}`));
  return next.items.filter((i) => !i.is_read && !known.has(`${i.key}|${i.id}|${i.event}`) && next.objects[i.key]);
}

/** Whether new arrivals should play the sound, per queue preferences. */
export function shouldRing(items: InboxItem[], prefs: Preferences): boolean {
  if (!prefs.sound_enabled) return false;
  return items.some((i) => !!prefs[i.queue === "resolved" || i.queue === "closed" ? "sound_ended" : `sound_${i.queue}`]);
}

/** GLPI dates are server local time without zone: compare as local time. */
export function timeAgo(date: string, now: Date, t: Labels): string {
  const d = new Date(date.replace(" ", "T"));
  const s = Math.max(0, (now.getTime() - d.getTime()) / 1000);
  if (Number.isNaN(s) || s < 60) return t.ago.now;
  if (s < 3600) return t.ago.m(Math.floor(s / 60));
  if (s < 86400) return t.ago.h(Math.floor(s / 3600));
  return t.ago.d(Math.floor(s / 86400));
}

export function actorName(list: InboxList, uid: number, t: Labels): string {
  return uid > 0 ? (list.users[String(uid)] ?? `#${uid}`) : t.glpi;
}

/** Talks to the plugin endpoints (same origin, GLPI session cookie). */
export class InboxApi {
  private readonly root: string;
  private readonly fetchFn: typeof fetch;

  constructor(root: string, fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.root = `${root}/plugins/realtime/ajax`;
    this.fetchFn = fetchFn;
  }

  async list(opts: { read?: boolean; full?: boolean } = {}): Promise<InboxList | null> {
    const q = new URLSearchParams({ read: opts.read ? "1" : "0", full: opts.full ? "1" : "0" });
    const data = await this.json(`${this.root}/inbox.php?${q}`);
    return data?.enabled ? (data as InboxList) : null;
  }

  async act(body: Record<string, unknown>, opts: { read?: boolean; full?: boolean } = {}): Promise<InboxList | null> {
    const q = new URLSearchParams({ read: opts.read ? "1" : "0", full: opts.full ? "1" : "0" });
    const data = await this.json(`${this.root}/inbox.php?${q}`, body);
    return data?.enabled ? (data as InboxList) : null;
  }

  savePreferences(prefs: Partial<Preferences>): Promise<{ preferences: Preferences } | null> {
    return this.json(`${this.root}/preferences.php`, prefs);
  }

  assign(item: string): Promise<{ ok: boolean; message: string } | null> {
    return this.json(`${this.root}/assign.php`, { item });
  }

  private async json(url: string, body?: unknown): Promise<any> {
    const resp = await this.fetchFn(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok && resp.status !== 403) return null;
    try {
      return await resp.json();
    } catch {
      return null;
    }
  }
}
