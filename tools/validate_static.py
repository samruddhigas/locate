#!/usr/bin/env python3
"""Static validation for the Samruddhi Locate pages and DeliveryApp mirror."""
from html.parser import HTMLParser
from pathlib import Path
import json
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PAGES = [
    ROOT / "dashboard" / "index.html",
    ROOT / "consumer-location" / "index.html",
    ROOT / "deliveryapp" / "index.html",
]

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.scripts = []
        self.current_script = None
        self.assets = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "script":
            typ = (attrs.get("type") or "").lower()
            if "src" not in attrs and (not typ or typ in ("text/javascript", "application/javascript", "module")):
                self.current_script = {"type": typ, "text": ""}
                self.scripts.append(self.current_script)
            else:
                self.current_script = None
        if tag in ("script", "link", "img"):
            attr = "src" if tag in ("script", "img") else "href"
            value = attrs.get(attr, "")
            if value:
                self.assets.append(value)
    def handle_data(self, data):
        if self.current_script is not None:
            self.current_script["text"] += data
    def handle_endtag(self, tag):
        if tag == "script":
            self.current_script = None

def local_asset(page, value):
    value = value.strip()
    if not value or value.startswith(("#", "data:", "mailto:", "tel:")):
        return None
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value) or value.startswith("//"):
        return None
    value = value.split("?", 1)[0].split("#", 1)[0]
    if not value:
        return None
    return (page.parent / value).resolve()

failures = []
checked_scripts = 0
checked_pages = 0
with tempfile.TemporaryDirectory() as td:
    temp = Path(td)
    for page in PAGES:
        if not page.exists():
            failures.append(f"Missing page: {page.relative_to(ROOT)}")
            continue
        checked_pages += 1
        parser = PageParser()
        parser.feed(page.read_text(encoding="utf-8"))
        duplicates = sorted({x for x in parser.ids if parser.ids.count(x) > 1})
        if duplicates:
            failures.append(f"{page.relative_to(ROOT)} duplicate IDs: {duplicates}")
        for asset in parser.assets:
            resolved = local_asset(page, asset)
            if resolved is not None and not resolved.exists():
                failures.append(f"{page.relative_to(ROOT)} missing local asset: {asset}")
        for i, script in enumerate(parser.scripts, 1):
            jsfile = temp / f"{page.stem}_{checked_scripts+1}_{i}.js"
            jsfile.write_text(script["text"], encoding="utf-8")
            result = subprocess.run(["node", "--check", str(jsfile)], capture_output=True, text=True)
            checked_scripts += 1
            if result.returncode:
                failures.append(f"{page.relative_to(ROOT)} inline script {i} syntax error: {result.stderr.strip()}")

for js in (ROOT / "deliveryapp" / "app.js", ROOT / "deliveryapp" / "sw.js"):
    if not js.exists():
        failures.append(f"Missing JS file: {js.relative_to(ROOT)}")
    else:
        result = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
        if result.returncode:
            failures.append(f"{js.relative_to(ROOT)} syntax error: {result.stderr.strip()}")

manifest = ROOT / "deliveryapp" / "manifest.json"
try:
    json.loads(manifest.read_text(encoding="utf-8"))
except Exception as exc:
    failures.append(f"Invalid DeliveryApp manifest: {exc}")

print(f"Checked {checked_pages} HTML pages and {checked_scripts} inline scripts.")
if failures:
    print("\n".join(f"FAIL: {x}" for x in failures))
    raise SystemExit(1)
print("Static validation passed.")
