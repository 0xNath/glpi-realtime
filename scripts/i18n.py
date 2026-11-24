#!/usr/bin/env python3
"""Plugin translations (GLPI gettext, domain "realtime"): for maintainers.

  scripts/i18n.py            extract __('...', 'realtime') into plugin/locales/realtime.pot,
                             update every plugin/locales/*.po (msgmerge), compile .mo (msgfmt)
  scripts/i18n.py --check    fail if the .pot is not up to date (CI)

Needs python3 and GNU gettext (msgmerge, msgfmt). Only calls with the "realtime" domain are
extracted: GLPI translates its own strings.
"""
import pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin"
LOCALES = PLUGIN / "locales"
CALL = re.compile(r"""__\(\s*(?P<q>['"])(?P<s>(?:\\.|(?!(?P=q)).)*)(?P=q)\s*,\s*['"]realtime['"]\s*\)""", re.S)

def unquote(s, q):
    return s.replace("\\" + q, q).replace("\\\\", "\\")

def po_escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")

def extract():
    found = {}
    for f in sorted([*PLUGIN.glob("*.php"), *PLUGIN.rglob("src/*.php"), *PLUGIN.rglob("ajax/*.php"), *PLUGIN.rglob("front/*.php")]):
        text = f.read_text()
        for m in CALL.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            found.setdefault(unquote(m["s"], m["q"]), []).append(f"{f.relative_to(PLUGIN)}:{line}")
    out = ['msgid ""', 'msgstr ""', '"Project-Id-Version: glpi-realtime\\n"', '"MIME-Version: 1.0\\n"',
           '"Content-Type: text/plain; charset=UTF-8\\n"', '"Content-Transfer-Encoding: 8bit\\n"', ""]
    for s, refs in sorted(found.items()):
        out += [f"#: {' '.join(refs)}"]
        if "%s" in s or "%d" in s:
            out += ["#, php-format"]
        out += [f'msgid "{po_escape(s)}"', 'msgstr ""', ""]
    return "\n".join(out)

pot = extract()
target = LOCALES / "realtime.pot"
if "--check" in sys.argv:
    sys.exit(0 if target.exists() and target.read_text() == pot else "plugin/locales/realtime.pot is out of date: run scripts/i18n.py")
LOCALES.mkdir(exist_ok=True)
target.write_text(pot)
for po in sorted(LOCALES.glob("*.po")):
    subprocess.run(["msgmerge", "--quiet", "--update", "--backup=none", "--no-fuzzy-matching", str(po), str(target)], check=True)
    subprocess.run(["msgfmt", "--check", "-o", str(po.with_suffix(".mo")), str(po)], check=True)
    print(f"{po.name}: compiled")
