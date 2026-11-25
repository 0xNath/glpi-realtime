import { eventIcon, ensureStyle, type InboxController, openPreferences } from "./bell.ts";
import { h, icon, safeHref } from "./dom.ts";
import { actorName, eventText, type Group, groups, groupText, type InboxApi, type InboxList, type Labels, type Tab, tabs } from "./inbox.ts";

/** "today" | "week" | "month" | "" ("today": the browser's day), for the instant `ts` (Unix seconds). */
export function inPeriod(ts: number, period: string, now: Date): boolean {
  if (!period) return true;
  const d = new Date(ts * 1000);
  if (period === "today") return d.toDateString() === now.toDateString();
  const days = period === "week" ? 7 : 30;
  return now.getTime() - d.getTime() <= days * 86400_000;
}

const CSS = `
.glpi-rt-page .glpi-rt-tabs { border:0; padding:0; margin:.5rem 0; }
.glpi-rt-page table td { vertical-align:middle; }
.glpi-rt-page tr.is-unread { font-weight:600; }
.glpi-rt-page tr.is-unread td:first-child { box-shadow:inset 3px 0 var(--tblr-primary, #206bc4); }
`;

/** Every notification, as a table (front/notifications.php). */
export class InboxPage {
  private readonly root: HTMLElement;
  private readonly ctl: InboxController;
  private readonly api: InboxApi;
  private readonly t: Labels;
  private tab: Tab = "all";
  private status = "";
  private period = "";

  constructor(root: HTMLElement, ctl: InboxController, api: InboxApi, t: Labels) {
    this.root = root;
    this.ctl = ctl;
    this.api = api;
    this.t = t;
    ensureStyle(root.ownerDocument);
    const style = root.ownerDocument.createElement("style");
    style.textContent = CSS;
    root.ownerDocument.head.appendChild(style);
    root.classList.add("glpi-rt-page");
    ctl.onChange((list) => this.render(list));
  }

  render(list: InboxList): void {
    const t = this.t;
    const shown = tabs(list.preferences, list.can_see_others, list.interface);
    if (!shown.includes(this.tab)) this.tab = "all";
    const all = groups(list, this.tab, this.ctl.withRead);
    const statuses = new Map<number, string>();
    for (const g of groups(list, "all", true)) if (g.object.status_label) statuses.set(g.object.status, g.object.status_label);
    const now = new Date();
    const rows = all.filter((g) => (!this.status || String(g.object.status) === this.status) && inPeriod(g.ts, this.period, now));

    // Named for screen readers: the filters have no visible label (WCAG 4.1.2).
    const select = (label: string, value: string, options: Array<[string, string]>, onchange: (v: string) => void) =>
      h(
        "select",
        { class: "form-select form-select-sm w-auto", "aria-label": label, onchange: (e) => onchange((e.target as HTMLSelectElement).value) },
        ...options.map(([v, l]) => h("option", { value: v, selected: v === value, text: l })),
      );

    this.root.replaceChildren(
      h(
        "div",
        { class: "d-flex align-items-center flex-wrap gap-2 my-3" },
        icon("bell"),
        h("h1", { class: "h2 mb-0 me-2", text: t.title }),
        list.counts.all ? h("span", { class: "badge bg-danger text-white", text: String(list.counts.all) }) : null,
        h("div", { class: "ms-auto d-flex flex-wrap gap-2 align-items-center" },
          h("label", { class: "d-flex align-items-center gap-1 small" },
            h("input", { type: "checkbox", class: "form-check-input m-0", checked: this.ctl.withRead, onchange: (e) => {
              this.ctl.withRead = (e.target as HTMLInputElement).checked;
              void this.ctl.load();
            } }),
            t.showRead),
          select(t.statusFilter, this.status, [["", t.allStatuses], ...[...statuses].sort((a, b) => a[0] - b[0]).map(([v, l]) => [String(v), l] as [string, string])], (v) => {
            this.status = v;
            this.render(list);
          }),
          select(t.periodFilter, this.period, Object.entries(t.periods), (v) => {
            this.period = v;
            this.render(list);
          }),
          h("button", { type: "button", class: "btn btn-sm btn-outline-secondary", onclick: () => void this.ctl.act({ action: "read_tab", tab: this.tab }) }, icon("checks"), " ", t.markAll),
          h("button", { type: "button", class: "btn btn-sm btn-outline-secondary", "aria-label": t.prefs, title: t.prefs, onclick: () =>
            openPreferences(this.root.ownerDocument, list, t, async (p) => {
              await this.api.savePreferences(p);
              await this.ctl.load();
            }) }, icon("settings")),
        ),
      ),
      h("div", { class: "glpi-rt-tabs", role: "tablist" },
        ...shown.map((tab) =>
          h("button", { type: "button", role: "tab", class: `glpi-rt-tab${tab === this.tab ? " is-active" : ""}`, "aria-selected": String(tab === this.tab), onclick: () => {
            this.tab = tab;
            this.render(list);
          } }, t.tabs[tab], list.counts[tab] ? h("span", { class: "glpi-rt-count", text: String(list.counts[tab]) }) : null),
        ),
      ),
      rows.length === 0
        ? h("div", { class: "glpi-rt-empty", text: t.empty })
        : h("div", { class: "table-responsive" },
            h("table", { class: "table table-hover table-sm card-table" },
              h("thead", {}, h("tr", {}, ...t.columns.map((c) => h("th", { text: c })))),
              h("tbody", {}, ...rows.map((g) => this.row(list, g))),
            ),
          ),
    );
  }

  private row(list: InboxList, g: Group): HTMLElement {
    const t = this.t;
    const o = g.object;
    const latest = g.events[0];
    const href = safeHref(o.url);
    const style = list.preferences.update_message_style;
    const actions = h("div", { class: "btn-group btn-group-sm" },
      href ? h("a", { class: "btn btn-outline-secondary", href, title: t.open, "aria-label": t.open, onclick: (e) => {
        e.preventDefault();
        void this.ctl.act({ action: "read_item", item: g.key }).finally(() => (location.href = href));
      } }, icon("external-link")) : null,
      g.unread
        ? h("button", { type: "button", class: "btn btn-outline-secondary", title: t.read, "aria-label": t.read, onclick: () => void this.ctl.act({ action: "read_item", item: g.key }) }, icon("eye"))
        : latest.id > 0
          ? h("button", { type: "button", class: "btn btn-outline-secondary", title: t.unread, "aria-label": t.unread, onclick: () => void this.ctl.act({ action: "unread", id: latest.id }) }, icon("eye-off"))
          : null,
      // Assume, the row's main action: primary (white on blue); Tabler's outline green on a
      // light row has a contrast of 2.55:1, under WCAG's 4.5:1 (axe).
      g.queue === "new" && o.can_assign
        ? h("button", { type: "button", class: "btn btn-primary", title: t.assume, "aria-label": t.assume, onclick: async () => {
            await this.api.assign(g.key);
            await this.ctl.load();
          } }, icon("user-plus"), " ", t.assume)
        : null,
    );
    return h("tr", { class: g.unread ? "is-unread" : "", "data-key": g.key },
      h("td", {}, href ? h("a", { href, text: o.title }) : o.title),
      h("td", { text: String(o.id) }),
      h("td", { text: g.date, class: "text-nowrap" }),
      h("td", {}, o.status_label ? h("span", { class: "badge glpi-rt-status", text: o.status_label }) : ""),
      h("td", { text: o.priority_label ?? "" }),
      h("td", { text: o.entity ?? "" }),
      h("td", { text: (o.requesters ?? []).join(", ") }),
      h("td", { text: o.type_label ?? o.type }),
      h("td", { text: actorName(list, latest.actor, t) }),
      h("td", {}, eventIcon(latest.event), " ", eventText(latest, style, t)),
      h("td", { text: groupText(g, style, t) }),
      h("td", {}, actions),
    );
  }
}
