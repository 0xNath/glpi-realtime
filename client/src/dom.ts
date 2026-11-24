/**
 * Element builder. Text only: values from GLPI (titles, names) are never parsed as HTML.
 */
type Attrs = Record<string, string | number | boolean | undefined | ((ev: Event) => void)>;
type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function icon(name: string): HTMLElement {
  return h("i", { class: `ti ti-${name}`, "aria-hidden": "true" });
}

/** Same-origin relative links only (GLPI form URLs). */
export function safeHref(url: string): string | null {
  return /^\/(?!\/)[A-Za-z0-9/._~?=&%+-]*$/.test(url) ? url : null;
}
