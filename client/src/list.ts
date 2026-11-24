import { h } from "./dom.ts";
import { labels, look, others } from "./presence.ts";
import type { PresenceUser } from "./protocol.ts";

/**
 * Who is on each ticket, change or problem of a GLPI list (search results): small avatars
 * next to the title of the rows people are on. GLPI grants each row (READ checked, as
 * when an item is displayed) and the client follows their presence without being in it.
 */

/** Rows a list page may follow at most (server: limits.max_watched_rooms). */
export const MAX_ROWS = 200;
export const MAX_AVATARS = 3;

const FORM_TYPES: Record<string, string> = { ticket: "Ticket", change: "Change", problem: "Problem" };

/**
 * "Ticket:42", "Computer:7"... for a search result row, from its massive action box (any
 * item type: GLPI says which are enabled) or, for tickets, changes and problems, its link.
 */
export function rowKey(row: Element): string | null {
  const box = row.querySelector<HTMLInputElement>("input.massive_action_checkbox[name^='item[']");
  const m = box?.name.match(/^item\[([A-Za-z_][A-Za-z0-9_\\]*)\]\[([1-9][0-9]*)\]$/);
  if (m) return `${m[1]}:${m[2]}`;
  for (const a of Array.from(row.querySelectorAll<HTMLAnchorElement>("a[href*='.form.php']"))) {
    const l = (a.getAttribute("href") ?? "").match(/\/front\/(ticket|change|problem)\.form\.php\?(?:.*&)?id=([1-9][0-9]*)/);
    if (l) return `${FORM_TYPES[l[1]]}:${l[2]}`;
  }
  return null;
}

/** Where the avatars go: the title column, else the cell holding the item's link. */
function cellOf(row: Element): Element | null {
  return (
    row.querySelector("td[data-searchopt-content-id='1']") ??
    row.querySelector("a[href*='.form.php']")?.closest("td") ??
    row.querySelector("td:nth-child(2)")
  );
}

const STYLE = `
.glpi-rt-row-presence { display:inline-flex; gap:.15rem; margin-left:.4rem; vertical-align:middle; }
.glpi-rt-row-presence .glpi-rt-mini { width:1.35rem; height:1.35rem; border-radius:50%; display:inline-flex; align-items:center;
  justify-content:center; font-size:.55rem; font-weight:700; background-size:cover; background-position:center;
  box-shadow:0 0 0 2px var(--tblr-bg-surface, #fff), 0 0 0 3px var(--tblr-green, #2fb344); }
.glpi-rt-row-presence .glpi-rt-mini.is-inactive { opacity:.55; box-shadow:0 0 0 2px var(--tblr-bg-surface, #fff), 0 0 0 3px var(--tblr-gray-400, #9ba9be); }
.glpi-rt-row-presence .glpi-rt-mini.is-more { background:var(--tblr-secondary, #667382); color:#fff; box-shadow:none; }
`;

export interface ListClient {
  user: { id: number } | null;
  watch(rooms: string[]): void;
  on(type: string, h: (msg: any) => void): () => void;
}

export class ListPresence {
  private readonly doc: Document;
  private readonly client: ListClient;
  private readonly grant: (items: string[]) => Promise<string[]>;
  private readonly lang: string;
  private keys = "";
  private readonly users = new Map<string, PresenceUser[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc: Document, client: ListClient, grant: (items: string[]) => Promise<string[]>, lang: string) {
    this.doc = doc;
    this.client = client;
    this.grant = grant;
    this.lang = lang;
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head.appendChild(style);
    client.on("presence", (m) => {
      this.users.set(m.room, m.users);
      this.paint(m.room);
    });
  }

  /** The list changed (first display, page, sort, filter): follow its rows. */
  scan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.follow(), 300);
  }

  private rows(): Map<string, Element> {
    const out = new Map<string, Element>();
    for (const row of Array.from(this.doc.querySelectorAll("table.search-results tbody tr"))) {
      const k = rowKey(row);
      if (k && !out.has(k) && out.size < MAX_ROWS) out.set(k, row);
    }
    return out;
  }

  private async follow(): Promise<void> {
    const rows = this.rows();
    const keys = [...rows.keys()].sort().join(",");
    if (keys === this.keys) {
      for (const k of rows.keys()) this.paint(k); // rows redrawn by GLPI
      return;
    }
    this.keys = keys;
    const granted = rows.size ? await this.grant([...rows.keys()]).catch(() => []) : [];
    this.client.watch(granted);
    for (const k of rows.keys()) this.paint(k);
  }

  private paint(room: string): void {
    for (const row of Array.from(this.doc.querySelectorAll("table.search-results tbody tr"))) {
      if (rowKey(row) !== room) continue;
      const cell = cellOf(row);
      if (!cell) continue;
      const list = others(this.users.get(room) ?? [], this.client.user?.id);
      // Unchanged: leave the DOM alone (a change would wake the page's observer again).
      const sig = list.map((u) => `${u.id}:${u.active ? 1 : 0}:${u.avatar?.picture ?? ""}`).join(",");
      const old = cell.querySelector<HTMLElement>(".glpi-rt-row-presence");
      if ((old?.dataset.sig ?? "") === sig) continue;
      old?.remove();
      if (!list.length) continue;
      const t = labels(this.lang, room.split(":")[0]);
      const box = h("span", { class: "glpi-rt-row-presence", role: "img", "data-sig": sig, "aria-label": `${t.also} ${list.map((u) => u.name).join(", ")}` });
      for (const u of list.slice(0, MAX_AVATARS)) {
        const l = look(u);
        const el = h("span", { class: `glpi-rt-mini ${u.active ? "is-active" : "is-inactive"}`, title: `${u.name} — ${u.active ? t.active : t.inactive}`, text: l.text });
        el.style.backgroundImage = l.picture ? `url("${l.picture}")` : "";
        el.style.backgroundColor = l.picture ? "transparent" : l.bg;
        el.style.color = l.fg;
        box.append(el);
      }
      if (list.length > MAX_AVATARS) {
        const rest = list.slice(MAX_AVATARS);
        box.append(h("span", { class: "glpi-rt-mini is-more", title: rest.map((u) => u.name).join(", "), text: `+${rest.length}` }));
      }
      cell.append(box);
    }
  }
}
