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

# Keep the WhatsApp customer links on the canonical root location page.
legacy_capture_page = ROOT / "consumer-location" / "index.html"
if legacy_capture_page.exists():
    legacy_source = legacy_capture_page.read_text(encoding="utf-8")
    if "window.location.search" not in legacy_source or "window.location.hash" not in legacy_source or "window.location.replace" not in legacy_source:
        failures.append("Legacy consumer-location page must redirect to the canonical page while preserving token query and hash")
dashboard_source_for_links = dashboard_path.read_text(encoding="utf-8") if dashboard_path.exists() else ""
if "function consumerCapturePageUrl() {\n  return getBaseUrl() + '/';\n}" not in dashboard_source_for_links:
    failures.append("Dashboard WhatsApp GPS links must use the canonical root customer location page")
customer_page = ROOT / "index.html"
if customer_page.exists():
    customer_source = customer_page.read_text(encoding="utf-8")
    if "function setConsumerMapLayer(which)" not in customer_source or "setConsumerMapLayer('satellite')" not in customer_source:
        failures.append("Canonical customer location page is missing road/satellite map controls")

# GPS end-to-end source-contract checks. These catch regressions where a mirror
# or embedded app silently reintroduces weak/zero GPS or bypasses visit verification.
consumer_source = customer_source
delivery_js_path = ROOT / "deliveryapp" / "app.js"
delivery_js_source = delivery_js_path.read_text(encoding="utf-8") if delivery_js_path.exists() else ""
api_path = ROOT / "supabase" / "functions" / "lpg-api" / "index.ts"
api_source = api_path.read_text(encoding="utf-8") if api_path.exists() else ""
gps_migration = ROOT / "supabase" / "migrations" / "20261126061457_gps_capture_integrity_and_required_delivery_visit_fix.sql"
gps_checks = [
    ("consumer GPS watch uses fresh high-accuracy readings", "timeout:45000,maximumAge:0" in consumer_source),
    ("consumer capture has a 45-second bounded window", "},45000);" in consumer_source),
    ("consumer map can display weak fixes without allowing weak submission", "function showEntranceMap(c,allowWeakFix=false)" in consumer_source and "GPS accuracy is ±" in consumer_source),
    ("consumer permission denial is distinguished from transient GPS errors", "if(err&&err.code===1)" in consumer_source),
    ("consumer GPS uses a parallel one-shot high-accuracy fallback", "getCurrentPosition(onGPSReading,onGPSError" in consumer_source),
    ("consumer sends its retained GPS sample series to the server", "readings:_readings.slice(-20)" in consumer_source),
    ("consumer weak-fix map has an in-map GPS refresh action", "function retryConsumerGps()" in consumer_source),
    ("delivery completion does not reuse the warm location watcher", "captureMode!=='delivery_after_mark_delivered'&&_gpsFix" in delivery_js_source),
    ("delivery GPS refines a good fix before stopping", "Date.now()-startedAt>=5000" in delivery_js_source),
    ("delivery GPS has a 30-second acquisition window", "}},30000);" in delivery_js_source or ")),30000);" in delivery_js_source),
    ("standalone delivery app opens the draggable pin map for every GPS capture", "const selected=await chooseGpsPin(r,best);" in delivery_js_source),
    ("standalone pin confirmation is disabled above 30 m accuracy", "pinPickerConfirm').disabled=offset>500||!accuracyOk" in delivery_js_source),
    ("standalone delivery app uses a one-shot GPS fallback", "getCurrentPosition(acceptPosition,acceptError" in delivery_js_source),
    ("standalone entrance map can refresh GPS without leaving the map flow", "pinPickerRetry').onclick=()=>finish({retry:true})" in delivery_js_source),
    ("delivery completion timestamp starts after pin confirmation", "record.completed_at=new Date().toISOString();" in delivery_js_source),
    ("embedded dashboard delivery capture uses fresh GPS", "captureMode!=='delivery_after_mark_delivered'&&_gps" in dashboard_source),
    ("embedded dashboard delivery capture refines GPS before stopping", "Date.now()-startedAt>=5000" in dashboard_source),
    ("embedded dashboard delivery capture has a 30-second window", ")),30000);" in dashboard_source),
    ("embedded delivery app opens the map for every capture", "const pinConfirmed=await new Promise" in dashboard_source and "showDeliveryGpsPin(d,best)" in dashboard_source),
    ("embedded delivery map blocks weak accuracy", "deliveryGpsPinSave').disabled=offset>500||!accuracyOk" in dashboard_source),
    ("embedded delivery app uses one-shot GPS fallback", "getCurrentPosition(acceptPosition,acceptError" in dashboard_source),
    ("embedded entrance map can refresh GPS in place", "function retryDeliveryGpsPin()" in dashboard_source and "pinConfirmed==='retry'" in dashboard_source),
    ("offline delivery sync sends GPS before completion", "await flushPendingDeliveryGps();await flushPendingDeliveryCompletions();" in dashboard_source),
    ("office approval map plots all pending and approved GPS pins", "Object.entries(STATE.gpsApprovals).forEach" in dashboard_source and "Object.entries(STATE.consumerGPS).forEach" in dashboard_source),
    ("office route map plots every optimized stop pin", "route.optimized.forEach((stop, si)" in dashboard_source and "L.marker([stop.coords.lat, stop.coords.lng]" in dashboard_source),
    ("server rejects zero accuracy", "!Number.isFinite(acc) || acc <= 0 || acc > 30" in api_source),
    ("server requires the exact booking GPS history row", '.eq("booking_key",bookingKey).eq("consumer_no",consumerNo).eq("captured_by",user.name)' in api_source),
    ("server blocks completion without a valid visit GPS row", "Delivery cannot be marked done: a fresh GPS reading for this exact booking" in api_source),
    ("server no longer falls back to the general consumer GPS pin", 'const {data:gps,error:gpsError}=await db.from("lpg_gps")' not in api_source),
    ("database GPS integrity migration is committed", gps_migration.exists()),
]
for label, passed in gps_checks:
    if not passed:
        failures.append("GPS contract: " + label)
print(f"GPS source contracts: {sum(1 for _, passed in gps_checks if passed)}/{len(gps_checks)} passed.")

api_test = subprocess.run(["node", str(ROOT / "tools" / "test_api_contract.js")], capture_output=True, text=True)
if api_test.returncode:
    failures.append("API contract tests failed: " + api_test.stderr.strip())
else:
    print(api_test.stdout.strip())

route_test = subprocess.run(["node", str(ROOT / "tools" / "test_route_optimizer.js")], capture_output=True, text=True)
if route_test.returncode:
    failures.append("Route optimizer tests failed: " + route_test.stderr.strip())
else:
    print(route_test.stdout.strip())

print(f"Checked {checked_pages} HTML pages and {checked_scripts} inline scripts.")
if failures:
    print("\n".join(f"FAIL: {x}" for x in failures))
    raise SystemExit(1)
print("Static validation passed.")
