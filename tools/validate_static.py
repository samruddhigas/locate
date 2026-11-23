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

# Guard against accidental truncation of the single-file Dashboard.
dashboard_path = PAGES[0]
if dashboard_path.exists():
    dashboard_size = dashboard_path.stat().st_size
    if dashboard_size < 100_000:
        failures.append(f"Dashboard unexpectedly small ({dashboard_size} bytes); possible partial overwrite")
    dashboard_source = dashboard_path.read_text(encoding="utf-8")
    for marker in ("<!DOCTYPE html>", "const DELIVERY_APP_HTML = ", "function getMergedConsumers()", "function showHistory(consumerNo)", "</html>"):
        if marker not in dashboard_source:
            failures.append("Dashboard missing required structure: " + marker)

# Extract the generated DeliveryApp template without evaluating any active interpolation.
template_marker = "const DELIVERY_APP_HTML = "
template_pos = dashboard_source.find(template_marker)
if template_pos < 0:
    failures.append("Could not locate generated DeliveryApp template")
else:
    template_pos += len(template_marker)
    while template_pos < len(dashboard_source) and dashboard_source[template_pos].isspace():
        template_pos += 1
    if template_pos >= len(dashboard_source) or dashboard_source[template_pos] != "`":
        failures.append("Generated DeliveryApp template opening delimiter missing")
    else:
        template_pos += 1
        template_end = -1
        for i in range(template_pos, len(dashboard_source)):
            if dashboard_source[i] == "`":
                slash_count = 0
                j = i - 1
                while j >= 0 and dashboard_source[j] == "\\":
                    slash_count += 1
                    j -= 1
                if slash_count % 2 == 0:
                    template_end = i
                    break
        if template_end < 0:
            failures.append("Generated DeliveryApp template closing delimiter missing")
        else:
            raw_template = dashboard_source[template_pos:template_end]
            active_interpolations = []
            for i in range(len(raw_template) - 1):
                if raw_template[i:i+2] == "${":
                    slash_count = 0
                    j = i - 1
                    while j >= 0 and raw_template[j] == "\\":
                        slash_count += 1
                        j -= 1
                    if slash_count % 2 == 0:
                        active_interpolations.append(i)
            if active_interpolations:
                failures.append("Generated DeliveryApp template has active interpolation; safe extraction needs updating")
            else:
                node_script = "const generated = `" + raw_template + "\n`; process.stdout.write(generated);"
                decoded = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
                if decoded.returncode:
                    failures.append("Generated DeliveryApp template decoding failed: " + decoded.stderr.strip())
                else:
                    generated_parser = PageParser()
                    generated_parser.feed(decoded.stdout)
                    duplicate_ids = sorted({x for x in generated_parser.ids if generated_parser.ids.count(x) > 1})
                    if duplicate_ids:
                        failures.append("Generated DeliveryApp duplicate IDs: " + str(duplicate_ids))
                    with tempfile.TemporaryDirectory() as generated_td:
                        generated_temp = Path(generated_td)
                        for i, script in enumerate(generated_parser.scripts, 1):
                            jsfile = generated_temp / f"generated_deliveryapp_{i}.js"
                            jsfile.write_text(script["text"], encoding="utf-8")
                            result = subprocess.run(["node", "--check", str(jsfile)], capture_output=True, text=True)
                            if result.returncode:
                                failures.append(f"Generated DeliveryApp inline script {i} syntax error: {result.stderr.strip()}")
                    print(f"Generated DeliveryApp template: checked {len(generated_parser.ids)} IDs and {len(generated_parser.scripts)} inline scripts.")

print(f"Checked {checked_pages} HTML pages and {checked_scripts} inline scripts.")
if failures:
    print("\n".join(f"FAIL: {x}" for x in failures))
    raise SystemExit(1)
print("Static validation passed.")
