import { eventText, type InboxItem, type InboxList, type Labels } from "./inbox.ts";

/**
 * Desktop notifications (the browser's Notification API) for new bell items while the GLPI
 * tab is in the background. Opt-in per browser (it asks for permission); the text comes
 * from the bell's list, which GLPI built after checking READ on each item.
 */

const KEY = "glpi-rt-desktop";

export function desktopSupported(win: Window = window): boolean {
  return "Notification" in win;
}

export function desktopEnabled(win: Window = window): boolean {
  try {
    return desktopSupported(win) && (win as any).Notification.permission === "granted" && win.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Turns them on (asking the browser) or off. Resolves to the resulting state. */
export async function setDesktop(on: boolean, win: Window = window): Promise<boolean> {
  try {
    if (!on || !desktopSupported(win)) {
      win.localStorage.setItem(KEY, "0");
      return false;
    }
    const N = (win as any).Notification;
    const perm = N.permission === "granted" ? "granted" : await N.requestPermission();
    win.localStorage.setItem(KEY, perm === "granted" ? "1" : "0");
    return perm === "granted";
  } catch {
    return false;
  }
}

/** What a desktop notification says for one bell item. */
export function desktopText(list: InboxList, it: InboxItem, t: Labels): { title: string; body: string; url: string } | null {
  const o = list.objects[it.key];
  if (!o) return null;
  return {
    title: `#${o.id} ${o.title}`.slice(0, 120),
    body: eventText(it, list.preferences.update_message_style, t),
    url: o.url,
  };
}

/** Shows up to three notifications for new items, when the tab is not visible. */
export function notifyDesktop(doc: Document, list: InboxList, fresh: InboxItem[], t: Labels): void {
  const win = doc.defaultView;
  if (!win || doc.visibilityState === "visible" || !desktopEnabled(win)) return;
  const N = (win as any).Notification;
  for (const it of fresh.slice(0, 3)) {
    const n = desktopText(list, it, t);
    if (!n) continue;
    // One per item: a newer event on the same ticket replaces the previous notification.
    const note = new N(n.title, { body: n.body, tag: `glpi-rt-${it.key}` });
    note.onclick = () => {
      win.focus();
      if (/^\/(?!\/)/.test(n.url)) win.location.href = n.url;
      note.close();
    };
  }
}
