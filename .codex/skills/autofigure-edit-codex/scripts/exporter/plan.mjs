/** Resolve explicit semantic replacements without duplicating their source leaves. */
import { attr, number, bounds, frame, commands, localStyle, worldMatrix } from "./svg.mjs";
import { commandBounds, primitiveCommands } from "./geometry.mjs";

const kinds = new Set(["shape", "custom", "connector", "text", "vector", "image", "table", "chart", "background"]);
const contains = (parent, child) => {
  for (let node = child; node; node = node.parent) if (node === parent) return true;
  return false;
};
const union = (boxes) => {
  const left = Math.min(...boxes.map((b) => b.left)), top = Math.min(...boxes.map((b) => b.top));
  return { left, top, width: Math.max(...boxes.map((b) => b.left + b.width)) - left, height: Math.max(...boxes.map((b) => b.top + b.height)) - top };
};

/** Text/table/chart placements can be authored explicitly; geometry comes from SVG. */
export function sourceBox(object, svg) {
  if (object.position) return object.position;
  const node = object.nodes[0];
  if (object.kind === "shape" && ["rect", "circle", "ellipse"].includes(node.name)) {
    return frame(node, svg, commandBounds(primitiveCommands(node)));
  }
  if (["line", "polyline"].includes(node.name) && ["shape", "connector"].includes(object.kind)) {
    const path = commands(node, svg);
    const box = commandBounds(path);
    const first = path.find((p) => p.moveTo)?.moveTo;
    const last = path.at(-1).lineTo;
    return { ...box, horizontalFlip: last.x < first.x, verticalFlip: last.y < first.y };
  }
  const geometry = object.leaves.filter((n) => !["text", "image"].includes(n.name));
  if (!geometry.length) {
    if (object.nodes.length === 1 && node.name === "image") return frame(node, svg, {
      left: number(node.attrs.x), top: number(node.attrs.y), width: number(node.attrs.width), height: number(node.attrs.height),
    });
    throw new Error("Object needs position: " + object.id);
  }
  return union(geometry.map((n) => {
    const box = bounds(n, svg);
    if (!["vector", "image"].includes(object.kind) || attr(n, "stroke", "none") === "none") return box;
    const m = worldMatrix(n, svg), half = number(attr(n, "stroke-width"), 1) / 2;
    const x = half * Math.hypot(m.a, m.c), y = half * Math.hypot(m.b, m.d);
    return { left: box.left - x, top: box.top - y, width: box.width + x * 2, height: box.height + y * 2 };
  }));
}

function autoObject(node, svg) {
  const object = { id: node.id, sourceIds: [node.id], nodes: [node], leaves: [node], order: node.order };
  if (node.name === "text") return { ...object, kind: "text" };
  if (node.name === "rect") {
    const position = sourceBox({ ...object, kind: "shape" }, svg);
    const isBackground = node.order === 0 && Math.abs(position.left) < 0.001 && Math.abs(position.top) < 0.001
      && Math.abs(position.width - svg.width) < 0.001 && Math.abs(position.height - svg.height) < 0.001
      && !position.rotation && !number(node.attrs.rx) && !number(node.attrs.ry)
      && number(attr(node, "fill-opacity"), 1) === 1
      && (() => { for (let n = node; n; n = n.parent) if (number(localStyle(n).opacity ?? n.attrs.opacity, 1) !== 1) return false; return true; })()
      && attr(node, "stroke", "none") === "none" && attr(node, "fill", "#000000") !== "none";
    return { ...object, kind: isBackground ? "background" : "shape", preset: number(node.attrs.rx) || number(node.attrs.ry) ? "roundRect" : "rect", position };
  }
  if (["circle", "ellipse"].includes(node.name)) return { ...object, kind: "shape", preset: "ellipse" };
  if (node.name === "line" && !node.attrs["marker-start"] && !node.attrs["marker-end"] && !attr(node, "marker-start") && !attr(node, "marker-end")) return { ...object, kind: "shape", preset: "line" };
  throw new Error("SVG object " + node.id + " <" + node.name + "> needs an explicit semantic object plan");
}

export function resolvePlan(svg, plan = {}) {
  const claimed = new Map(), objects = [], ids = new Set();
  for (const entry of plan.objects ?? []) {
    if (!entry.id || ids.has(entry.id) || !kinds.has(entry.kind)) throw new Error("Each plan object needs a unique id and supported kind");
    if (!Array.isArray(entry.sourceIds) || !entry.sourceIds.length) throw new Error("Missing sourceIds on " + entry.id);
    const nodes = entry.sourceIds.map((id) => {
      const node = svg.nodes.get(id);
      if (!node) throw new Error("Unknown SVG source " + id + " for " + entry.id);
      return node;
    });
    for (const node of nodes) if (nodes.some((other) => other !== node && contains(other, node))) throw new Error("Overlapping ancestor sourceIds on " + entry.id);
    const leaves = svg.leaves.filter((leaf) => nodes.some((node) => contains(node, leaf)));
    if (!leaves.length) throw new Error("Plan object has no visible source leaves: " + entry.id);
    for (const leaf of leaves) {
      if (claimed.has(leaf)) throw new Error("Source " + leaf.id + " is owned by both " + claimed.get(leaf) + " and " + entry.id);
      claimed.set(leaf, entry.id);
    }
    if (leaves.at(-1).order - leaves[0].order + 1 !== leaves.length) throw new Error("Semantic sources must be consecutive in paint order: " + entry.id);
    if (["vector", "image", "custom"].includes(entry.kind) && !entry.reason?.trim()) throw new Error("Record the structural reason for " + entry.kind + ": " + entry.id);
    if ((entry.kind === "custom" || entry.kind === "connector" && !entry.preset) && entry.position) throw new Error("Custom geometry uses source coordinates; transform the SVG before export: " + entry.id);
    if (entry.kind === "shape" && !entry.preset) throw new Error("Missing preset shape: " + entry.id);
    if (entry.kind === "connector") {
      if (entry.preset && !/^(straightConnector1|bentConnector[2-5]|curvedConnector[2-5])$/.test(entry.preset)) throw new Error("Invalid connector preset: " + entry.preset);
      for (const end of [entry.headEnd, entry.tailEnd]) if (end) {
        if (!["none", "triangle", "stealth", "diamond", "oval", "arrow"].includes(end.type)
          || end.width !== undefined && !["sm", "med", "lg"].includes(end.width)
          || end.length !== undefined && !["sm", "med", "lg"].includes(end.length)) throw new Error("Invalid native arrow endpoint: " + entry.id);
      }
      if (!entry.preset && !entry.reason) throw new Error("Connector needs a preset or custom-route reason: " + entry.id);
      if ((!entry.from || !entry.to) && !entry.reason) throw new Error("Free connector endpoints need a reason: " + entry.id);
    }
    if (entry.kind === "table" && !entry.table?.values?.length) throw new Error("Native table needs explicit values: " + entry.id);
    if (entry.kind === "chart") {
      if (!entry.chart?.type || !entry.chart.series?.length) throw new Error("Native chart needs explicit type and series: " + entry.id);
      for (const series of entry.chart.series) {
        if (!series.name || !series.values?.length || !series.values.every(Number.isFinite)) throw new Error("Chart values must be supplied finite numbers: " + entry.id);
      }
    }
    ids.add(entry.id);
    objects.push({ ...entry, nodes, leaves, order: leaves[0].order });
  }
  for (const node of svg.leaves) {
    if (claimed.has(node)) continue;
    // Degenerate geometric leaves have no painted area and need no PPT object.
    if (["rect", "circle", "ellipse"].includes(node.name) && !primitiveCommands(node).length) continue;
    const object = autoObject(node, svg);
    if (ids.has(object.id)) throw new Error("Plan id collides with an automatic source id: " + object.id);
    ids.add(object.id);
    objects.push(object);
  }
  const byId = new Map(objects.map((object) => [object.id, object]));
  for (const object of objects) for (const endpoint of [object.from, object.to]) {
    if (!endpoint) continue;
    const target = byId.get(endpoint.id);
    if (!target || !["shape", "custom", "text"].includes(target.kind)) throw new Error("Connector endpoint must reference a shape/text object: " + object.id);
    if (endpoint.side !== undefined && !["top", "left", "bottom", "right"].includes(endpoint.side)) throw new Error("Invalid connector side on " + object.id);
    if (endpoint.index !== undefined && (!Number.isInteger(endpoint.index) || endpoint.index < 0)) throw new Error("Invalid connection index on " + object.id);
    if (endpoint.index === undefined && endpoint.side === undefined) throw new Error("Connector endpoint needs index or side: " + object.id);
  }
  objects.sort((a, b) => a.order - b.order);
  const backgrounds = objects.filter((o) => o.kind === "background");
  if (backgrounds.length > 1 || backgrounds.some((o) => o !== objects[0])) throw new Error("Only the bottommost object can become a page background");
  return objects;
}
