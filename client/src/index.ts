import { ActivityTracker } from "./activity.ts";
import { glpiHeaders } from "./http.ts";
import { RealtimeClient } from "./client.ts";
import { Bell, InboxController } from "./bell.ts";
import { InboxApi, labelsFor } from "./inbox.ts";
import { FieldsEditor } from "./editor.ts";
import { applyCatalog, needsCatalog } from "./i18n.ts";
import { ListPresence } from "./list.ts";
import { LiveTimeline, TIMELINE_EVENTS } from "./timeline.ts";
import { Toasts } from "./notifications.ts";
import { InboxPage } from "./page.ts";
import { Chime } from "./sound.ts";
import { render } from "./presence.ts";
import { UpdatesBanner } from "./updates.ts";

declare global {
  interface Window {
    glpiRealtime?: RealtimeClient;
  }
}

const ROOM_ATTR = "data-glpi-realtime-room";

/** Rooms are announced by the plugin in the item forms (`post_item_form` hook). */
function roomsIn(root: ParentNode): string[] {
  const out: string[] = [];
  root.querySelectorAll?.(`[${ROOM_ATTR}]`).forEach((el) => {
    const room = el.getAttribute(ROOM_ATTR);
    if (room) out.push(room);
  });
  return out;
}

/**
 * Technicians get the bell (and the full page); the self-service interface, which GLPI
 * answers with `enabled: false`, gets toasts. The bell refreshes when the server pushes,
 * and polls every minute only while the WebSocket is down.
 */
function startInbox(client: RealtimeClient, rootDoc: string): void {
  const api = new InboxApi(rootDoc);
  const t = labelsFor(document.documentElement.lang || navigator.language || "en");
  void api.list().then((first) => {
    if (!first) {
      // The bell could not load (plugin tables not created yet?): toasts at least.
      const toasts = new Toasts(document, rootDoc);
      client.on("notification", (msg) => {
        if (msg.t === "notification" && msg.alert && msg.kind !== "inbox") toasts.show(msg, client.user?.id);
      });
      return;
    }
    const pageRoot = document.getElementById("glpi-rt-inbox-page");
    const ctl = new InboxController(api, !!pageRoot);
    if (pageRoot) {
      ctl.withRead = true;
      new InboxPage(pageRoot, ctl, api, t);
    } else {
      const chime = new Chime(window);
      new Bell({ doc: document, ctl, api, t, rootDoc, ring: () => chime.play() });
    }
    client.on("notification", (msg) => {
      if (msg.t === "notification") ctl.refresh(msg.alert);
    });
    // Reconnected: notifications may have been missed meanwhile.
    client.on("hello", () => ctl.refresh());
    setInterval(() => {
      if (client.state !== "open") ctl.refresh();
    }, 60_000);
    void ctl.load();
  });
}

/** Users who asked their system for less motion get no animation from us. */
function reducedMotion(): void {
  const style = document.createElement("style");
  style.textContent = `@media (prefers-reduced-motion: reduce) {
  [class*="glpi-rt-"], [class*="glpi-rt-"] *, .timeline-item.glpi-rt-new { animation: none !important; transition: none !important; }
}`;
  document.head.appendChild(style);
}

function boot(): void {
  if (window.glpiRealtime || !("WebSocket" in window)) return;
  reducedMotion();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const debug = localStorage?.getItem?.("glpi-realtime-debug") === "1" ? console.debug.bind(console) : undefined;
  const rootDoc: string = (window as any).CFG_GLPI?.root_doc ?? "";
  const client = new RealtimeClient({
    url: `${scheme}//${location.host}/ws`,
    debug,
    // Rights on the item may have changed: GLPI recomputes our grant (or removes it).
    regrant: (room) => {
      const [itemtype, id] = room.split(":");
      const q = new URLSearchParams({ itemtype, id });
      return fetch(`${rootDoc}/plugins/realtime/ajax/grant.php?${q}`, {
        credentials: "same-origin",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
    },
  });
  window.glpiRealtime = client;

  const activity = new ActivityTracker({ doc: document, win: window, onChange: (a) => client.setActive(a) });
  client.setActive(activity.reported);
  for (const room of roomsIn(document)) client.subscribe(room);

  client.on("presence", (msg) => {
    // Rows of a list are drawn by ListPresence; the bar is for the item being displayed.
    if (msg.t === "presence" && (client.isJoined(msg.room) || !client.isWatched(msg.room))) {
      render(document, msg.room, msg.users, client.user?.id);
    }
  });

  // Lists of tickets, changes and problems: who is on each row.
  let list: ListPresence | null = null;
  const followList = () => {
    if (!document.querySelector("table.search-results")) return;
    list ??= new ListPresence(
      document,
      client,
      async (items) => {
        const resp = await fetch(`${rootDoc}/plugins/realtime/ajax/grants.php`, {
          method: "POST",
          credentials: "same-origin",
          headers: glpiHeaders(document, true),
          body: JSON.stringify({ items }),
        });
        const data = resp.ok ? await resp.json() : null;
        return Array.isArray(data?.rooms) ? data.rooms : [];
      },
      document.documentElement.lang || navigator.language || "en",
    );
    list.scan();
  };
  followList();
  const banner = new UpdatesBanner(document);
  client.on("event", (msg) => {
    if (msg.t !== "event") return;
    // Our own change made from this very tab: the page already shows it.
    if (msg.by.id === client.user?.id && document.hasFocus()) return;
    // Followups, tasks, solutions... are added to the timeline live: no "refresh" banner.
    if (document.querySelector(".itil-timeline") && TIMELINE_EVENTS.test(msg.kind)) return;
    banner.add(msg.room, msg, client.user?.id);
  });
  client.on("unsubscribed", (msg) => {
    if (msg.t !== "unsubscribed" || msg.reason !== "forbidden") return;
    banner.lost(msg.room);
    render(document, msg.room, [], client.user?.id);
  });
  startInbox(client, rootDoc);

  // Single editor for the ticket fields, on the item form only (GLPI's own lock, when
  // enabled, removes the Save button: then there is nothing to coordinate).
  // Single editor for the ticket fields. The ticket form arrives with its tab, after the
  // page (and again when the tab reloads): created when it appears, then follows it.
  // GLPI's own lock, when enabled, removes the Save button: nothing to coordinate then.
  let editor: FieldsEditor | null = null;
  let timeline: LiveTimeline | null = null;
  const followForm = () => {
    // The timeline of the same tab: placeholders of who is writing, items added live.
    if (!timeline && document.querySelector(".itil-timeline")) {
      const room = roomsIn(document)[0];
      if (room) timeline = new LiveTimeline(document, client, room, document.documentElement.lang || navigator.language || "en");
    }
    if (editor) return editor.attach();
    if (!document.getElementById("itil-form") || !document.querySelector("button[name='update'][form='itil-form']")) return;
    const room = roomsIn(document)[0];
    if (room) editor = new FieldsEditor(document, client, room, document.documentElement.lang || navigator.language || "en");
  };
  followForm();

  // Connection lost: the list is unknown until the server sends it again.
  client.on("bye", () => {
    document.querySelectorAll<HTMLElement>(".glpi-rt-presence").forEach((el) => (el.hidden = true));
  });

  // GLPI loads tabs and forms dynamically: follow the DOM.
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        const own = n.getAttribute(ROOM_ATTR);
        if (own) client.subscribe(own);
        for (const room of roomsIn(n)) client.subscribe(room);
      });
    }
    followForm();
    followList();
  }).observe(document.body, { childList: true, subtree: true });

  client.start();
}

/** Other languages than French and English: their texts, before anything is drawn. */
async function start(): Promise<void> {
  const lang = document.documentElement.lang || navigator.language || "en";
  if (needsCatalog(lang)) {
    const root: string = (window as any).CFG_GLPI?.root_doc ?? "";
    try {
      const resp = await fetch(`${root}/plugins/realtime/ajax/i18n.php`, { credentials: "same-origin" });
      if (resp.ok) applyCatalog(await resp.json());
    } catch {
      /* English then */
    }
  }
  boot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
} else {
  void start();
}
