/** Build semantic objects with Artifact Tool; package.mjs verifies their actual XML. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attr, number, commands, paint, vectorAsset, textContent } from "./svg.mjs";
import { identity, transformCommands, commandBounds } from "./geometry.mjs";
import { sourceBox } from "./plan.mjs";
import { emitText } from "./text.mjs";
import { fontRuns, requireFont } from "./runtime.mjs";

/** Keep Bezier commands native and translate world coordinates into the shape viewport. */
function customGeometry(node, svg) {
  const source = commands(node, svg);
  const box = commandBounds(source);
  const width = Math.max(box.width, 0.001), height = Math.max(box.height, 0.001);
  const local = transformCommands(source, { ...identity(), e: -box.left, f: -box.top });
  return { position: { ...box, width, height }, customPaths: [{ width, height, commands: local }] };
}

async function imageBytes(node, svg) {
  const href = attr(node, "href") ?? attr(node, "xlink:href");
  if (!href) throw new Error("Missing image href: " + node.id);
  if (href.startsWith("data:")) {
    const match = href.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
    if (!match) throw new Error("Use base64 image data for " + node.id);
    return { bytes: Buffer.from(match[2], "base64"), contentType: match[1] };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) throw new Error("Download the image locally before export: " + node.id);
  const filename = href.startsWith("file:") ? fileURLToPath(href) : path.resolve(path.dirname(svg.filename), href);
  const contentType = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(filename).toLowerCase()];
  if (!contentType) throw new Error("Unsupported image asset: " + filename);
  return { bytes: await fs.readFile(filename), contentType };
}

function validatePreset(preset, runtime, id) {
  if (!(preset in runtime.SHAPE_GEOMETRY_NAME_TO_PROTO)) throw new Error("Unknown PowerPoint preset " + preset + " for " + id);
}

const familyFor = (text, policy) => /[\p{Script=Han}]/u.test(text) ? policy.cjk : policy.latin;

/** A semantic plan supplies real cells; no table data is inferred from pixels. */
function emitTable(slide, object, position, policy, available, index) {
  const config = object.table;
  const columns = config.values[0].length;
  if (!columns || config.values.some((row) => row.length !== columns)) throw new Error("Table values must be rectangular: " + object.id);
  const plain = (value) => typeof value === "number" ? value : typeof value === "string" ? value
    : Array.isArray(value) ? value.map((run) => typeof run === "string" ? run : run.run).join("") : value.runs.map((run) => typeof run === "string" ? run : run.run).join("");
  const values = config.values.map((row) => row.map(plain));
  const table = slide.tables.add({ rows: values.length, columns, ...position, values, columnWidths: config.columnWidths });
  table.styleOptions = { headerRow: false, bandedRows: false, ...config.styleOptions };
  table.borders.assign(config.borders ?? { style: "solid", fill: "#333333", width: 1 });
  const fonts = new Set();
  for (let r = 0; r < values.length; r++) {
    if (config.rowHeights?.[r] !== undefined) table.rows[r].height = config.rowHeights[r];
    for (let c = 0; c < columns; c++) {
      const cell = table.getCell(r, c);
      cell.fill = config.fill ?? "#ffffff";
      const special = config.cells?.find((item) => item.row === r && item.column === c);
      if (special?.fill) cell.fill = special.fill;
      const style = { fontSize: 16, color: "#000000", ...config.textStyle, ...special?.textStyle };
      const source = config.values[r][c];
      const runs = Array.isArray(source) ? source : source?.runs ?? [{ run: String(values[r][c]) }];
      const output = runs.flatMap((run) => fontRuns(typeof run === "string" ? run : run.run, { ...style, fontSize: (style.fontSize) + "px", ...(run.textStyle ?? {}) }, policy, available));
      output.forEach((run) => fonts.add(run.textStyle.typeface));
      cell.text.set([output]);
      cell.text.style = { ...style, autoFit: "none", insets: config.margins ?? { top: 4, right: 6, bottom: 4, left: 6 } };
    }
  }
  for (const range of config.merges ?? []) table.merge(range);
  return { element: table, tableIndex: index, table: { values: config.values }, fonts: [...fonts] };
}

function emitChart(slide, object, position, policy, available, index) {
  const { type, ...config } = object.chart;
  if (!["scatter", "bubble"].includes(type)) {
    if (!config.categories?.length || config.series.some((s) => s.values.length !== config.categories.length)) throw new Error("Chart categories must match every series: " + object.id);
  }
  const latin = policy.latin;
  const family = (value) => {
    const font = familyFor(String(value ?? ""), policy); requireFont(font, available); return font;
  };
  requireFont(latin, available);
  const fonts = new Set([latin, family(config.title), family(config.categories?.join("")), family(config.series.map((s) => s.name).join(""))]);
  for (const style of [config.titleTextStyle, config.legend?.textStyle, config.xAxis?.textStyle, config.yAxis?.textStyle, config.dataLabels?.textStyle]) {
    if (style?.typeface) { requireFont(style.typeface, available); fonts.add(style.typeface); }
  }
  const chart = slide.charts.add(type, {
    ...config, position,
    titlePlacement: config.title ? (config.titlePlacement ?? "aboveChart") : "none",
    titleTextStyle: { typeface: family(config.title), fontSize: 18, ...config.titleTextStyle },
    legend: { ...config.legend, textStyle: { typeface: family(config.series.map((s) => s.name).join("")), fontSize: 14, ...config.legend?.textStyle } },
    xAxis: { ...config.xAxis, textStyle: { typeface: family(config.categories?.join("")), fontSize: 14, ...config.xAxis?.textStyle } },
    yAxis: { ...config.yAxis, textStyle: { typeface: latin, fontSize: 14, ...config.yAxis?.textStyle } },
    dataLabels: { ...config.dataLabels, textStyle: { typeface: latin, fontSize: 14, ...config.dataLabels?.textStyle } },
  });
  return { element: chart, chartIndex: index, chart: object.chart, fonts: [...fonts] };
}

/** Build all objects, then resolve connectors against existing shape IDs and sites. */
export async function emitObjects(svg, objects, runtime, policy, available) {
  const presentation = runtime.Presentation.create({ slideSize: { width: svg.width, height: svg.height } });
  const slide = presentation.slides.add();
  slide.background.fill = svg.root.attrs["data-background"] ?? "#ffffff";
  const records = [], elements = new Map();
  let tableIndex = 0, chartIndex = 0, imageIndex = 0;
  for (const object of objects) {
    const record = { id: object.id, kind: object.kind, sourceIds: object.sourceIds, name: "af:" + object.id, reason: object.reason };
    const node = object.nodes[0];
    let result;
    if (object.kind === "text") {
      result = await emitText(slide, object, svg, runtime, policy, available);
    } else {
      const position = sourceBox(object, svg);
      if (["table", "chart", "vector", "image"].includes(object.kind) && !(position.width > 0 && position.height > 0)) throw new Error("Object needs positive position dimensions: " + object.id);
      if (object.kind === "table") result = emitTable(slide, object, position, policy, available, tableIndex++);
      else if (object.kind === "chart") result = emitChart(slide, object, position, policy, available, chartIndex++);
      else if (["vector", "image"].includes(object.kind)) {
        if (position.left <= 0 && position.top <= 0 && position.width >= svg.width && position.height >= svg.height) throw new Error("A full-canvas picture cannot replace the editable diagram");
        if (object.leaves.some((leaf) => leaf.name === "text")) throw new Error("Keep external labels as native text, outside the icon/sample asset: " + object.id);
        let asset;
        if (node.name === "image" && object.nodes.length === 1) asset = await imageBytes(node, svg);
        else asset = { bytes: Buffer.from(vectorAsset(object.nodes, svg, position)), contentType: "image/svg+xml" };
        if (object.kind === "vector") {
          if (asset.contentType !== "image/svg+xml" || /<image\b/i.test(asset.bytes.toString())) throw new Error("Simple icon needs one pure SVG asset: " + object.id);
          record.svgAsset = { xml: asset.bytes.toString() };
        } else if (asset.contentType === "image/svg+xml" && !object.reason) throw new Error("Rasterizing a vector asset requires a structural reason");
        const metadata = await runtime.sharp(asset.bytes).metadata();
        const png = await runtime.sharp(asset.bytes).png().toBuffer();
        const naturalRatio = metadata.width / metadata.height;
        const boxRatio = position.width / position.height;
        const aspect = attr(node, "preserveAspectRatio", "xMidYMid meet");
        let imagePosition = { ...position };
        if (node.name === "image" && aspect !== "none") {
          if (aspect !== "xMidYMid meet") throw new Error("Normalize image preserveAspectRatio before export: " + object.id);
          if (naturalRatio > boxRatio) { imagePosition.height = position.width / naturalRatio; imagePosition.top += (position.height - imagePosition.height) / 2; }
          else { imagePosition.width = position.height * naturalRatio; imagePosition.left += (position.width - imagePosition.width) / 2; }
        }
        const element = slide.images.add({ blob: png, contentType: "image/png", alt: record.name, fit: "cover", position: imagePosition });
        element.rotation = position.rotation ?? 0;
        element.flipHorizontal = position.horizontalFlip ?? false;
        element.flipVertical = position.verticalFlip ?? false;
        result = { element, imageIndex: imageIndex++ };
      } else {
        const style = object.fill !== undefined && object.line !== undefined ? { fill: object.fill, line: object.line } : paint(node, svg);
        const fill = object.fill ?? style.fill, line = { ...style.line, ...object.line };
        if (object.kind === "background") {
          if (typeof fill !== "string" || fill === "none" || /url\(/.test(fill)) throw new Error("Page background must be a solid opaque color: " + object.id);
          if (Math.abs(position.left) > 0.001 || Math.abs(position.top) > 0.001 || Math.abs(position.width - svg.width) > 0.001 || Math.abs(position.height - svg.height) > 0.001) throw new Error("Page background must cover the complete canvas");
          slide.background.fill = fill; records.push(record); continue;
        }
        record.stroke = { cap: "butt", join: "miter", dash: null, ...style.stroke, ...object.stroke };
        record.lineWidth = line.width;
        const custom = object.kind === "custom" || object.kind === "connector" && !object.preset;
        if (custom && object.nodes.length !== 1) throw new Error("Combine same-style source geometry into one SVG path before custom export: " + object.id);
        const geometry = custom ? customGeometry(node, svg) : { position };
        if (custom && geometry.customPaths.some((p) => p.commands.some((c) => c.quadBezTo))) record.previewLimitations = ['The preview renderer may omit quadratic Bezier segments; verify the final PPTX with another renderer.'];
        const preset = custom ? "custom" : object.preset;
        if (!custom) validatePreset(preset, runtime, object.id);
        let adjustments = object.adjustments;
        if (preset === "roundRect" && !adjustments) {
          const rx = number(node.attrs.rx, number(node.attrs.ry));
          const ry = number(node.attrs.ry, rx);
          if (Math.abs(rx - ry) > 0.001) throw new Error("Unequal rounded-corner radii need a custom geometry reason");
          adjustments = [{ name: "adj", formula: "val " + Math.round(Math.min(0.5, rx / Math.min(number(node.attrs.width), number(node.attrs.height))) * 100000) }];
        }
        const element = slide.shapes.add({ geometry: preset, name: record.name, ...geometry, fill: object.kind === "connector" ? "none" : fill, line, adjustmentList: adjustments });
        if (!custom) { record.preset = preset; record.adjustments = adjustments; }
        if (object.kind === "connector") {
          if (attr(node, "marker-start") && !object.headEnd || attr(node, "marker-end") && !object.tailEnd) throw new Error("Specify native headEnd/tailEnd for SVG markers: " + object.id);
          record.connector = { preset: object.preset, adjustments, custom, reason: object.reason, headEnd: object.headEnd, tailEnd: object.tailEnd };
        }
        result = { element };
      }
    }
    const { element, ...details } = result;
    elements.set(object.id, element);
    records.push({ ...record, ...details });
  }
  for (const object of objects.filter((o) => o.kind === "connector")) {
    const record = records.find((r) => r.id === object.id);
    for (const endpoint of ["from", "to"]) {
      if (!object[endpoint]) continue;
      const { id, side, index } = object[endpoint];
      record.connector[endpoint] = { id, index: index ?? slide.shapes.getConnectionSiteIndex(elements.get(id), side) };
    }
  }
  return { presentation, slide, records };
}
