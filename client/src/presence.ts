import type { State } from "./client.ts";
import { register } from "./i18n.ts";
import type { Avatar, PresenceUser } from "./protocol.ts";

/**
 * The tab's real-time link for an item, shown in its presence bar even when nobody else
 * is there: live; connecting (first attempt); retrying (lost, trying again); offline
 * (GLPI must issue a new session: reload); unavailable (not followed for this item).
 */
export type LiveStatus = "live" | "connecting" | "retrying" | "offline" | "unavailable";

export function liveStatus(state: State, retrying: boolean, joined: boolean, forbidden: boolean): LiveStatus {
  if (forbidden) return "unavailable";
  if (state === "open") return joined ? "live" : "connecting";
  if (state === "revoked" || state === "stopped") return "offline";
  if (state === "waiting" || retrying) return "retrying";
  return "connecting";
}

export const MAX_AVATARS = 5;

/** Other people on the item: the current user's own tabs are not shown. */
export function others(users: PresenceUser[], selfId: number | undefined): PresenceUser[] {
  return users.filter((u) => u.id !== selfId);
}

export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Stable color per user. */
export function hue(id: number): number {
  return (id * 137) % 360;
}

import { noun } from "./updates.ts";

interface Labels {
  also: string;
  more: (n: number) => string;
  active: string;
  inactive: string;
  /** Next to the dot when nobody else is there. */
  status: Record<LiveStatus, string>;
  /** The dot's tooltip and accessible name. */
  statusTitle: Record<LiveStatus, string>;
}

const LABELS = register<Record<string, Labels>>("presence", {
  fr: {
    also: "Également sur % :",
    more: (n) => `et ${n} autre${n > 1 ? "s" : ""}`,
    active: "actif sur %",
    inactive: "inactif (onglet en arrière-plan ou inutilisé)",
    status: { live: "En direct", connecting: "Connexion…", retrying: "Hors ligne", offline: "Hors ligne", unavailable: "Pas de temps réel" },
    statusTitle: {
      live: "Connecté au temps réel : les modifications et les personnes présentes s'affichent ici en direct.",
      connecting: "Connexion au temps réel…",
      retrying: "Connexion au temps réel perdue, nouvelle tentative en cours. Rechargez la page pour voir les dernières modifications.",
      offline: "Déconnecté du temps réel. Rechargez la page pour vous reconnecter.",
      unavailable: "Le temps réel n'est pas disponible pour cet élément.",
    },
  },
  en: {
    also: "Also on %:",
    more: (n) => `and ${n} more`,
    active: "active on %",
    inactive: "inactive (tab in background or unused)",
    status: { live: "Live", connecting: "Connecting…", retrying: "Offline", offline: "Offline", unavailable: "Not live" },
    statusTitle: {
      live: "Connected: changes and who is here show live.",
      connecting: "Connecting to the real-time server…",
      retrying: "Connection lost, trying again. Reload the page to see the latest changes.",
      offline: "Disconnected. Reload the page to connect again.",
      unavailable: "Real-time is not available for this item.",
    },
  },
});

/** Labels for an item type ("Également sur ce changement :"). */
export function labels(lang: string, itemtype = "Ticket"): Labels {
  const code = lang.slice(0, 2).toLowerCase() === "fr" ? "fr" : "en";
  const l = LABELS[code];
  const n = noun(itemtype, code).this;
  return { ...l, also: l.also.replace("%", n), active: l.active.replace("%", n) };
}

const STYLE_ID = "glpi-rt-presence-style";
const CSS = `
.glpi-rt-presence { display:flex; align-items:center; gap:.35rem; padding:0 .5rem; }
/* GLPI's title bar orders its children (1..3): stay after the navigation buttons. */
#navigationheader > .glpi-rt-presence { order:4; }
.glpi-rt-presence[hidden] { display:none !important; }
.glpi-rt-presence .glpi-rt-label { font-size:.75rem; color:var(--tblr-secondary, #667382); white-space:nowrap; }
.glpi-rt-presence .glpi-rt-avatars { display:flex; gap:.45rem; padding:3px; }
.glpi-rt-presence .glpi-rt-avatar { width:1.75rem; height:1.75rem; border-radius:50%; display:inline-flex;
  align-items:center; justify-content:center; font-size:.7rem; font-weight:600; color:#fff;
  background-size:cover; background-position:center;
  box-shadow:0 0 0 2px var(--tblr-bg-surface, #fff); cursor:default; transition:box-shadow .3s, opacity .3s; }
/* Ring: green = active on their tab, grey = inactive. */
.glpi-rt-presence .glpi-rt-avatar.is-active { box-shadow:0 0 0 2px var(--tblr-bg-surface, #fff), 0 0 0 4px var(--tblr-green, #2fb344); }
.glpi-rt-presence .glpi-rt-avatar.is-inactive { opacity:.55; box-shadow:0 0 0 2px var(--tblr-bg-surface, #fff), 0 0 0 4px var(--tblr-gray-400, #9ba9be); }
.glpi-rt-presence .glpi-rt-more { background:var(--tblr-secondary, #667382); }
/* The link's status: green live, amber connecting, red lost or offline, grey unavailable. */
.glpi-rt-presence .glpi-rt-status { width:.6rem; height:.6rem; border-radius:50%; flex:none; background:var(--tblr-gray-400, #9ba9be); }
.glpi-rt-presence .glpi-rt-status.is-live { background:var(--tblr-green, #2fb344); box-shadow:0 0 0 3px color-mix(in srgb, var(--tblr-green, #2fb344) 25%, transparent); }
.glpi-rt-presence .glpi-rt-status.is-connecting { background:var(--tblr-yellow, #f59f00); }
.glpi-rt-presence .glpi-rt-status.is-retrying, .glpi-rt-presence .glpi-rt-status.is-offline { background:var(--tblr-red, #d63939); }
@media (prefers-reduced-motion: no-preference) {
  .glpi-rt-presence .glpi-rt-status.is-connecting { animation:glpi-rt-blink 1.2s ease-in-out infinite; }
}
@keyframes glpi-rt-blink { 50% { opacity:.35; } }
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** Where to show the bar: GLPI's item title bar, else above the item. */
function anchor(doc: Document): { parent: Element; before: Node | null } | null {
  const header = doc.getElementById("navigationheader");
  if (header) return { parent: header, before: null };
  const container = doc.getElementById("itil-object-container");
  if (container) return { parent: container, before: container.firstChild };
  return null;
}

const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9/._~?=&%+,:;@-]{0,511}$/;
const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** What to draw for a user: GLPI's picture or initials, else our own fallback. */
export function look(u: PresenceUser): { picture: string | null; text: string; bg: string; fg: string } {
  const a: Partial<Avatar> = u.avatar ?? {};
  const picture = a.picture && SAFE_PATH.test(a.picture) ? a.picture : null;
  return {
    picture,
    text: picture ? "" : a.initials || initials(u.name),
    bg: a.color && COLOR.test(a.color) ? a.color : `hsl(${hue(u.id)} 55% 42%)`,
    fg: a.fg && COLOR.test(a.fg) ? a.fg : "#ffffff",
  };
}

/**
 * GLPI's own user card on hover, as on the actors of a ticket: same HTML (ajax/comments.php,
 * which applies GLPI's rights), same Bootstrap popover, same 300 ms hide delay, kept open
 * while the card itself is hovered. Unlike GLPI's helper, the card opens below the avatar
 * and is shifted to stay on screen instead of jumping to the side.
 */
const cards = new Map<number, Promise<string>>();

function cardHtml(id: number): Promise<string> {
  let p = cards.get(id);
  if (!p) {
    const $ = (globalThis as any).jQuery;
    const root: string = (globalThis as any).CFG_GLPI?.root_doc ?? "";
    p = $
      ? Promise.resolve($.ajax({ url: `${root}/ajax/comments.php`, type: "POST", data: { itemtype: "User", value: id } }))
          .then((html: unknown) => (typeof html === "string" ? html : ""))
          .catch(() => "")
      : Promise.resolve("");
    cards.set(id, p);
    // Pictures and names can change: do not keep cards forever.
    setTimeout(() => cards.delete(id), 5 * 60_000);
  }
  return p;
}

function attachCard(el: HTMLElement, id: number): void {
  const bs = (globalThis as any).bootstrap;
  if (!bs?.Popover) return;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let popover: any = null;
  const overCard = () => !!popover?.tip?.matches(":hover");
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (overCard() || el.matches(":hover")) return scheduleHide();
      popover?.hide();
    }, 300);
  };
  const show = async () => {
    clearTimeout(hideTimer);
    const html = await cardHtml(id);
    if (!html || !el.isConnected || !el.matches(":hover, :focus")) return;
    if (!popover) {
      popover = new bs.Popover(el, {
        html: true,
        sanitize: false, // GLPI's own HTML, as in GLPI's helper
        content: html,
        trigger: "manual",
        placement: "bottom",
        container: "body",
        customClass: "glpi-rt-card",
        popperConfig: (config: any) => ({
          ...config,
          modifiers: [
            ...(config.modifiers ?? []),
            { name: "flip", options: { fallbackPlacements: ["top"], altBoundary: false, altAxis: false } },
            { name: "preventOverflow", options: { padding: 8 } },
          ],
        }),
      });
    }
    document.querySelectorAll(".popover").forEach((p) => p !== popover.tip && p.classList.contains("glpi-rt-card") && p.remove());
    popover.show();
    popover.tip?.addEventListener("mouseleave", scheduleHide);
  };
  el.tabIndex = 0;
  el.addEventListener("mouseenter", show);
  el.addEventListener("focus", show);
  el.addEventListener("mouseleave", scheduleHide);
  el.addEventListener("blur", scheduleHide);
}

function disposeCard(el: Element): void {
  const bs = (globalThis as any).bootstrap;
  bs?.Popover?.getInstance?.(el)?.dispose?.();
}

function paint(el: HTMLElement, u: PresenceUser, status: string): void {
  const l = look(u);
  el.className = `glpi-rt-avatar ${u.active ? "is-active" : "is-inactive"}`;
  el.dataset.active = String(u.active);
  el.dataset.glpiAvatar = l.picture ? "picture" : "initials";
  el.style.backgroundImage = l.picture ? `url("${l.picture}")` : "";
  el.style.backgroundColor = l.picture ? "transparent" : l.bg;
  el.style.color = l.fg;
  el.textContent = l.text;
  el.setAttribute("aria-label", `${u.name} — ${status}`);
}

const lastUsers = new Map<string, PresenceUser[]>();
const lastStatus = new Map<string, LiveStatus>();

/** The link's status for `room` changed: its bar shows it (people are shown only when live). */
export function setStatus(doc: Document, room: string, status: LiveStatus, selfId: number | undefined): void {
  if (lastStatus.get(room) === status && doc.getElementById(barId(room))) return;
  lastStatus.set(room, status);
  render(doc, room, lastUsers.get(room) ?? [], selfId);
}

function barId(room: string): string {
  return `glpi-rt-presence-${room.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Renders the presence bar of `room`: the link's status, then who else is there.
 *  Avatars are updated in place, so that an open user card is not destroyed by an
 *  unrelated change. */
export function render(doc: Document, room: string, users: PresenceUser[], selfId: number | undefined): void {
  lastUsers.set(room, users);
  const status = lastStatus.get(room) ?? "connecting";
  const id = barId(room);
  let bar = doc.getElementById(id);
  if (!bar) {
    const at = anchor(doc);
    if (!at) return;
    ensureStyle(doc);
    bar = doc.createElement("div");
    bar.id = id;
    bar.className = "glpi-rt-presence";
    bar.setAttribute("data-room", room);
    bar.setAttribute("aria-live", "polite");
    const dot = doc.createElement("span");
    dot.className = "glpi-rt-status";
    dot.setAttribute("role", "img");
    const label = doc.createElement("span");
    label.className = "glpi-rt-label";
    const avatars = doc.createElement("span");
    avatars.className = "glpi-rt-avatars";
    bar.append(dot, label, avatars);
    at.parent.insertBefore(bar, at.before);
  }
  const label = bar.querySelector<HTMLElement>(".glpi-rt-label")!;
  const avatars = bar.querySelector<HTMLElement>(".glpi-rt-avatars")!;

  // Who else is here is only known while live.
  const list = status === "live" ? others(users, selfId) : [];
  bar.hidden = false;
  bar.dataset.status = status;
  const t = labels(doc.documentElement.lang || navigator.language || "en", room.split(":")[0]);
  const dot = bar.querySelector<HTMLElement>(".glpi-rt-status")!;
  dot.className = `glpi-rt-status is-${status}`;
  dot.title = t.statusTitle[status];
  dot.setAttribute("aria-label", t.statusTitle[status]);
  label.textContent = list.length ? t.also : t.status[status];

  const shown = list.slice(0, MAX_AVATARS);
  const existing = new Map<string, HTMLElement>();
  avatars.querySelectorAll<HTMLElement>(".glpi-rt-avatar[data-uid]").forEach((el) => existing.set(el.dataset.uid!, el));
  let prev: Element | null = null;
  for (const u of shown) {
    let el = existing.get(String(u.id));
    existing.delete(String(u.id));
    if (!el) {
      el = doc.createElement("span");
      el.dataset.uid = String(u.id);
      attachCard(el, u.id);
    }
    paint(el, u, u.active ? t.active : t.inactive);
    // (Re)ordered by arrival, moving only what is out of place: a moved element loses
    // :hover until the pointer moves again, and its user card would not open.
    const want: Element | null = prev ? prev.nextElementSibling : avatars.firstElementChild;
    if (want !== el) avatars.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) {
    disposeCard(el);
    el.remove();
  }

  avatars.querySelector(".glpi-rt-more")?.remove();
  const hiddenCount = list.length - MAX_AVATARS;
  if (hiddenCount > 0) {
    const more = doc.createElement("span");
    more.className = "glpi-rt-avatar glpi-rt-more";
    more.textContent = `+${hiddenCount}`;
    more.title = list.slice(MAX_AVATARS).map((u) => u.name).join(", ");
    more.setAttribute("aria-label", t.more(hiddenCount));
    avatars.appendChild(more);
  }
}
