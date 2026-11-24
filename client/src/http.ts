/**
 * Headers of the client's requests to GLPI. GLPI 11 checks a CSRF token on every AJAX POST
 * (X-Glpi-Csrf-Token, from the page's `glpi:csrf_token` meta); GLPI 12 relies on the
 * browser's Sec-Fetch-Site instead and has no such meta: the header is then left out.
 */
export function glpiHeaders(doc: Document | undefined = globalThis.document, json = false): Record<string, string> {
  const h: Record<string, string> = { "X-Requested-With": "XMLHttpRequest" };
  const token = doc?.querySelector<HTMLMetaElement>('meta[property="glpi:csrf_token"]')?.content;
  if (token) h["X-Glpi-Csrf-Token"] = token;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
