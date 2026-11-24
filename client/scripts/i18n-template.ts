// Writes plugin/locales/client/template.json: every client text, in English, with {0}… for
// values. Copy it to <lang>.json (e.g. de_DE.json) and translate the texts.
//   npm run i18n-template
import { writeFileSync } from "node:fs";

import "../src/updates.ts";
import "../src/presence.ts";
import "../src/editor.ts";
import "../src/timeline.ts";
import "../src/drafts.ts";
import "../src/notifications.ts";
import "../src/inbox.ts";
import { template } from "../src/i18n.ts";

const out = new URL("../../plugin/locales/client/template.json", import.meta.url);
writeFileSync(out, JSON.stringify(template(), null, 2) + "\n");
console.log(`written ${out.pathname}`);
