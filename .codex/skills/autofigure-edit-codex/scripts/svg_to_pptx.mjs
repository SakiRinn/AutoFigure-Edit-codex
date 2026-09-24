/**
 * Convert an AutoFigure SVG into a one-slide PPTX made from native PowerPoint
 * objects. Run with `svg_to_pptx.mjs INPUT.svg OUTPUT.pptx`.
 *
 * The converter intentionally fails on SVG features that cannot be preserved as
 * editable objects. Codex classifies each icon by its visible structure:
 * simple icons use one vector object; complex icons keep one source bitmap.
 * Approved dense sample regions may also use one raster image;
 * the exporter never rasterizes the whole slide.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const svgPath = path.resolve(process.argv[2] ?? "");
const outputPath = path.resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("usage: svg_to_pptx.mjs INPUT.svg OUTPUT.pptx");
}

const runtimeModules = process.env.RUNTIME_NODE_MODULES;
const artifactPath = process.env.ARTIFACT_TOOL_PATH;
if (!runtimeModules || !artifactPath) {
  throw new Error("RUNTIME_NODE_MODULES and ARTIFACT_TOOL_PATH are required");
}
const { Presentation, PresentationFile } = await import(pathToFileURL(artifactPath).href);
const saxModule = await import(pathToFileURL(path.join(runtimeModules, "sax/lib/sax.js")).href);
const sax = saxModule.default ?? saxModule;
const zipModule = await import(pathToFileURL(path.join(runtimeModules, "jszip/lib/index.js")).href);
const JSZip = zipModule.default;
const xmlModule = await import(pathToFileURL(path.join(runtimeModules, "xml-js/lib/index.js")).href);
const xml = xmlModule.default;

const svg = await fs.readFile(svgPath, "utf8");
let root;
const stack = [];
const parser = sax.parser(true, { lowercase: false, trim: false, normalize: false });
parser.onopentag = (tag) => {
  const node = {
    name: tag.name.split(":").pop(),
    attrs: tag.attributes,
    text: "",
    children: [],
    parent: stack.at(-1) ?? null,
  };
  if (node.parent) node.parent.children.push(node);
  else root = node;
  stack.push(node);
};
parser.ontext = (value) => { if (stack.length) stack.at(-1).text += value; };
parser.oncdata = parser.ontext;
parser.onclosetag = () => { stack.pop(); };
parser.write(svg).close();
if (!root || root.name !== "svg") throw new Error("Input must contain one SVG root element");

const parseNumber = (value, fallback = 0) => {
  const match = String(value ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/);
  return match ? Number(match[0]) : fallback;
};
const styleMap = (node) => Object.fromEntries(
  String(node.attrs.style ?? "")
    .split(";")
    .map((entry) => entry.split(":"))
    .filter((pair) => pair.length === 2)
    .map(([key, value]) => [key.trim(), value.trim()]),
);
const inherited = new Set([
  "fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width",
  "font-size", "font-family", "font-weight", "text-anchor", "opacity",
]);
const attr = (node, key, fallback = undefined) => {
  const styles = styleMap(node);
  const value = node.attrs[key] ?? node.attrs[key.toLowerCase()] ?? styles[key];
  if (value !== undefined) return value;
  return inherited.has(key) && node.parent ? attr(node.parent, key, fallback) : fallback;
};

const multiply = (left, right) => ({
  a: left.a * right.a + left.c * right.b,
  b: left.b * right.a + left.d * right.b,
  c: left.a * right.c + left.c * right.d,
  d: left.b * right.c + left.d * right.d,
  e: left.a * right.e + left.c * right.f + left.e,
  f: left.b * right.e + left.d * right.f + left.f,
});
const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const point = (matrix, x, y) => ({
  x: matrix.a * x + matrix.c * y + matrix.e,
  y: matrix.b * x + matrix.d * y + matrix.f,
});
const transformMatrix = (value) => {
  let matrix = identity();
  const pattern = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = pattern.exec(String(value ?? "")))) {
    const name = match[1].toLowerCase();
    const values = match[2].match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
    let next;
    if (name === "matrix" && values.length === 6) {
      next = { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
    } else if (name === "translate" && (values.length === 1 || values.length === 2)) {
      next = { a: 1, b: 0, c: 0, d: 1, e: values[0], f: values[1] ?? 0 };
    } else if (name === "scale" && (values.length === 1 || values.length === 2)) {
      next = { a: values[0], b: 0, c: 0, d: values[1] ?? values[0], e: 0, f: 0 };
    } else if (name === "rotate" && (values.length === 1 || values.length === 3)) {
      const radians = values[0] * Math.PI / 180;
      const rotation = { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 };
      if (values.length === 3) {
        const [, cx, cy] = values;
        next = multiply(
          multiply({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, rotation),
          { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy },
        );
      } else next = rotation;
    } else if (name === "skewx" && values.length === 1) {
      next = { a: 1, b: 0, c: Math.tan(values[0] * Math.PI / 180), d: 1, e: 0, f: 0 };
    } else if (name === "skewy" && values.length === 1) {
      next = { a: 1, b: Math.tan(values[0] * Math.PI / 180), c: 0, d: 1, e: 0, f: 0 };
    } else {
      throw new Error(`Unsupported or malformed SVG transform: ${match[0]}`);
    }
    matrix = multiply(matrix, next);
  }
  if (String(value ?? "").replace(pattern, "").replace(/[\s,]/g, "")) {
    throw new Error(`Malformed SVG transform: ${value}`);
  }
  return matrix;
};

const viewBox = String(root.attrs.viewBox ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.map(Number);
const width = parseNumber(root.attrs.width, viewBox?.[2] ?? 1536);
const height = parseNumber(root.attrs.height, viewBox?.[3] ?? 1024);
if (!(width > 0 && height > 0)) throw new Error("SVG width and height must be positive");
const viewport = viewBox?.length === 4
  ? { a: width / viewBox[2], b: 0, c: 0, d: height / viewBox[3], e: -viewBox[0] * width / viewBox[2], f: -viewBox[1] * height / viewBox[3] }
  : identity();
const worldMatrix = (node) => {
  const lineage = [];
  for (let current = node; current; current = current.parent) lineage.unshift(current);
  return lineage.reduce((matrix, current) => multiply(matrix, transformMatrix(current.attrs.transform)), viewport);
};

const namedColors = {
  white: "#ffffff", black: "#000000", gray: "#808080", grey: "#808080",
  red: "#ff0000", blue: "#0000ff", green: "#008000", orange: "#ff8800",
  yellow: "#ffff00", purple: "#800080", transparent: "none", none: "none",
};
const color = (value, fallback = "none") => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized in namedColors) return namedColors[normalized];
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return `#${[...normalized.slice(1)].map((part) => part + part).join("")}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
  const rgb = normalized.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
  if (rgb) return `#${rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, "0")).join("")}`;
  throw new Error(`Unsupported SVG color: ${value}`);
};
const opacity = (node, kind) => parseNumber(attr(node, "opacity", 1), 1) * parseNumber(attr(node, `${kind}-opacity`, 1), 1);
const fillConfig = (node) => color(attr(node, "fill", "#000000"));
const lineConfig = (node) => {
  const line = {
    style: "solid",
    fill: color(attr(node, "stroke", "none")),
    width: parseNumber(attr(node, "stroke-width", 1), 1),
  };
  if (line.fill !== "none") {
    const matrix = worldMatrix(node);
    const scaleX = Math.hypot(matrix.a, matrix.b);
    const scaleY = Math.hypot(matrix.c, matrix.d);
    const dot = matrix.a * matrix.c + matrix.b * matrix.d;
    if (Math.abs(dot) > 1e-6 || Math.abs(scaleX - scaleY) > 1e-6) {
      throw new Error(`Non-uniformly scaled or skewed SVG stroke on <${node.name}> cannot remain editable in PPTX. ${nativeRequirement}`);
    }
    line.width *= scaleX;
  }
  return line;
};
const groupName = (node) => {
  const names = [];
  for (let current = node.parent; current; current = current.parent) {
    if (current.attrs["data-editable-asset"]) names.unshift(current.attrs["data-editable-asset"]);
  }
  const own = node.attrs.id ?? node.name;
  return names.length ? `${names.join("/")}/${own}` : own;
};

const tokenizePath = (data) => {
  const tokens = String(data ?? "").match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const compact = String(data ?? "").replace(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, "");
  if (compact) throw new Error(`Malformed SVG path near: ${compact.slice(0, 24)}`);
  return tokens;
};
const arcPoints = (start, rxInput, ryInput, angle, largeArc, sweep, end) => {
  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  if (!rx || !ry || (start.x === end.x && start.y === end.y)) return [end];
  const phi = angle * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;
  const scale = Math.sqrt(Math.max(1, xPrime ** 2 / rx ** 2 + yPrime ** 2 / ry ** 2));
  rx *= scale;
  ry *= scale;
  const sign = largeArc === sweep ? -1 : 1;
  const numerator = Math.max(0, rx ** 2 * ry ** 2 - rx ** 2 * yPrime ** 2 - ry ** 2 * xPrime ** 2);
  const denominator = rx ** 2 * yPrime ** 2 + ry ** 2 * xPrime ** 2;
  const factor = sign * Math.sqrt(denominator ? numerator / denominator : 0);
  const cxPrime = factor * rx * yPrime / ry;
  const cyPrime = factor * -ry * xPrime / rx;
  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (start.x + end.x) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (start.y + end.y) / 2;
  const vectorAngle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (xPrime - cxPrime) / rx;
  const uy = (yPrime - cyPrime) / ry;
  const vx = (-xPrime - cxPrime) / rx;
  const vy = (-yPrime - cyPrime) / ry;
  const startAngle = vectorAngle(1, 0, ux, uy);
  let delta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const steps = Math.max(4, Math.ceil(Math.abs(delta) / (Math.PI / 12)));
  return Array.from({ length: steps }, (_, index) => {
    const theta = startAngle + delta * (index + 1) / steps;
    return {
      x: cx + cosPhi * rx * Math.cos(theta) - sinPhi * ry * Math.sin(theta),
      y: cy + sinPhi * rx * Math.cos(theta) + cosPhi * ry * Math.sin(theta),
    };
  });
};

function pathPoints(data) {
  const tokens = tokenizePath(data);
  const result = [];
  let index = 0;
  let command;
  let current = { x: 0, y: 0 };
  let subpath = { x: 0, y: 0 };
  let lastCubic;
  let lastQuadratic;
  const isCommand = (token) => /^[A-Za-z]$/.test(token ?? "");
  const take = () => {
    if (index >= tokens.length || isCommand(tokens[index])) throw new Error(`Malformed SVG path command ${command}`);
    return Number(tokens[index++]);
  };
  const target = (relative, x, y) => ({ x: x + (relative ? current.x : 0), y: y + (relative ? current.y : 0) });
  const line = (next) => { result.push({ lineTo: next }); current = next; };
  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) throw new Error("SVG path must start with a command");
    const lower = command.toLowerCase();
    const relative = command === lower;
    if (lower === "z") {
      result.push({ close: {} });
      current = { ...subpath };
      lastCubic = lastQuadratic = undefined;
      command = undefined;
      continue;
    }
    if (lower === "m" || lower === "l") {
      const next = target(relative, take(), take());
      if (lower === "m") {
        result.push({ moveTo: next });
        current = next;
        subpath = { ...next };
        command = relative ? "l" : "L";
      } else line(next);
    } else if (lower === "h") {
      line({ x: take() + (relative ? current.x : 0), y: current.y });
    } else if (lower === "v") {
      line({ x: current.x, y: take() + (relative ? current.y : 0) });
    } else if (lower === "c" || lower === "s") {
      const start = { ...current };
      const control1 = lower === "s"
        ? (lastCubic ? { x: 2 * start.x - lastCubic.x, y: 2 * start.y - lastCubic.y } : start)
        : target(relative, take(), take());
      const control2 = target(relative, take(), take());
      const end = target(relative, take(), take());
      for (let step = 1; step <= 24; step++) {
        const t = step / 24;
        const u = 1 - t;
        line({
          x: u ** 3 * start.x + 3 * u * u * t * control1.x + 3 * u * t * t * control2.x + t ** 3 * end.x,
          y: u ** 3 * start.y + 3 * u * u * t * control1.y + 3 * u * t * t * control2.y + t ** 3 * end.y,
        });
      }
      current = end;
      lastCubic = control2;
      lastQuadratic = undefined;
      continue;
    } else if (lower === "q" || lower === "t") {
      const start = { ...current };
      const control = lower === "t"
        ? (lastQuadratic ? { x: 2 * start.x - lastQuadratic.x, y: 2 * start.y - lastQuadratic.y } : start)
        : target(relative, take(), take());
      const end = target(relative, take(), take());
      for (let step = 1; step <= 24; step++) {
        const t = step / 24;
        const u = 1 - t;
        line({ x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y });
      }
      current = end;
      lastQuadratic = control;
      lastCubic = undefined;
      continue;
    } else if (lower === "a") {
      const rx = take();
      const ry = take();
      const angle = take();
      const largeArc = take();
      const sweep = take();
      if (![0, 1].includes(largeArc) || ![0, 1].includes(sweep)) throw new Error("SVG arc flags must be 0 or 1");
      const end = target(relative, take(), take());
      for (const next of arcPoints(current, rx, ry, angle, largeArc, sweep, end)) line(next);
    } else {
      throw new Error(`Unsupported SVG path command: ${command}`);
    }
    lastCubic = lastQuadratic = undefined;
  }
  return result;
}

const transformCommands = (commands, matrix) => commands.map((command) => {
  if (command.close) return command;
  const key = command.moveTo ? "moveTo" : "lineTo";
  return { [key]: point(matrix, command[key].x, command[key].y) };
});
const boundsOf = (commands) => {
  const points = commands.flatMap((command) => command.moveTo ? [command.moveTo] : command.lineTo ? [command.lineTo] : []);
  if (!points.length) throw new Error("SVG path has no drawable points");
  const left = Math.min(...points.map((item) => item.x));
  const top = Math.min(...points.map((item) => item.y));
  const right = Math.max(...points.map((item) => item.x));
  const bottom = Math.max(...points.map((item) => item.y));
  return { left, top, width: Math.max(0.01, right - left), height: Math.max(0.01, bottom - top) };
};
const customShape = (slide, node, commands) => {
  const matrix = worldMatrix(node);
  const transformed = transformCommands(commands, matrix);
  const bounds = boundsOf(transformed);
  const localized = transformed.map((command) => {
    if (command.close) return command;
    const key = command.moveTo ? "moveTo" : "lineTo";
    return { [key]: { x: command[key].x - bounds.left, y: command[key].y - bounds.top } };
  });
  const line = lineConfig(node);
  return slide.shapes.add({
    geometry: "custom",
    name: groupName(node),
    position: bounds,
    customPaths: [{ width: bounds.width, height: bounds.height, commands: localized }],
    fill: fillConfig(node),
    line,
  });
};
const polygonCommands = (points, close = false) => {
  if (!points.length) throw new Error("SVG polygon or polyline has no points");
  const commands = [{ moveTo: points[0] }, ...points.slice(1).map((item) => ({ lineTo: item }))];
  if (close) commands.push({ close: {} });
  return commands;
};
const parsePoints = (value) => {
  const values = String(value ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  if (!values.length || values.length % 2) throw new Error(`Malformed SVG points: ${value}`);
  return Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
};
const ellipseCommands = (cx, cy, rx, ry) => polygonCommands(
  Array.from({ length: 48 }, (_, index) => {
    const angle = index / 48 * Math.PI * 2;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  }),
  true,
);
const descendantsText = (node) => [node.text, ...node.children.flatMap(descendantsText)]
  .join(" ").replace(/\s+/g, " ").trim();
const textStyleKeys = ["font-size", "font-family", "font-weight", "fill", "text-anchor"];
const textLayout = (node) => {
  const tspans = node.children.filter((child) => child.name === "tspan");
  const directText = node.text.replace(/\s+/g, " ").trim();
  if (!tspans.length) {
    return {
      lines: [{
        text: descendantsText(node),
        x: parseNumber(attr(node, "x")),
        y: parseNumber(attr(node, "y")),
        fontSize: parseNumber(attr(node, "font-size", 18), 18),
        fontFamily: attr(node, "font-family", "Arial"),
        fontWeight: attr(node, "font-weight", "400"),
        fill: attr(node, "fill", "#172b4d"),
      }],
      lineStep: null,
    };
  }
  if (directText || node.children.some((child) => child.name !== "tspan")) {
    throw new Error(`SVG <text> with <tspan> lines cannot mix direct text or other child elements. ${nativeRequirement}`);
  }
  const allowedAttributes = new Set(["id", "x", "y", "font-size", "font-family", "font-weight", "fill", "text-anchor", "style"]);
  const allowedStyles = new Set(textStyleKeys);
  const lines = tspans.map((tspan) => {
    const unknownAttribute = Object.keys(tspan.attrs).find((key) => !allowedAttributes.has(key));
    if (unknownAttribute) {
      throw new Error(`Unsupported SVG <tspan> attribute ${unknownAttribute}. ${nativeRequirement}`);
    }
    const unknownStyle = Object.keys(styleMap(tspan)).find((key) => !allowedStyles.has(key));
    if (unknownStyle) {
      throw new Error(`Unsupported SVG <tspan> style ${unknownStyle}. ${nativeRequirement}`);
    }
    if (tspan.children.length) {
      throw new Error(`Nested SVG elements inside <tspan> cannot remain editable in PPTX. ${nativeRequirement}`);
    }
    const text = tspan.text.replace(/\s+/g, " ").trim();
    if (!text) throw new Error(`Empty SVG <tspan> lines cannot preserve authored paragraph spacing. ${nativeRequirement}`);
    return {
      text,
      x: parseNumber(attr(tspan, "x", attr(node, "x"))),
      y: parseNumber(attr(tspan, "y", attr(node, "y"))),
      fontSize: parseNumber(attr(tspan, "font-size", 18), 18),
      fontFamily: attr(tspan, "font-family", "Arial"),
      fontWeight: attr(tspan, "font-weight", "400"),
      fill: attr(tspan, "fill", "#172b4d"),
      anchor: attr(tspan, "text-anchor", attr(node, "text-anchor", "start")),
    };
  });
  const x = lines[0].x;
  const anchor = lines[0].anchor;
  const fontFamily = lines[0].fontFamily;
  if (lines.some((line) => Math.abs(line.x - x) > 0.01)) {
    throw new Error(`SVG <tspan> paragraph lines must share one x coordinate. ${nativeRequirement}`);
  }
  if (lines.some((line) => line.anchor !== anchor || line.fontFamily !== fontFamily)) {
    throw new Error(`SVG <tspan> paragraph lines must share one text anchor and font family. ${nativeRequirement}`);
  }
  const steps = lines.slice(1).map((line, index) => line.y - lines[index].y);
  if (steps.some((step) => !(step > 0)) || steps.some((step) => Math.abs(step - steps[0]) > 0.01)) {
    throw new Error(`SVG <tspan> paragraph lines must use increasing, equal y spacing. ${nativeRequirement}`);
  }
  return { lines, lineStep: steps[0] ?? null };
};
const unsupportedFeatures = ["clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"];
const nativeRequirement = "Text, basic geometry, and connectors must remain native PowerPoint objects; simple icons require one vector object; individually classified complex icons and approved dense sample distributions may use raster images";
const validateNode = (node) => {
  for (const feature of unsupportedFeatures) {
    if (attr(node, feature) !== undefined) throw new Error(`Unsupported SVG feature ${feature} on <${node.name}>. ${nativeRequirement}`);
  }
  if (opacity(node, "fill") !== 1 || opacity(node, "stroke") !== 1) {
    throw new Error(`SVG opacity on <${node.name}> cannot be preserved as a native PowerPoint object. ${nativeRequirement}`);
  }
  for (const feature of ["stroke-dasharray", "stroke-linecap", "stroke-linejoin", "fill-rule"]) {
    const value = attr(node, feature);
    const defaultValue = { "stroke-dasharray": "none", "stroke-linecap": "butt", "stroke-linejoin": "miter", "fill-rule": "nonzero" }[feature];
    if (value !== undefined && String(value).toLowerCase() !== defaultValue) {
      throw new Error(`Unsupported SVG style ${feature}=${value} on <${node.name}>. ${nativeRequirement}`);
    }
  }
};
const renderable = [];
const collect = (node, inDefs = false) => {
  const nextInDefs = inDefs || node.name === "defs";
  if (node.name === "style" && descendantsText(node)) {
    throw new Error(`SVG <style> rules are unsupported. ${nativeRequirement}`);
  }
  if (!nextInDefs && node.attrs.class !== undefined) {
    throw new Error(`SVG class=${node.attrs.class} on <${node.name}> is unsupported. ${nativeRequirement}`);
  }
  if (!nextInDefs && !["title", "desc", "style", "tspan"].includes(node.name)) validateNode(node);
  if (!nextInDefs && node.name === "tspan" && node.parent?.name !== "text") {
    throw new Error(`SVG <tspan> must belong to one parent <text> element. ${nativeRequirement}`);
  }
  if (!nextInDefs && !["svg", "g", "title", "desc", "style", "tspan"].includes(node.name)) renderable.push(node);
  for (const child of node.children) collect(child, nextInDefs);
};
collect(root);

const presentation = Presentation.create({ slideSize: { width, height } });
const slide = presentation.slides.add();
slide.background.fill = color(root.attrs["data-background"] ?? "#ffffff");
// A bottommost solid canvas rectangle belongs to the slide background, not
// the selection pane. Later rectangles may cover content and must stay shapes.
const background = renderable[0];
if (background?.name === "rect" && attr(background, "stroke", "none") === "none"
    && !parseNumber(attr(background, "rx")) && !parseNumber(attr(background, "ry"))) {
  const matrix = worldMatrix(background);
  const origin = point(matrix, parseNumber(attr(background, "x")), parseNumber(attr(background, "y")));
  const fill = fillConfig(background);
  if (fill !== "none" && Math.abs(matrix.b) < 1e-8 && Math.abs(matrix.c) < 1e-8
      && Math.abs(origin.x) < 1e-6 && Math.abs(origin.y) < 1e-6
      && Math.abs(parseNumber(attr(background, "width")) * matrix.a - width) < 1e-6
      && Math.abs(parseNumber(attr(background, "height")) * matrix.d - height) < 1e-6) {
    slide.background.fill = fill;
    renderable.shift();
  }
}
const supportedTags = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "image"]);
let nativeObjects = 0;
let imageObjects = 0;
for (const node of renderable) {
  if (!supportedTags.has(node.name)) throw new Error(`Unsupported SVG element <${node.name}>. ${nativeRequirement}`);
  if (node.name === "image") {
    const href = attr(node, "href") ?? attr(node, "xlink:href");
    if (!href) throw new Error("SVG <image> requires href");
    let blob;
    let contentType;
    if (href.startsWith("data:image/")) {
      const match = href.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
      if (!match) throw new Error("Only base64 SVG data images are supported");
      contentType = match[1];
      blob = Uint8Array.from(Buffer.from(match[2], "base64"));
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) throw new Error(`Remote SVG image URLs are unsupported: ${href}`);
      const imagePath = href.startsWith("file:") ? fileURLToPath(href) : path.resolve(path.dirname(svgPath), href);
      contentType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" })[path.extname(imagePath).toLowerCase()];
      if (!contentType) throw new Error(`Unsupported local SVG image type: ${imagePath}`);
      blob = new Uint8Array(await fs.readFile(imagePath));
    }
    const matrix = worldMatrix(node);
    if (Math.abs(matrix.b) > 1e-8 || Math.abs(matrix.c) > 1e-8 || matrix.a <= 0 || matrix.d <= 0) throw new Error("For an approved complex icon or dense sample bitmap, bake its rotation, reflection, or skew into the working copy before PPTX export; simple icons must remain vector");
    const origin = point(matrix, parseNumber(attr(node, "x")), parseNumber(attr(node, "y")));
    slide.images.add({
      blob,
      contentType,
      alt: groupName(node),
      fit: "cover",
      position: {
        left: origin.x,
        top: origin.y,
        width: parseNumber(attr(node, "width")) * matrix.a,
        height: parseNumber(attr(node, "height")) * matrix.d,
      },
    });
  } else if (node.name === "text") {
    const layout = textLayout(node);
    if (!layout.lines[0]?.text) continue;
    const matrix = worldMatrix(node);
    const scaleX = Math.hypot(matrix.a, matrix.b);
    const scaleY = Math.hypot(matrix.c, matrix.d);
    const dot = matrix.a * matrix.c + matrix.b * matrix.d;
    if (Math.abs(dot) > 1e-6 || Math.abs(scaleX - scaleY) > 1e-6) {
      throw new Error(`Skewed or non-uniformly scaled SVG text cannot remain editable in PPTX. ${nativeRequirement}`);
    }
    const lines = layout.lines.map((line) => ({ ...line, fontSize: line.fontSize * scaleX }));
    const origin = point(matrix, lines[0].x, lines[0].y);
    const anchor = layout.lines[0].anchor ?? attr(node, "text-anchor", "start");
    let textWidth = Math.max(24, ...lines.map((line) => line.text.length * line.fontSize * 0.72 + 12));
    const maxFontSize = Math.max(...lines.map((line) => line.fontSize));
    const lineStep = layout.lineStep === null ? null : layout.lineStep * scaleX;
    let textHeight = lineStep === null ? maxFontSize * 1.6 : lineStep * (lines.length - 1) + maxFontSize * 1.6;
    let top = origin.y - lines[0].fontSize * 1.15;
    const rotation = Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    if (Math.abs(rotation) < 1e-8 && origin.x >= 0 && origin.x <= width && origin.y >= 0 && origin.y <= height) {
      const availableWidth = anchor === "middle"
        ? 2 * Math.min(origin.x, width - origin.x)
        : anchor === "end" ? origin.x : width - origin.x;
      textWidth = Math.min(textWidth, availableWidth);
      top = Math.max(0, top);
      textHeight = Math.min(textHeight, height - top);
    }
    const left = anchor === "middle" ? origin.x - textWidth / 2 : anchor === "end" ? origin.x - textWidth : origin.x;
    const shape = slide.shapes.add({
      geometry: "textbox",
      name: groupName(node),
      position: { left, top, width: textWidth, height: textHeight },
      fill: "none",
      line: { fill: "none", width: 0 },
    });
    shape.rotation = rotation;
    shape.text.set(lines.map((line) => [{
      run: line.text,
      textStyle: {
        typeface: line.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
        fontSize: `${line.fontSize}px`,
        bold: ["bold", "700", "800", "900"].includes(String(line.fontWeight).toLowerCase()),
        color: color(line.fill),
      },
    }]));
    shape.text.style = {
      lineSpacing: lineStep === null ? 1 : lineStep / maxFontSize,
      alignment: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
      verticalAlignment: "top",
      autoFit: "shrinkText",
      wrap: "square",
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    };
  } else if (node.name === "line") {
    const matrix = worldMatrix(node);
    const start = point(matrix, parseNumber(attr(node, "x1")), parseNumber(attr(node, "y1")));
    const end = point(matrix, parseNumber(attr(node, "x2")), parseNumber(attr(node, "y2")));
    slide.shapes.add({
      geometry: "line",
      name: groupName(node),
      position: { left: start.x, top: start.y, width: end.x - start.x, height: end.y - start.y },
      fill: "none",
      line: lineConfig(node),
    });
  } else if (node.name === "path") {
    customShape(slide, node, pathPoints(attr(node, "d")));
  } else if (node.name === "polygon" || node.name === "polyline") {
    customShape(slide, node, polygonCommands(parsePoints(attr(node, "points")), node.name === "polygon"));
  } else if (node.name === "circle" || node.name === "ellipse") {
    const cx = parseNumber(attr(node, "cx"));
    const cy = parseNumber(attr(node, "cy"));
    const rx = node.name === "circle" ? parseNumber(attr(node, "r")) : parseNumber(attr(node, "rx"));
    const ry = node.name === "circle" ? rx : parseNumber(attr(node, "ry"));
    customShape(slide, node, ellipseCommands(cx, cy, rx, ry));
  } else if (node.name === "rect") {
    const x = parseNumber(attr(node, "x"));
    const y = parseNumber(attr(node, "y"));
    const rectWidth = parseNumber(attr(node, "width"));
    const rectHeight = parseNumber(attr(node, "height"));
    const rx = parseNumber(attr(node, "rx"));
    const ry = parseNumber(attr(node, "ry"), rx);
    if (rx || ry) {
      const commands = pathPoints(`M ${x + rx} ${y} H ${x + rectWidth - rx} A ${rx} ${ry} 0 0 1 ${x + rectWidth} ${y + ry} V ${y + rectHeight - ry} A ${rx} ${ry} 0 0 1 ${x + rectWidth - rx} ${y + rectHeight} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + rectHeight - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`);
      customShape(slide, node, commands);
    } else {
      customShape(slide, node, polygonCommands([
        { x, y }, { x: x + rectWidth, y }, { x: x + rectWidth, y: y + rectHeight }, { x, y: y + rectHeight },
      ], true));
    }
  }
  if (node.name === "image") imageObjects += 1;
  else nativeObjects += 1;
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await (await PresentationFile.exportPptx(presentation)).save(outputPath);

// Preserve consecutive semantic SVG assets as DrawingML groups.
const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
const slideFile = "ppt/slides/slide1.xml";
const document = xml.xml2js(await zip.file(slideFile).async("string"));
const find = (node, name) => node?.name === name ? node : (node?.elements ?? []).map((child) => find(child, name)).find(Boolean);
const tree = find(document, "p:spTree");
const ids = [];
const collectIds = (node) => {
  if (node?.name === "p:cNvPr") ids.push(Number(node.attributes.id));
  for (const child of node?.elements ?? []) collectIds(child);
};
collectIds(document);
let nextId = Math.max(...ids) + 1;
const grouped = [];
let active;
let activeName;
for (const element of tree.elements) {
  const properties = find(element, "p:cNvPr");
  const name = properties?.attributes?.name ?? "";
  const group = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : null;
  if (!group) {
    active = activeName = null;
    grouped.push(element);
    continue;
  }
  if (group !== activeName) {
    activeName = group;
    const escaped = group.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const frame = `<p:grpSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:nvGrpSpPr><p:cNvPr id="${nextId++}" name="${escaped}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(width * 9525)}" cy="${Math.round(height * 9525)}"/><a:chOff x="0" y="0"/><a:chExt cx="${Math.round(width * 9525)}" cy="${Math.round(height * 9525)}"/></a:xfrm></p:grpSpPr></p:grpSp>`;
    active = xml.xml2js(frame).elements[0];
    grouped.push(active);
  }
  active.elements.push(element);
}
tree.elements = grouped;
zip.file(slideFile, xml.js2xml(document));
await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer" }));
const preview = await presentation.export({ slide, format: "png", scale: 1 });
await fs.writeFile(`${outputPath}.preview.png`, new Uint8Array(await preview.arrayBuffer()));
console.log(JSON.stringify({ outputPath, slideSize: { width, height }, nativeObjects, imageObjects, totalObjects: nativeObjects + imageObjects }));
