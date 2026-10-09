/** Preserve semantic text units as one native PowerPoint text box. */
import { attr, number, worldMatrix, xmlEscape } from "./svg.mjs";
import { point } from "./geometry.mjs";
import { fontRuns, requireFont } from "./runtime.mjs";

const PX_TO_EMU = 9525;
const PX_TO_POINT = 0.75;

/** Measure actual glyphs with installed fonts; SVG trim also measures baseline. */
function measurer(runtime) {
  const cache = new Map();
  return async (runs) => {
    const key = JSON.stringify(runs);
    if (cache.has(key)) return cache.get(key);
    const measured = (async () => {
      const size = Math.max(...runs.map((run) => number(run.textStyle.fontSize, 18)));
      const markup = runs.map(({ run, textStyle: style }) => '<span font_family="' + xmlEscape(style.typeface) + '" size="' + Math.round(number(style.fontSize, 18) * 1024) + '" weight="' + (style.bold ? 'bold' : 'normal') + '" style="' + (style.italic ? 'italic' : 'normal') + '">' + xmlEscape(run) + '</span>').join("");
      const probe = '<span font_family="' + xmlEscape(runs[0].textStyle.typeface) + '" size="' + Math.round(size * 1024) + '">|</span>';
      const [metadata, sentinel] = await Promise.all([
        runtime.sharp({ text: { text: markup + probe, font: runs[0].textStyle.typeface + ' ' + size, dpi: 72, rgba: true } }).metadata(),
        runtime.sharp({ text: { text: probe, font: runs[0].textStyle.typeface + ' ' + size, dpi: 72, rgba: true } }).metadata(),
      ]);
      const width = Math.max(0, metadata.width - sentinel.width);
      const baseline = Math.ceil(size * 3);
      const padding = Math.ceil(size * 2);
      const fragments = runs.map(({ run, textStyle: style }) => '<tspan font-family="' + xmlEscape(style.typeface) + '" font-size="' + number(style.fontSize, 18) + '" font-weight="' + (style.bold ? 'bold' : 'normal') + '" font-style="' + (style.italic ? 'italic' : 'normal') + '">' + xmlEscape(run) + '</tspan>').join("");
      const image = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.ceil(metadata.width + padding * 2) + '" height="' + Math.ceil(size * 6) + '"><text x="' + padding + '" y="' + baseline + '" xml:space="preserve" fill="black">' + fragments + '</text></svg>';
      if (!runs.some(({ run }) => /\S/.test(run))) {
        // Empty lines use the same font's visible metrics, while retaining their own text.
        const reference = await measureReference(runs, runtime, baseline, padding);
        return { width, ...reference };
      }
      const { info } = await runtime.sharp(Buffer.from(image)).trim().png().toBuffer({ resolveWithObject: true });
      const top = Math.abs(info.trimOffsetTop);
      return { width, ascent: baseline - top, descent: top + info.height - baseline };
    })();
    cache.set(key, measured);
    return measured;
  };
}

/** Get baseline metrics for a blank line from a visible font probe. */
async function measureReference(runs, runtime, baseline, padding) {
  const style = runs[0].textStyle;
  const size = number(style.fontSize, 18);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (padding * 3) + '" height="' + (baseline * 2) + '"><text x="' + padding + '" y="' + baseline + '" font-family="' + xmlEscape(style.typeface) + '" font-size="' + size + '" font-weight="' + (style.bold ? 'bold' : 'normal') + '">Hg</text></svg>';
  const { info } = await runtime.sharp(Buffer.from(svg)).trim().png().toBuffer({ resolveWithObject: true });
  const top = Math.abs(info.trimOffsetTop);
  return { ascent: baseline - top, descent: top + info.height - baseline };
}

/** Apply writing-system font policy, preserving explicitly authored run fonts. */
function styledRuns(run, style, policy, available) {
  if (style.typeface) {
    requireFont(style.typeface, available);
    return [{ run, textStyle: { ...style, fontSize: typeof style.fontSize === "number" ? style.fontSize + "px" : style.fontSize ?? "18px" } }];
  }
  return fontRuns(run, { ...style, fontSize: typeof style.fontSize === "number" ? style.fontSize + "px" : style.fontSize ?? "18px" }, policy, available);
}

/** Resolve source positions and styles in a common rotated coordinate frame. */
async function sourceLines(object, svg, measure, policy, available) {
  const roots = object.leaves.filter((node) => node.name === "text");
  if (!roots.length) throw new Error("Text object " + object.id + " needs SVG text sources or explicit paragraphs and position");
  const lines = [];
  let rotation;
  for (const root of roots) {
    let cursor = { x: number(root.attrs.x), y: number(root.attrs.y) };
    let line;
    const visit = async (node) => {
      if (!["text", "tspan"].includes(node.name)) throw new Error("Unsupported text child <" + node.name + "> in " + object.id);
      for (const key of ["baseline-shift", "dominant-baseline", "alignment-baseline", "textLength", "lengthAdjust", "rotate", "letter-spacing", "word-spacing"]) {
        const value = attr(node, key);
        if (value !== undefined && !["baseline", "auto", "normal", "0"].includes(String(value))) throw new Error("Resolve SVG " + key + "=" + value + " in text " + object.id + " using explicit paragraphs/position");
      }
      const matrix = worldMatrix(node, svg);
      const scale = Math.hypot(matrix.a, matrix.b);
      const sy = Math.hypot(matrix.c, matrix.d);
      if (Math.abs(scale - sy) > 1e-7 || Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > 1e-7 || matrix.a * matrix.d - matrix.b * matrix.c <= 0) throw new Error("Text " + object.id + " has a skew, non-uniform scale or reflection; normalize its source transform");
      const angle = Math.atan2(matrix.b, matrix.a);
      if (rotation !== undefined && Math.abs(rotation - angle) > 1e-7) throw new Error("Text " + object.id + " combines different rotations; author explicit paragraphs/position");
      rotation = angle;
      if (node !== root) {
        if (node.attrs.x !== undefined) cursor.x = number(node.attrs.x);
        if (node.attrs.y !== undefined) cursor.y = number(node.attrs.y);
      }
      cursor.x += number(node.attrs.dx);
      cursor.y += number(node.attrs.dy);
      for (const part of node.content) {
        if (typeof part !== "string") { await visit(part); continue; }
        if (!part) continue;
        // Whitespace used solely to indent child spans has no visible SVG glyphs.
        if (node.children.length && /^[\s]*[\r\n][\s]*$/.test(part)) continue;
        if (/[\r\n]/.test(part)) throw new Error("Text " + object.id + " contains line breaks without SVG baselines; author explicit paragraphs");
        const origin = point(matrix, cursor.x, cursor.y);
        const x = Math.cos(angle) * origin.x + Math.sin(angle) * origin.y;
        const y = -Math.sin(angle) * origin.x + Math.cos(angle) * origin.y;
        const anchor = attr(node, "text-anchor", "start");
        if (!["start", "middle", "end"].includes(anchor)) throw new Error("Unsupported text-anchor in " + object.id + ": " + anchor);
        const style = {
          fontSize: number(attr(node, "font-size"), 18) * scale + "px",
          bold: /^(bold|[7-9]00)$/.test(String(attr(node, "font-weight", "normal"))),
          italic: attr(node, "font-style", "normal") === "italic",
          color: attr(node, "fill", "#000000"),
          ...object.textStyle,
        };
        const runs = styledRuns(part, style, policy, available);
        if (!line || Math.abs(line.y - y) > 0.01) {
          line = { x, y, anchor, runs: [] };
          lines.push(line);
        } else {
          const previous = await measure(line.runs);
          if (Math.abs(x - line.x - previous.width) > 1) throw new Error("Text " + object.id + " has a same-baseline x jump; author explicit paragraphs/position to preserve it");
          if (anchor !== line.anchor) throw new Error("Text " + object.id + " changes text-anchor within one baseline");
        }
        line.runs.push(...runs);
        const metric = await measure(runs);
        cursor.x += metric.width / scale;
      }
    };
    await visit(root);
  }
  for (const line of lines) {
    line.metrics = await measure(line.runs);
    line.left = line.x - line.metrics.width * (line.anchor === "middle" ? 0.5 : line.anchor === "end" ? 1 : 0);
  }
  return { lines, rotation: rotation ?? 0 };
}

/**
 * Emit one native textbox for a semantic plan object and return its visible text
 * and installed font families. SVG baselines become structured paragraphs;
 * mixed runs retain style. Explicit paragraph indentation uses EMU, spacing uses
 * hundredths of a point, and lineSpacingPoints uses hundredths of a point, per Artifact Tool.
 * Position overrides use CSS pixels. Unsupported glyph placement raises an error.
 */
export async function emitText(slide, object, svg, runtime, policy, available) {
  const measure = measurer(runtime);
  let paragraphs;
  let layout;
  if (object.paragraphs) {
    paragraphs = object.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.flatMap((run) => styledRuns(run.run, { ...object.textStyle, ...run.textStyle }, policy, available)),
    }));
    if (!object.position) layout = await sourceLines(object, svg, measure, policy, available);
  } else {
    layout = await sourceLines(object, svg, measure, policy, available);
  }
  let position = object.position;
  if (layout) {
    const { lines, rotation } = layout;
    if (!lines.length) throw new Error("Text object " + object.id + " has no visible source text");
    const left = Math.min(...lines.map((line) => line.left));
    const top = Math.min(...lines.map((line) => line.y - line.metrics.ascent));
    const right = Math.max(...lines.map((line) => line.left + line.metrics.width));
    const bottom = Math.max(...lines.map((line) => line.y + line.metrics.descent));
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const worldCenter = { x: Math.cos(rotation) * cx - Math.sin(rotation) * cy, y: Math.sin(rotation) * cx + Math.cos(rotation) * cy };
    position ??= { left: worldCenter.x - (right - left) / 2, top: worldCenter.y - (bottom - top) / 2, width: right - left, height: bottom - top, rotation: rotation * 180 / Math.PI };
    if (!paragraphs) {
      paragraphs = lines.map((line, index) => {
        const next = lines[index + 1];
        if (next && next.y <= line.y) throw new Error("Text " + object.id + " has non-increasing baselines; author explicit paragraphs/position");
        const lineHeight = line.metrics.ascent + line.metrics.descent;
        const gap = next ? next.y - line.y - line.metrics.descent - next.metrics.ascent : 0;
        if (gap < -0.01) throw new Error("Text " + object.id + " has overlapping baseline metrics; author explicit paragraphs/position");
        return {
          runs: line.runs,
          marginLeft: Math.round((line.left - left) * PX_TO_EMU),
          indent: 0,
          spaceBefore: 0,
          spaceAfter: Math.round(Math.max(0, gap) * PX_TO_POINT * 100),
          paragraphStyle: { lineSpacingPoints: Math.round(lineHeight * PX_TO_POINT * 100) },
        };
      });
    }
  }
  const element = slide.shapes.add({ name: "af:" + object.id, geometry: "textbox", position, fill: "none", line: { fill: "none", width: 0 } });
  element.text.set(paragraphs);
  element.text.style = { ...object.textStyle, alignment: "left", verticalAlignment: "top", autoFit: "none", wrap: "none", insets: { left: 0, top: 0, right: 0, bottom: 0 } };
  return {
    element,
    text: paragraphs.map((paragraph) => paragraph.runs.map((run) => run.run).join("")).join("\n"),
    fonts: [...new Set(paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.textStyle.typeface)))],
  };
}
