const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "..", "dashboard", "index.html"), "utf8");

function extractFunction(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error("Route optimizer source markers missing: " + startMarker);
  return html.slice(start, end).trim();
}

const haversine = extractFunction("function haversine(a, b) {", "function twoOptImprove(depot, route) {");
const twoOpt = extractFunction("function twoOptImprove(depot, route) {", "function optimizeRoute(depot, stops) {");
const optimize = extractFunction("function optimizeRoute(depot, stops) {", "function totalDist(depot, route) {");
const totalDistSource = extractFunction("function totalDist(depot, route) {", "async function buildRouteOptimizer() {");
const funcs = new Function(
  haversine + "\n" + twoOpt + "\n" + optimize + "\n" + totalDistSource +
  "\nreturn { haversine, twoOptImprove, optimizeRoute, totalDist };"
)();

const depot = { lat: 0, lng: 0 };
const stops = [
  { id: "A", lat: 1, lng: 0 },
  { id: "B", lat: 1, lng: 1 },
  { id: "C", lat: 0, lng: 1 },
  { id: "D", lat: 2, lng: 0 }
];

function greedyRoute(depot, stops) {
  const remaining = [...stops], route = [];
  let current = depot;
  while (remaining.length) {
    let nearestIndex = 0, nearestDistance = Infinity;
    remaining.forEach((stop, i) => {
      const distance = funcs.haversine(current, stop);
      if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = i; }
    });
    route.push(remaining.splice(nearestIndex, 1)[0]);
    current = route[route.length - 1];
  }
  return route;
}

const beforeRoute = greedyRoute(depot, stops);
const beforeDistance = funcs.totalDist(depot, beforeRoute);
const originalOrder = stops.map(s => s.id).join(",");
const optimized = funcs.optimizeRoute(depot, stops);
const afterDistance = funcs.totalDist(depot, optimized);

assert.equal(optimized.length, stops.length, "Optimization must keep every stop");
assert.equal(new Set(optimized.map(s => s.id)).size, stops.length, "Optimization must not duplicate stops");
assert.ok(afterDistance < beforeDistance - 0.1, "2-opt should improve the synthetic crossing route");
assert.equal(stops.map(s => s.id).join(","), originalOrder, "Optimization must not mutate input order");

let previous = depot;
for (const stop of optimized) {
  assert.ok(Number.isFinite(stop.distFromPrev), "Each stop must have a finite distance-from-previous value");
  assert.ok(Math.abs(stop.distFromPrev - funcs.haversine(previous, stop)) < 1e-6, "Distance labels must be recalculated after reordering");
  previous = stop;
}

assert.deepEqual(funcs.optimizeRoute(depot, []), [], "Empty route should remain empty");
assert.equal(funcs.optimizeRoute(depot, [stops[0]]).length, 1, "Single-stop route should remain valid");
assert.equal(funcs.optimizeRoute(depot, stops.slice(0, 2)).length, 2, "Two-stop route should remain valid");

console.log("Route optimizer test passed: " + beforeDistance.toFixed(2) + " km greedy → " + afterDistance.toFixed(2) + " km after 2-opt (synthetic straight-line test).");
