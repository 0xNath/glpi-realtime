import { desktopEnabled, desktopSupported, notifyDesktop, setDesktop } from "./desktop.ts";
import { h, icon, safeHref } from "./dom.ts";
import {
  actorName,
  arrivals,
  type Group,
  groups,
  groupText,
  type InboxApi,
  type InboxItem,
  type InboxList,
  type Labels,
  type Preferences,
  shouldRing,
  type Tab,
  tabs,
  timeAgo,
} from "./inbox.ts";

/**
 * Keeps one inbox list fresh: refreshed when the server pushes a notification (no
 * polling while the WebSocket is up), every minute otherwise.
 */
export class InboxController {
  list: InboxList | null = null;
  withRead = false;
  private readonly api: InboxApi;
  private readonly full: boolean;
  private readonly listeners = new Set<(l: InboxList, ring: boolean, fresh: InboxItem[]) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingRing = false;
  private inflight: Promise<void> | null = null;

  constructor(api: InboxApi, full = false) {
    this.api = api;
    this.full = full;
  }

  onChange(cb: (l: InboxList, ring: boolean, fresh: InboxItem[]) => void): void {
    this.listeners.add(cb);
  }

  /** Debounced: a burst of pushes makes one request. */
  refresh(ring = false): void {
    this.pendingRing ||= ring;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), 250);
  }

  async load(): Promise<void> {
    if (this.inflight) await this.inflight;
    this.inflight = (async () => {
      const ring = this.pendingRing;
      this.pendingRing = false;
      const next = await this.api.list({ read: this.withRead, full: this.full }).catch(() => null);
      if (next) this.apply(next, ring);
    })();
    await this.inflight;
    this.inflight = null;
  }

  async act(body: Record<string, unknown>): Promise<void> {
    const next = await this.api.act(body, { read: this.withRead, full: this.full }).catch(() => null);
    if (next) this.apply(next, false);
  }

  private apply(next: InboxList, ring: boolean): void {
    const fresh = arrivals(this.list, next);
    this.list = next;
    const rings = ring && fresh.length > 0 && shouldRing(fresh, next.preferences);
    for (const cb of this.listeners) cb(next, rings, ring ? fresh : []);
  }
}

const EVENT_ICONS: Record<string, string> = {
  created: "bell",
  assigned: "user-check",
  commented: "message",
  task_added: "checkbox",
  solution: "circle-check",
  solution_refused: "alert-triangle",
  status_changed: "refresh",
  updated: "pencil",
  validation_asked: "clipboard-check",
  validation_done: "clipboard-check",
  transferred: "arrows-exchange",
  mentioned: "at",
};

export function eventIcon(event: string): HTMLElement {
  return icon(EVENT_ICONS[event] ?? "bell");
}

const STYLE_ID = "glpi-rt-bell-style";
const CSS = `
.glpi-rt-bell { position:fixed; right:1rem; bottom:1rem; z-index:1040; font-size:.875rem; }
.glpi-rt-bell-button { width:3rem; height:3rem; border-radius:50%; border:0; display:flex; align-items:center; justify-content:center;
  background:var(--tblr-primary, #206bc4); color:#fff; box-shadow:0 2px 8px rgba(0,0,0,.25); position:relative; font-size:1.4rem; }
.glpi-rt-bell.is-minimized .glpi-rt-bell-button { width:2rem; height:2rem; font-size:1rem; opacity:.7; }
.glpi-rt-bell-badge { position:absolute; top:-.25rem; right:-.25rem; min-width:1.25rem; height:1.25rem; padding:0 .3rem; border-radius:.625rem;
  background:var(--tblr-danger, #d63939); color:#fff; font-size:.7rem; font-weight:700; line-height:1.25rem; text-align:center; }
.glpi-rt-bell-badge[hidden] { display:none; }
.glpi-rt-bell.is-ringing .glpi-rt-bell-button { animation:glpi-rt-ring .8s ease-in-out 2; }
@keyframes glpi-rt-ring { 0%,100% { transform:rotate(0) } 20% { transform:rotate(15deg) } 40% { transform:rotate(-12deg) } 60% { transform:rotate(8deg) } 80% { transform:rotate(-4deg) } }
.glpi-rt-bell-panel { position:absolute; right:0; bottom:3.5rem; width:min(26rem, calc(100vw - 2rem)); max-height:min(36rem, calc(100vh - 6rem));
  display:flex; flex-direction:column; background:var(--tblr-bg-surface, #fff); color:var(--tblr-body-color, #1d273b);
  border:1px solid var(--tblr-border-color, #e6e7e9); border-radius:var(--tblr-border-radius-lg, 8px); box-shadow:0 8px 24px rgba(0,0,0,.2); }
.glpi-rt-bell-panel[hidden] { display:none; }
.glpi-rt-bell-head { display:flex; align-items:center; gap:.25rem; padding:.5rem .75rem; border-bottom:1px solid var(--tblr-border-color, #e6e7e9); }
.glpi-rt-bell-head h2 { font-size:1rem; margin:0 auto 0 0; }
.glpi-rt-icon-btn { border:0; background:none; color:inherit; padding:.25rem; border-radius:4px; line-height:1; }
.glpi-rt-icon-btn:hover { background:var(--tblr-bg-surface-secondary, #f1f5f9); }
.glpi-rt-tabs { display:flex; flex-wrap:wrap; gap:.25rem; padding:.5rem .75rem; border-bottom:1px solid var(--tblr-border-color, #e6e7e9); }
.glpi-rt-tab { border:1px solid var(--tblr-border-color, #e6e7e9); background:none; color:inherit; border-radius:1rem; padding:.1rem .6rem; font-size:.8rem; }
.glpi-rt-tab.is-active { background:var(--tblr-primary, #206bc4); border-color:var(--tblr-primary, #206bc4); color:var(--tblr-primary-fg, #fff); }
/* Status of an item: readable on both themes (GLPI's -lt badges are too pale, WCAG AA). */
.glpi-rt-status { background:var(--tblr-bg-surface-secondary, #f1f5f9); color:var(--tblr-body-color, #1d273b); border:1px solid var(--tblr-border-color, #e6e7e9); font-weight:500; }
.glpi-rt-tab .glpi-rt-count { margin-left:.3rem; font-weight:700; }
.glpi-rt-list { list-style:none; margin:0; padding:0; overflow-y:auto; flex:1; }
.glpi-rt-empty { padding:2rem; text-align:center; color:var(--tblr-secondary, #667382); }
.glpi-rt-n { display:flex; gap:.6rem; padding:.6rem .75rem; border-bottom:1px solid var(--tblr-border-color-translucent, #eee); align-items:flex-start; }
.glpi-rt-n.is-unread { background:var(--tblr-primary-lt, #e9f0f9); }
.glpi-rt-n > .ti { font-size:1.2rem; margin-top:.1rem; color:var(--tblr-primary, #206bc4); }
.glpi-rt-n-body { flex:1; min-width:0; }
.glpi-rt-n-title { display:block; font-weight:600; color:inherit; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.glpi-rt-n-text { margin:.1rem 0; }
.glpi-rt-n-meta { font-size:.75rem; color:var(--tblr-secondary, #667382); display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.glpi-rt-n-sub { list-style:none; padding:0; margin:.3rem 0 0; font-size:.78rem; color:var(--tblr-secondary, #667382); }
.glpi-rt-n-sub[hidden] { display:none; }
.glpi-rt-n-actions { display:flex; flex-direction:column; gap:.2rem; }
.glpi-rt-bell-foot { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; padding:.5rem .75rem; border-top:1px solid var(--tblr-border-color, #e6e7e9); }
.glpi-rt-bell-foot .glpi-rt-view-all { margin-left:auto; }
.glpi-rt-bell.is-docked { position:relative; right:auto; bottom:auto; z-index:auto; display:flex; align-items:center; margin:0 .5rem; }
.glpi-rt-bell.is-docked .glpi-rt-bell-button { width:2.25rem; height:2.25rem; font-size:1.25rem; box-shadow:none;
  background:transparent; color:inherit; border:1px solid var(--tblr-border-color, #e6e7e9); }
.glpi-rt-bell.is-docked .glpi-rt-bell-button:hover { background:var(--tblr-bg-surface-secondary, rgba(0,0,0,.05)); }
.glpi-rt-bell.is-docked .glpi-rt-bell-panel { bottom:auto; top:calc(100% + .5rem); z-index:1045; }
.glpi-rt-bell.is-docked .glpi-rt-minimize { display:none; }
.glpi-rt-overlay { position:fixed; inset:0; z-index:1060; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; padding:1rem; }
.glpi-rt-prefs { background:var(--tblr-bg-surface, #fff); color:var(--tblr-body-color, #1d273b); border-radius:8px; width:min(32rem, 100%);
  max-height:calc(100vh - 2rem); overflow-y:auto; padding:1rem 1.25rem; }
.glpi-rt-prefs h3 { font-size:.9rem; margin:1rem 0 .4rem; }
.glpi-rt-prefs table { width:100%; }
.glpi-rt-prefs td, .glpi-rt-prefs th { padding:.15rem .3rem; }
.glpi-rt-prefs label { display:flex; gap:.4rem; align-items:center; margin:.15rem 0; }
.glpi-rt-prefs .glpi-rt-buttons { display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem; }
`;

export function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export interface BellOptions {
  doc: Document;
  ctl: InboxController;
  api: InboxApi;
  t: Labels;
  rootDoc: string;
  ring: () => void;
  /** Navigation (tests). */
  go?: (url: string) => void;
}

/** The bell, bottom right of every page of the technician interface. */
export class Bell {
  readonly root: HTMLElement;
  private readonly o: Required<BellOptions>;
  private tab: Tab;
  private readonly badge: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly listEl: HTMLElement;

  constructor(opts: BellOptions) {
    this.o = { go: (url) => (opts.doc.defaultView!.location.href = url), ...opts };
    const { doc, t } = this.o;
    ensureStyle(doc);
    this.tab = (storage("glpi-rt-bell-tab") as Tab | null) ?? "all";
    this.badge = h("span", { class: "glpi-rt-bell-badge", hidden: true });
    const button = h(
      "button",
      { type: "button", class: "glpi-rt-bell-button", "aria-label": t.title, "aria-haspopup": "dialog", onclick: () => this.toggle() },
      icon("bell"),
      this.badge,
    );
    this.tabsEl = h("div", { class: "glpi-rt-tabs", role: "tablist" });
    this.listEl = h("ul", { class: "glpi-rt-list" });
    const showRead = h("input", { type: "checkbox", class: "form-check-input m-0", onchange: (e) => {
      this.o.ctl.withRead = (e.target as HTMLInputElement).checked;
      void this.o.ctl.load();
    } }) as HTMLInputElement;
    const viewAll = h("a", { class: "btn btn-sm btn-outline-secondary glpi-rt-view-all", href: `${this.o.rootDoc}/plugins/realtime/front/notifications.php`, text: t.viewAll });
    this.panel = h(
      "div",
      { class: "glpi-rt-bell-panel", role: "dialog", "aria-label": t.title, hidden: true },
      h(
        "div",
        { class: "glpi-rt-bell-head" },
        h("h2", { text: t.title }),
        h("button", { type: "button", class: "glpi-rt-icon-btn", title: t.prefs, "aria-label": t.prefs, onclick: () => this.preferences() }, icon("settings")),
        h("button", { type: "button", class: "glpi-rt-icon-btn glpi-rt-minimize", title: t.minimize, "aria-label": t.minimize, onclick: () => this.minimize() }, icon("minus")),
        h("button", { type: "button", class: "glpi-rt-icon-btn", title: t.close, "aria-label": t.close, onclick: () => this.toggle(false) }, icon("x")),
      ),
      this.tabsEl,
      this.listEl,
      h(
        "div",
        { class: "glpi-rt-bell-foot" },
        h("label", { class: "d-flex align-items-center gap-1 small" }, showRead, t.showRead),
        h("button", { type: "button", class: "btn btn-sm btn-outline-secondary", onclick: () => void this.o.ctl.act({ action: "read_tab", tab: this.tab }) }, icon("checks"), " ", t.markAll),
        viewAll,
      ),
    );
    this.root = h("div", { class: "glpi-rt-bell" }, button, this.panel);
    if (!dock(doc, this.root)) {
      // No GLPI header (or no search bar in it): floating, bottom right.
      this.root.replaceChildren(this.panel, button);
      if (storage("glpi-rt-bell-min") === "1") this.root.classList.add("is-minimized");
      doc.body.appendChild(this.root);
    }
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.panel.hidden) {
        this.toggle(false);
        button.focus();
      }
    });
    // Tabs: arrows move between them (WAI-ARIA tabs pattern).
    this.tabsEl.addEventListener("keydown", (e) => {
      const tabsEls = Array.from(this.tabsEl.querySelectorAll<HTMLElement>("[role=tab]"));
      const i = tabsEls.indexOf(e.target as HTMLElement);
      if (i < 0) return;
      const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabsEls.length - 1 : null;
      if (next === null) return;
      e.preventDefault();
      const target = tabsEls[(next + tabsEls.length) % tabsEls.length];
      target.click();
      this.tabsEl.querySelector<HTMLElement>(`[data-tab="${target.dataset.tab}"]`)?.focus();
    });
    // Docked in the header, the panel behaves like GLPI's dropdowns: a click elsewhere closes it.
    doc.addEventListener("click", (e) => {
      const target = e.target as Node | null;
      if (this.root.classList.contains("is-docked") && !this.panel.hidden && target?.isConnected && !this.root.contains(target)) {
        this.toggle(false);
      }
    });
    this.o.ctl.onChange((list, ring, fresh) => {
      this.render(list);
      if (ring) this.ringing();
      if (fresh.length) notifyDesktop(this.o.doc, list, fresh, this.o.t);
    });
  }

  toggle(open = this.panel.hidden): void {
    this.panel.hidden = !open;
    // Keyboard users land in the panel (the active tab).
    if (open) setTimeout(() => this.tabsEl.querySelector<HTMLElement>("[aria-selected=true]")?.focus(), 0);
    this.root.querySelector(".glpi-rt-bell-button")?.setAttribute("aria-expanded", String(open));
    if (open && !this.root.classList.contains("is-docked")) {
      this.root.classList.remove("is-minimized");
      storage("glpi-rt-bell-min", "0");
    }
  }

  private minimize(): void {
    this.toggle(false);
    this.root.classList.add("is-minimized");
    storage("glpi-rt-bell-min", "1");
  }

  private ringing(): void {
    this.root.classList.remove("is-ringing");
    void this.root.offsetWidth; // restart the animation
    this.root.classList.add("is-ringing");
    this.o.ring();
  }

  render(list: InboxList): void {
    const { doc, t } = this.o;
    const shown = tabs(list.preferences, list.can_see_others, list.interface);
    if (!shown.includes(this.tab)) this.tab = "all";
    const total = list.counts.all ?? 0;
    this.badge.hidden = total === 0;
    this.badge.textContent = total > 99 ? "99+" : String(total);
    this.root.querySelector(".glpi-rt-bell-button")!.setAttribute("aria-label", `${t.title} (${total})`);

    this.tabsEl.replaceChildren(
      ...shown.map((tab) => {
        const n = list.counts[tab] ?? 0;
        return h(
          "button",
          {
            type: "button",
            role: "tab",
            "data-tab": tab,
            tabindex: tab === this.tab ? "0" : "-1",
            class: `glpi-rt-tab${tab === this.tab ? " is-active" : ""}`,
            "aria-selected": String(tab === this.tab),
            onclick: () => {
              this.tab = tab;
              storage("glpi-rt-bell-tab", tab);
              this.render(list);
            },
          },
          t.tabs[tab],
          n > 0 ? h("span", { class: "glpi-rt-count", text: String(n) }) : null,
        );
      }),
    );

    const gs = groups(list, this.tab, this.o.ctl.withRead);
    this.listEl.replaceChildren(
      ...(gs.length ? gs.slice(0, 50).map((g) => this.row(list, g)) : [h("li", { class: "glpi-rt-empty", text: t.empty })]),
    );
    void doc;
  }

  private row(list: InboxList, g: Group): HTMLElement {
    const { t } = this.o;
    const style = list.preferences.update_message_style;
    const latest = g.events[0];
    const href = safeHref(g.object.url);
    const open = (e: Event) => {
      e.preventDefault();
      void this.o.ctl.act({ action: "read_item", item: g.key }).finally(() => href && this.o.go(href));
    };
    const sub =
      g.events.length > 1
        ? h(
            "ul",
            { class: "glpi-rt-n-sub", hidden: true },
            ...g.events.map((e) =>
              h("li", { text: `${groupText({ ...g, events: [e] }, style, t)} · ${actorName(list, e.actor, t)} · ${timeAgo(e.ts, new Date(), t)}` }),
            ),
          )
        : null;
    const text = h("div", { class: "glpi-rt-n-text", text: groupText(g, style, t) });
    if (sub) {
      text.append(" ");
      text.append(h("button", { type: "button", class: "glpi-rt-icon-btn", "aria-label": "+", onclick: () => (sub.hidden = !sub.hidden) }, icon("chevron-down")));
    }
    const actions = h("div", { class: "glpi-rt-n-actions" });
    if (g.unread) {
      actions.append(h("button", { type: "button", class: "glpi-rt-icon-btn", title: t.read, "aria-label": t.read, onclick: () => void this.o.ctl.act({ action: "read_item", item: g.key }) }, icon("eye")));
    } else if (latest.id > 0) {
      actions.append(h("button", { type: "button", class: "glpi-rt-icon-btn", title: t.unread, "aria-label": t.unread, onclick: () => void this.o.ctl.act({ action: "unread", id: latest.id }) }, icon("eye-off")));
    }
    if (g.queue === "new" && g.object.can_assign) {
      actions.append(h("button", { type: "button", class: "glpi-rt-icon-btn", title: t.assume, "aria-label": t.assume, onclick: () => void this.assume(g.key) }, icon("user-plus")));
    }
    return h(
      "li",
      { class: `glpi-rt-n${g.unread ? " is-unread" : ""}`, "data-key": g.key, "data-queue": g.queue },
      eventIcon(latest.event),
      h(
        "div",
        { class: "glpi-rt-n-body" },
        h("a", { class: "glpi-rt-n-title", href: href ?? "#", onclick: open, text: `#${g.object.id} ${g.object.title}` }),
        text,
        h(
          "div",
          { class: "glpi-rt-n-meta" },
          g.object.status_label ? h("span", { class: "badge glpi-rt-status", text: g.object.status_label }) : null,
          h("span", { text: actorName(list, latest.actor, t) }),
          h("span", { text: timeAgo(g.ts, new Date(), t), title: g.date }),
        ),
        sub,
      ),
      actions,
    );
  }

  private async assume(item: string): Promise<void> {
    await this.o.api.assign(item);
    await this.o.ctl.load();
  }

  preferences(): void {
    const list = this.o.ctl.list;
    if (!list) return;
    openPreferences(this.o.doc, list, this.o.t, async (prefs) => {
      await this.o.api.savePreferences(prefs);
      await this.o.ctl.load();
    });
  }
}

/**
 * Puts the bell in GLPI's header, just left of the global search bar
 * (`body > div.page > header > div`). The search block carries the `ms-lg-auto` that pushes
 * it right: the bell takes it over so that both stay together on the right.
 * Returns false when there is no such header or search bar (horizontal layout, popups).
 */
export function dock(doc: Document, bell: HTMLElement): boolean {
  const header = doc.querySelector("body > div.page > header > div");
  const form = header?.querySelector("form[role=search]");
  if (!header || !form) return false;
  let search: Element = form;
  while (search.parentElement && search.parentElement !== header) search = search.parentElement;
  if (search.parentElement !== header) return false;
  bell.classList.add("is-docked");
  if (search.classList.contains("ms-lg-auto")) {
    search.classList.replace("ms-lg-auto", "ms-lg-0");
    bell.classList.add("ms-lg-auto");
  }
  header.insertBefore(bell, search);
  return true;
}

/** Preferences dialog (Notifier+'s set). */
export function openPreferences(doc: Document, list: InboxList, t: Labels, save: (p: Partial<Preferences>) => Promise<void>): void {
  ensureStyle(doc);
  const p = list.preferences;
  const helpdesk = list.interface === "helpdesk";
  const box = (key: string, label: string) =>
    h("label", {}, h("input", { type: "checkbox", class: "form-check-input m-0", name: key, checked: !!p[key] }), label);
  // Named after the heading above it (screen readers announce the list's purpose).
  const select = (key: string, options: Record<string, string>, label: string) =>
    h("select", { class: "form-select form-select-sm", name: key, "aria-label": label }, ...Object.entries(options).map(([v, l]) => h("option", { value: v, selected: p[key] === v, text: l })));
  const types = Object.entries(t.p.types).map(([slug, label]) =>
    h(
      "tr",
      {},
      h("td", { text: label }),
      h("td", {}, h("input", { type: "checkbox", class: "form-check-input", name: `notify_${slug}_direct`, checked: !!p[`notify_${slug}_direct`], "aria-label": `${label} — ${t.p.direct}` })),
      h("td", {}, h("input", { type: "checkbox", class: "form-check-input", name: `notify_${slug}_group`, checked: !!p[`notify_${slug}_group`], "aria-label": `${label} — ${t.p.group}` })),
    ),
  );
  const form = h(
    "form",
    { class: "glpi-rt-prefs", role: "dialog", "aria-label": t.prefs },
    h("h2", { class: "h3", text: t.prefs }),
    ...(helpdesk ? [] : [
      h("h3", { text: t.p.receive }),
      h("table", {}, h("thead", {}, h("tr", {}, h("th"), h("th", { text: t.p.direct }), h("th", { text: t.p.group }))), h("tbody", {}, ...types)),
    ]),
    box("notify_mentions", t.p.mentions),
    list.can_see_others ? box("notify_others", t.p.others) : null,
    h("h3", { text: t.p.sound }),
    box("sound_enabled", t.p.sound),
    ...(helpdesk ? [] : Object.entries(t.p.soundQueues).map(([k, l]) => box(k, l))),
    desktopSupported(doc.defaultView ?? window)
      ? h("label", {}, h("input", { type: "checkbox", class: "form-check-input m-0", "data-desktop": "1", checked: desktopEnabled(doc.defaultView ?? window) }), t.p.desktop)
      : null,
    h("h3", { text: t.p.style }),
    select("update_message_style", t.p.styles, t.p.style),
    ...(helpdesk ? [] : [
      h("h3", { text: t.p.ended }),
      box("show_resolved", t.p.showResolved),
      box("show_closed", t.p.showClosed),
      select("resolved_closed_style", t.p.endedStyles, t.p.ended),
    ]),
    h(
      "div",
      { class: "glpi-rt-buttons" },
      h("button", { type: "button", class: "btn btn-outline-secondary", onclick: () => overlay.remove(), text: t.p.cancel }),
      h("button", { type: "submit", class: "btn btn-primary", text: t.p.save }),
    ),
  ) as HTMLFormElement;
  const overlay = h("div", { class: "glpi-rt-overlay", onclick: (e) => e.target === overlay && overlay.remove() }, form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const out: Record<string, boolean | string> = {};
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name], select[name]").forEach((el) => {
      out[el.name] = el instanceof HTMLInputElement ? el.checked : el.value;
    });
    // Per browser (permission asked here, on a user action), not a GLPI preference.
    const desk = form.querySelector<HTMLInputElement>("input[data-desktop]");
    if (desk && desk.checked !== desktopEnabled(doc.defaultView ?? window)) void setDesktop(desk.checked, doc.defaultView ?? window);
    void save(out as Partial<Preferences>).finally(() => overlay.remove());
  });
  doc.body.appendChild(overlay);
  form.querySelector<HTMLElement>("input, select")?.focus();
}
