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
  Object.assign(globalThis, {
    window,
    document,
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
