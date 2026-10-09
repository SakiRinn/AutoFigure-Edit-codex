/** Parse SVG once; share coordinates, paint and source ownership across exporters. */
import fs from "node:fs/promises";
import { identity, multiply, point, parseTransform, primitiveCommands, transformCommands, commandBounds } from "./geometry.mjs";

const inherited = new Set(["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "fill-rule", "visibility", "marker-start", "marker-mid", "marker-end"]);
export const xmlEscape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export const localStyle = (node) => Object.fromEntries(String(node.attrs.style ?? "").split(";").filter((part) => part.includes(":")).map((part) => {
  const split = part.indexOf(":");
  return [part.slice(0, split).trim(), part.slice(split + 1).trim()];
}));
export function attr(node, key, fallback) {
  const value = localStyle(node)[key] ?? node.attrs[key];
  if (value !== undefined) return value;
  return node.parent && inherited.has(key) ? attr(node.parent, key, fallback) : fallback;
}

/** SVG lengths are converted to CSS pixels; percentages need an explicit viewport. */
export function number(value, fallback = 0) {
  if (value === undefined || value === "") return fallback;
  const match = String(value).trim().match(/^([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?)(px|pt|pc|in|cm|mm)?$/i);
  if (!match) throw new Error("Unsupported SVG length: " + value);
  return Number(match[1]) * ({ px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[match[2]?.toLowerCase()] ?? 1);
}

export async function readSvg(filename, sax) {
  const source = await fs.readFile(filename, "utf8");
  let root;
  const stack = [];
  const parser = sax.parser(true, { trim: false, normalize: false });
  parser.onopentag = (tag) => {
    const node = { name: tag.name.split(":").pop(), attrs: { ...tag.attributes }, children: [], content: [], parent: stack.at(-1) ?? null };
    if (node.parent) { node.parent.children.push(node); node.parent.content.push(node); } else root = node;
    stack.push(node);
  };
  parser.ontext = (value) => { if (stack.length) stack.at(-1).content.push(value); };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => stack.pop();
  parser.write(source).close();
  if (root?.name !== "svg") throw new Error("Input must have one SVG root");
  const viewBox = root.attrs.viewBox?.trim().split(/[ ,]+/).map(Number);
  const width = number(root.attrs.width, viewBox?.[2]);
  const height = number(root.attrs.height, viewBox?.[3]);
  if (!(width > 0 && height > 0)) throw new Error("SVG needs positive width and height or viewBox");
  if (viewBox && (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0)) throw new Error("Invalid viewBox");
  let viewport = identity();
  if (viewBox) {
    const [x, y, w, h] = viewBox;
    const aspect = root.attrs.preserveAspectRatio ?? "xMidYMid meet";
    let sx = width / w, sy = height / h, dx = 0, dy = 0;
    if (aspect !== "none") {
      const [align, fit = "meet"] = aspect.split(/\s+/);
      if (!/^x(Min|Mid|Max)Y(Min|Mid|Max)$/.test(align) || !["meet", "slice"].includes(fit)) throw new Error("Unsupported preserveAspectRatio: " + aspect);
      sx = sy = fit === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
      dx = (width - w * sx) * (align.includes("xMid") ? 0.5 : align.includes("xMax") ? 1 : 0);
      dy = (height - h * sy) * (align.includes("YMid") ? 0.5 : align.includes("YMax") ? 1 : 0);
    }
    viewport = { a: sx, b: 0, c: 0, d: sy, e: dx - x * sx, f: dy - y * sy };
  }
  const nodes = new Map(), leaves = [];
  let serial = 0;
  const visit = (node, defined = false, hidden = false, textParent = false) => {
    if (node.attrs.id) {
      if (nodes.has(node.attrs.id)) throw new Error("Duplicate SVG id: " + node.attrs.id);
      nodes.set(node.attrs.id, node);
    }
    const definitions = defined || ["defs", "symbol", "marker", "clipPath", "mask"].includes(node.name);
    const invisible = hidden || attr(node, "display") === "none" || attr(node, "visibility") === "hidden";
    if (!definitions && node.name === "style" && textContent(node).trim()) throw new Error("Inline stylesheet rules before export");
    if (!definitions && !invisible && !textParent && !["svg", "g", "title", "desc", "style"].includes(node.name)) {
      node.id = node.attrs.id ?? "__svg_" + (++serial);
      nodes.set(node.id, node);
      node.order = leaves.length;
      leaves.push(node);
    }
    for (const child of node.children) visit(child, definitions, invisible, textParent || node.name === "text");
  };
  visit(root);
  return { filename, source, root, width, height, viewport, nodes, leaves };
}

export function textContent(node) {
  return node.content.map((part) => typeof part === "string" ? part : textContent(part)).join("");
}

export function worldMatrix(node, svg) {
  const lineage = [];
  for (let n = node; n; n = n.parent) lineage.unshift(n);
  return lineage.reduce((matrix, n) => multiply(matrix, parseTransform(n.attrs.transform)), svg.viewport);
}

export function commands(node, svg) {
  return transformCommands(primitiveCommands(node), worldMatrix(node, svg));
}

export function bounds(node, svg) {
  return commandBounds(commands(node, svg));
}

/** Preserve a preset's rotation and flips instead of baking it into a custom path. */
export function frame(node, svg, localBox) {
  const m = worldMatrix(node, svg);
  const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
  if (Math.abs(m.a * m.c + m.b * m.d) > 1e-7) throw new Error("Skewed preset " + node.id + " requires a recorded custom geometry");
  const center = point(m, localBox.left + localBox.width / 2, localBox.top + localBox.height / 2);
  return { left: center.x - localBox.width * sx / 2, top: center.y - localBox.height * sy / 2,
    width: localBox.width * sx, height: localBox.height * sy, rotation: Math.atan2(m.b, m.a) * 180 / Math.PI,
    verticalFlip: m.a * m.d - m.b * m.c < 0 };
}

export function paint(node, svg) {
  for (const key of ["filter", "mask", "clip-path"]) {
    for (let current = node; current; current = current.parent) if (attr(current, key)) throw new Error("Resolve " + key + " on " + node.id + " or classify the complete icon asset");
  }
  if (node.attrs.class) throw new Error("Inline class styles before export: " + node.id);
  let alpha = 1;
  for (let current = node; current; current = current.parent) alpha *= number(localStyle(current).opacity ?? current.attrs.opacity, 1);
  const fill = attr(node, "fill", "#000000");
  const stroke = attr(node, "stroke", "none");
  if (/url\(/.test(fill) || /url\(/.test(stroke)) throw new Error("Gradient/pattern paint requires an explicit plan fill or complete vector asset: " + node.id);
  const matrix = worldMatrix(node, svg);
  const sx = Math.hypot(matrix.a, matrix.b), sy = Math.hypot(matrix.c, matrix.d);
  if (stroke !== "none" && (Math.abs(sx - sy) > 1e-7 || Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > 1e-7)) throw new Error("Normalize non-uniform stroke transform: " + node.id);
  const withAlpha = (color, opacity) => opacity === 1 || color === "none" ? color : { type: "solid", color: { type: "rgb", value: color, transform: { opacity } } };
  const dash = attr(node, "stroke-dasharray", "none");
  const style = dash === "none" ? "solid" : dash.split(/[ ,]+/).filter(Boolean).map(Number);
  return {
    fill: withAlpha(fill, alpha * number(attr(node, "fill-opacity"), 1)),
    line: { fill: withAlpha(stroke, alpha * number(attr(node, "stroke-opacity"), 1)), width: number(attr(node, "stroke-width"), 1) * sx, style: typeof style === "string" ? style : "dashed" },
    stroke: { cap: attr(node, "stroke-linecap", "butt"), join: attr(node, "stroke-linejoin", "miter"), dash: Array.isArray(style) ? style.map((n) => n * sx) : null },
  };
}

export function serialize(node, overrides = {}) {
  const attrs = { ...node.attrs, ...overrides };
  const entries = Object.entries(attrs).filter(([, value]) => value !== undefined).map(([key, value]) => key + '="' + xmlEscape(value) + '"').join(" ");
  return "<" + node.name + (entries ? " " + entries : "") + ">" + node.content.map((part) => typeof part === "string" ? xmlEscape(part) : serialize(part)).join("") + "</" + node.name + ">";
}

/** Extract an entire classified icon, with inherited paint and world transforms. */
export function vectorAsset(nodes, svg, box) {
  const defs = svg.root.children.filter((n) => n.name === "defs").map((n) => serialize(n)).join("");
  const fragments = nodes.map((node) => {
    let fragment = serialize(node);
    // Keep ancestor effects in their original coordinate systems, including opacity.
    for (let parent = node.parent; parent; parent = parent.parent) {
      const attrs = Object.fromEntries(Object.entries(parent.attrs).filter(([key]) =>
        !["id", "xmlns", "xmlns:xlink", "width", "height", "viewBox", "preserveAspectRatio"].includes(key)));
      const wrapper = { name: "g", attrs, content: [] };
      fragment = serialize(wrapper).replace("</g>", fragment + "</g>");
    }
    const m = svg.viewport;
    return '<g transform="matrix(' + [m.a, m.b, m.c, m.d, m.e, m.f].join(" ") + ')">' + fragment + '</g>';
  }).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + box.width + '" height="' + box.height + '" viewBox="' + [box.left, box.top, box.width, box.height].join(" ") + '">' + defs + fragments + "</svg>";
}
