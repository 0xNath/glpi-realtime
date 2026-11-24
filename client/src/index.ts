import { ActivityTracker } from "./activity.ts";
import { RealtimeClient } from "./client.ts";
import { render } from "./presence.ts";

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

function boot(): void {
  if (window.glpiRealtime || !("WebSocket" in window)) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const debug = localStorage?.getItem?.("glpi-realtime-debug") === "1" ? console.debug.bind(console) : undefined;
  const client = new RealtimeClient({ url: `${scheme}//${location.host}/ws`, debug });
  window.glpiRealtime = client;

  const activity = new ActivityTracker({ doc: document, win: window, onChange: (a) => client.setActive(a) });
  client.setActive(activity.reported);
  for (const room of roomsIn(document)) client.subscribe(room);

  client.on("presence", (msg) => {
    if (msg.t === "presence") render(document, msg.room, msg.users, client.user?.id);
  });
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
  }).observe(document.body, { childList: true, subtree: true });

  client.start();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
