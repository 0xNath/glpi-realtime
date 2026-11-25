import { parseHTML } from "linkedom";
// Never compare DOM elements in assertions (assert.equal(el, null)): a failure would print
// a linkedom element, whose references span the whole document (it exhausted memory).

/**
 * A fresh document without a browser (linkedom), set as the globals the client's code uses.
 * linkedom lacks a few things the client relies on; they are filled in here.
 */
export function page(html = "<!doctype html><html><head></head><body></body></html>") {
  const { window, document } = parseHTML(html);
  // No `checked` property: reflected on the attribute (a browser keeps them apart, which
  // nothing in the client relies on).
  if (!Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")) {
    Object.defineProperty(window.HTMLInputElement.prototype, "checked", {
      get(this: Element) { return this.hasAttribute("checked"); },
      set(this: Element, v: boolean) { this.toggleAttribute("checked", !!v); },
    });
  }
  // No default action on click: a checkbox toggles, then gets click and change, as in a browser.
  const proto = window.HTMLInputElement.prototype as any;
  if (!proto.__rtClick) {
    const click = proto.click;
    proto.__rtClick = true;
    proto.click = function (this: HTMLInputElement) {
      if (this.getAttribute("type") !== "checkbox") return click ? click.call(this) : this.dispatchEvent(new window.Event("click", { bubbles: true }));
      this.checked = !this.checked;
      this.dispatchEvent(new window.Event("click", { bubbles: true }));
      this.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
  }
  // No form.elements: the form's controls (a browser also lists those outside it with
  // form="id"; the client adds those itself).
  if ((document.createElement("form") as any).elements === undefined) {
    Object.defineProperty(Object.getPrototypeOf(document.createElement("form")), "elements", {
      get(this: Element) { return Array.from(this.querySelectorAll("input, select, textarea, button")); },
      configurable: true,
    });
  }
  // No focus model: the page has the focus, on its body unless a test says otherwise.
  const d = document as any;
  if (d.activeElement === undefined) Object.defineProperty(d, "activeElement", { get: () => d.focused ?? d.body, configurable: true });
  if (typeof d.hasFocus !== "function") d.hasFocus = () => d.pageFocused ?? true;
  // No Node.DOCUMENT_POSITION_* constants (compareDocumentPosition itself works).
  const N = window.Node as any;
  if (N.DOCUMENT_POSITION_FOLLOWING === undefined) {
    Object.assign(N, { DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16 });
  }
  Object.assign(globalThis, {
    window,
    document,
    Element: window.Element,
    Node: window.Node,
    DOMParser: window.DOMParser,
    // CSS.escape for identifiers (Node has no CSS object).
    CSS: { escape: (v: string) => String(v).replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`) },
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
  });
  return { window, document: document as unknown as Document };
}

/** An event of `type` (linkedom has no KeyboardEvent: extra fields are set on an Event). */
export function event(type: string, fields: Record<string, unknown> = {}, init: EventInit = {}): Event {
  return Object.assign(new (globalThis as any).window.Event(type, init), fields);
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
