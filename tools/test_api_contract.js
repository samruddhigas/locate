const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const api = fs.readFileSync(path.join(root, "supabase", "functions", "lpg-api", "index.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "deliveryapp", "app.js"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "dashboard", "index.html"), "utf8");

function section(start, end) {
  const a = api.indexOf(start), b = api.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "Missing API source section: " + start);
  return api.slice(a, b);
}

const pendingImport = section('if (action === "import_pending" || action === "import_delivered")', 'if (action === "archive_delivered")');
assert.ok(!pendingImport.includes("responseData"), "GPS enrichment must not be inserted into the pending import response");
assert.ok(pendingImport.includes('db.rpc(functionName'), "Pending import must continue to use its atomic database RPC");

const completion = section('if (action === "delivery_completion")', 'if (action === "locations_manage")');
assert.ok(completion.includes('user.role !== "delivery"'), "Only delivery accounts may submit completion");
assert.ok(completion.includes('from("lpg_pending")'), "Completion must verify current booking assignment");
assert.ok(completion.includes('from("lpg_gps")'), "Completion must verify server-saved GPS");
assert.ok(completion.includes('from("lpg_delivery_completions")'), "Completion must persist centrally");

const routes = section('if (action === "route_manage")', 'if (action === "delivery_completion")');
assert.ok(routes.includes('status==="approved"') || routes.includes('status === "approved"'), "Route publication must use approved GPS pins");
assert.ok(routes.includes('from("lpg_delivery_routes")'), "Route versions must be stored centrally");
assert.ok(routes.includes('from("lpg_delivery_route_stops")'), "Route stops must be stored centrally");
assert.ok(routes.includes('from("lpg_pending")'), "Published route stops must be checked against assigned bookings");

const genericDb = section('const { data, error } = await query;\n\n    if (error)', 'return Response.json(\n      { error: "Invalid request"');
assert.ok(genericDb.includes('table === "lpg_pending"'), "Delivery pending reads should be scoped for GPS enrichment");
assert.ok(genericDb.includes('from("lpg_gps")'), "Approved GPS should be joined to the delivery user's own bookings");
assert.ok(genericDb.includes('return Response.json({ data: responseData }'), "GPS enrichment must be in the generic database response");

const gpsManage = section('if (action === "gps_manage")', 'if (action === "preview_delivered_csv"');
assert.ok(gpsManage.includes('update({status:"rejected"})'), "Reject must preserve the GPS record with rejected status");
assert.ok(gpsManage.includes('if (op === "delete")'), "Permanent GPS deletion must remain a separate admin action");

const locations = section('if (action === "locations_manage")', 'if (action === "gps_search_consumers")');
assert.ok(locations.includes('["create","update"].includes(op)'), "Set-default/deactivate must not require create/update fields");
assert.ok(api.includes("Too many failed attempts"), "Login rate limiting must remain enabled");
assert.ok(api.includes("Each staff member must have a different PIN"), "New staff accounts must not reuse another user's PIN");
assert.ok(api.includes('name: "PBKDF2"'), "New PIN hashes must use PBKDF2");
assert.ok(api.includes("310000"), "PIN hashing must use a high iteration count");
assert.ok(api.includes("hashPinLegacy"), "Existing PINs must remain verifiable during safe hash migration");
assert.ok(api.includes("pin_fingerprint"), "PIN reuse checks must cover legacy and upgraded accounts");
assert.ok(api.includes("PIN security upgrade could not be saved"), "Legacy PIN hashes must upgrade on successful login");
const userManagement = section('if (action === "users_manage")', 'if (action === "gps_search_consumers")');
assert.ok(userManagement.includes('op === "list"'), "User list must be returned through the authenticated API");
assert.ok(userManagement.includes('op === "reset_pin"'), "Admin must be able to reset an existing user's PIN");
assert.ok(userManagement.includes('op === "set_active"'), "Admin must be able to enable or disable user accounts");
assert.ok(!dashboard.includes("DB._client.table('lpg_users')"), "Dashboard must not bypass protected user management API");

assert.ok(app.includes("action:'delivery_completion',op:'save'"), "DeliveryApp must save completion centrally");
assert.ok(app.includes("pendingCompletions"), "DeliveryApp must retain and retry offline completions");
assert.ok(app.includes("action:'route_manage',op:'list'"), "DeliveryApp must load office-published routes");
assert.ok(dashboard.includes("async function publishSelectedRoute()"), "Office dashboard must provide route publishing");
assert.ok(dashboard.includes("stopType==='approved_consumer_gps'"), "Office dashboard must publish only approved GPS stops");

console.log("API contract tests passed: GPS gate, central completion, offline queue, approved GPS routes, import isolation, and security guards.");
