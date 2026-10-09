/** SVG geometry in local pixel coordinates, independent of the PPTX runtime. */
const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/y;

export const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** Compose affine transforms; right acts on a point before left. */
export function multiply(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export const point = (matrix, x, y) => ({
  x: matrix.a * x + matrix.c * y + matrix.e,
  y: matrix.b * x + matrix.d * y + matrix.f,
});

/** Read SVG numbers and report the character offset of invalid input. */
function scanner(source, label) {
  let offset = 0;
  const skip = () => { while (/[\s,]/.test(source[offset] ?? "") && offset < source.length) offset++; };
  const fail = (message) => { throw new Error(`${label} at character ${offset}: ${message}`); };
  return {
    peek() { skip(); return source[offset]; },
    advance() { return source[offset++]; },
    number() {
      skip();
      NUMBER.lastIndex = offset;
      const match = NUMBER.exec(source);
      if (!match) fail("expected a number");
      offset = NUMBER.lastIndex;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) fail("number must be finite");
      return value;
    },
    flag() {
      skip();
      if (source[offset] !== "0" && source[offset] !== "1") fail("arc flag must be 0 or 1");
      return Number(source[offset++]);
    },
    fail,
  };
}

/** Parse the SVG transform list in its specified composition order. */
export function parseTransform(value) {
  const source = String(value ?? "");
  const pattern = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  let matrix = identity();
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (source.slice(offset, match.index).replace(/[\s,]/g, "")) {
      throw new Error(`Malformed SVG transform at character ${offset}`);
    }
    offset = match.index + match[0].length;
    const input = scanner(match[2], `SVG transform ${match[1]}`);
    const values = [];
    while (input.peek() !== undefined) values.push(input.number());
    const name = match[1].toLowerCase();
    let next;
    if (name === "matrix" && values.length === 6) {
      const [a, b, c, d, e, f] = values;
      next = { a, b, c, d, e, f };
    } else if (name === "translate" && [1, 2].includes(values.length)) {
      next = { ...identity(), e: values[0], f: values[1] ?? 0 };
    } else if (name === "scale" && [1, 2].includes(values.length)) {
      next = { ...identity(), a: values[0], d: values[1] ?? values[0] };
    } else if (name === "rotate" && [1, 3].includes(values.length)) {
      const radians = values[0] * Math.PI / 180;
      next = { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 };
      if (values.length === 3) {
        const [, cx, cy] = values;
        next = multiply(multiply({ ...identity(), e: cx, f: cy }, next), { ...identity(), e: -cx, f: -cy });
      }
    } else if (name === "skewx" && values.length === 1) {
      next = { ...identity(), c: Math.tan(values[0] * Math.PI / 180) };
    } else if (name === "skewy" && values.length === 1) {
      next = { ...identity(), b: Math.tan(values[0] * Math.PI / 180) };
    } else {
      throw new Error(`Unsupported or malformed SVG transform: ${match[0]}`);
    }
    matrix = multiply(matrix, next);
  }
  if (source.slice(offset).trim()) throw new Error(`Malformed SVG transform at character ${offset}`);
  return matrix;
}

/** Convert an SVG endpoint arc to tangent-matched cubic Bezier segments.
 * Each segment spans at most 45 degrees. A conservative radius * angle^6 / 1000
 * error estimate limits the local geometric error target to 0.05 pixels.
 */
function arcCommands(start, rxInput, ryInput, angle, largeArc, sweep, end) {
  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  if (start.x === end.x && start.y === end.y) return [];
  if (!rx || !ry) return [{ lineTo: end }];
  const phi = angle * Math.PI / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const scale = Math.sqrt(Math.max(1, (xp / rx) ** 2 + (yp / ry) ** 2));
  rx *= scale;
  ry *= scale;
  const normalized = (xp / rx) ** 2 + (yp / ry) ** 2;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (1 - normalized) / normalized));
  const cxp = factor * rx * yp / ry;
  const cyp = -factor * ry * xp / rx;
  const cx = cos * cxp - sin * cyp + (start.x + end.x) / 2;
  const cy = sin * cxp + cos * cyp + (start.y + end.y) / 2;
  const ux = (xp - cxp) / rx;
  const uy = (yp - cyp) / ry;
  const vx = (-xp - cxp) / rx;
  const vy = (-yp - cyp) / ry;
  const theta = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const maxAngle = Math.min(Math.PI / 4, (50 / Math.max(rx, ry)) ** (1 / 6));
  const count = Math.ceil(Math.abs(delta) / maxAngle);
  const step = delta / count;
  const ellipse = (x, y) => ({ x: cx + cos * rx * x - sin * ry * y, y: cy + sin * rx * x + cos * ry * y });
  const commands = [];
  for (let index = 0; index < count; index++) {
    const a = theta + step * index;
    const b = a + step;
    const alpha = 4 / 3 * Math.tan(step / 4);
    const control1 = ellipse(Math.cos(a) - alpha * Math.sin(a), Math.sin(a) + alpha * Math.cos(a));
    const control2 = ellipse(Math.cos(b) + alpha * Math.sin(b), Math.sin(b) - alpha * Math.cos(b));
    const target = index === count - 1 ? end : ellipse(Math.cos(b), Math.sin(b));
    commands.push({ cubicBezTo: { x1: control1.x, y1: control1.y, x2: control2.x, y2: control2.y, ...target } });
  }
  return commands;
}

/** Parse every SVG path command to absolute editable geometry; preserve curves. */
export function parsePath(d) {
  const input = scanner(String(d ?? ""), "SVG path");
  const commands = [];
  let command;
  let current = { x: 0, y: 0 };
  let subpath;
  let lastCubic;
  let lastQuadratic;
  const target = (relative) => ({ x: input.number() + (relative ? current.x : 0), y: input.number() + (relative ? current.y : 0) });
  while (input.peek() !== undefined) {
    if (/[A-Za-z]/.test(input.peek())) command = input.advance();
    if (!command) input.fail("expected a path command");
    const lower = command.toLowerCase();
    const relative = command === lower;
    if (!subpath && lower !== "m") input.fail("path must begin with moveto");
    let cubic;
    let quadratic;
    if (lower === "z") {
      commands.push({ close: {} });
      current = { ...subpath };
      command = undefined;
    } else if (lower === "m" || lower === "l") {
      current = target(relative);
      commands.push(lower === "m" ? { moveTo: current } : { lineTo: current });
      if (lower === "m") {
        subpath = { ...current };
        command = relative ? "l" : "L";
      }
    } else if (lower === "h" || lower === "v") {
      const value = input.number();
      current = lower === "h"
        ? { x: value + (relative ? current.x : 0), y: current.y }
        : { x: current.x, y: value + (relative ? current.y : 0) };
      commands.push({ lineTo: current });
    } else if (lower === "c" || lower === "s") {
      const control1 = lower === "c" ? target(relative)
        : lastCubic ? { x: 2 * current.x - lastCubic.x, y: 2 * current.y - lastCubic.y } : { ...current };
      cubic = target(relative);
      const end = target(relative);
      commands.push({ cubicBezTo: { x1: control1.x, y1: control1.y, x2: cubic.x, y2: cubic.y, ...end } });
      current = end;
    } else if (lower === "q" || lower === "t") {
      quadratic = lower === "q" ? target(relative)
        : lastQuadratic ? { x: 2 * current.x - lastQuadratic.x, y: 2 * current.y - lastQuadratic.y } : { ...current };
      const end = target(relative);
      commands.push({ quadBezTo: { x1: quadratic.x, y1: quadratic.y, ...end } });
      current = end;
    } else if (lower === "a") {
      const rx = input.number();
      const ry = input.number();
      const angle = input.number();
      const largeArc = input.flag();
      const sweep = input.flag();
      const end = target(relative);
      commands.push(...arcCommands(current, rx, ry, angle, largeArc, sweep, end));
      current = end;
    } else input.fail(`unsupported command ${command}`);
    lastCubic = cubic;
    lastQuadratic = quadratic;
  }
  return commands;
}

/** Apply an affine transform to endpoints and every Bezier control point. */
export function transformCommands(commands, matrix) {
  return commands.map((command) => {
    if (command.close) return { close: {} };
    const [kind, value] = Object.entries(command)[0];
    const transformed = point(matrix, value.x, value.y);
    if (kind === "quadBezTo" || kind === "cubicBezTo") {
      const control = point(matrix, value.x1, value.y1);
      transformed.x1 = control.x;
      transformed.y1 = control.y;
    }
    if (kind === "cubicBezTo") {
      const control = point(matrix, value.x2, value.y2);
      transformed.x2 = control.x;
      transformed.y2 = control.y;
    }
    return { [kind]: transformed };
  });
}

/** Compute exact Bezier extrema for geometric bounds, excluding stroke width. */
export function commandBounds(commands) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let current;
  let start;
  const include = ({ x, y }) => { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); };
  const roots = (a, b, c) => {
    if (a === 0) return b === 0 ? [] : [-c / b];
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return [];
    if (discriminant === 0) return [-b / (2 * a)];
    const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant));
    return [q / a, c / q];
  };
  for (const command of commands) {
    if (command.moveTo) {
      current = start = command.moveTo;
      include(current);
    } else if (command.lineTo) {
      current = command.lineTo;
      include(current);
    } else if (command.close) {
      current = start;
    } else {
      const cubic = command.cubicBezTo;
      const curve = cubic ?? command.quadBezTo;
      const times = new Set();
      for (const axis of ["x", "y"]) {
        const p0 = current[axis];
        const p1 = curve[`${axis}1`];
        const end = curve[axis];
        const candidates = cubic
          ? roots(-p0 + 3 * p1 - 3 * curve[`${axis}2`] + end, 2 * (p0 - 2 * p1 + curve[`${axis}2`]), p1 - p0)
          : roots(0, p0 - 2 * p1 + end, p1 - p0);
        for (const t of candidates) if (t > 0 && t < 1) times.add(t);
      }
      for (const t of times) {
        const u = 1 - t;
        const evaluated = {};
        for (const axis of ["x", "y"]) {
          evaluated[axis] = cubic
            ? u ** 3 * current[axis] + 3 * u ** 2 * t * curve[`${axis}1`] + 3 * u * t ** 2 * curve[`${axis}2`] + t ** 3 * curve[axis]
            : u ** 2 * current[axis] + 2 * u * t * curve[`${axis}1`] + t ** 2 * curve[axis];
        }
        include(evaluated);
      }
      current = { x: curve.x, y: curve.y };
      include(current);
    }
  }
  if (left === Infinity) throw new Error("Cannot compute bounds of an empty SVG path");
  return { left, top, width: right - left, height: bottom - top };
}

/** Convert one SVG primitive to the same path command representation. */
export function primitiveCommands(node) {
  const attrs = node.attrs;
  const number = (name, fallback = 0) => {
    if (attrs[name] === undefined) return fallback;
    const value = String(attrs[name]).trim();
    const input = scanner(value.replace(/px$/, ""), `<${node.name}> ${name}`);
    const result = input.number();
    if (input.peek() !== undefined) input.fail("expected a unitless or px length");
    return result;
  };
  if (node.name === "path") return parsePath(attrs.d);
  if (node.name === "line") return [{ moveTo: { x: number("x1"), y: number("y1") } }, { lineTo: { x: number("x2"), y: number("y2") } }];
  if (node.name === "polyline" || node.name === "polygon") {
    const input = scanner(String(attrs.points ?? ""), `<${node.name}> points`);
    const commands = [];
    while (input.peek() !== undefined) {
      const target = { x: input.number(), y: input.number() };
      commands.push(commands.length ? { lineTo: target } : { moveTo: target });
    }
    if (node.name === "polygon" && commands.length) commands.push({ close: {} });
    return commands;
  }
  if (node.name === "rect") {
    const x = number("x");
    const y = number("y");
    const width = number("width");
    const height = number("height");
    let rx = number("rx", number("ry"));
    let ry = number("ry", rx);
    if (width < 0 || height < 0 || rx < 0 || ry < 0) throw new Error("SVG rect dimensions and radii must be nonnegative");
    if (!width || !height) return [];
    rx = Math.min(rx, width / 2);
    ry = Math.min(ry, height / 2);
    if (!rx || !ry) return parsePath(`M${x},${y}h${width}v${height}h${-width}Z`);
    return parsePath(`M${x + rx},${y}H${x + width - rx}A${rx},${ry} 0 0 1 ${x + width},${y + ry}V${y + height - ry}A${rx},${ry} 0 0 1 ${x + width - rx},${y + height}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + height - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`);
  }
  if (node.name === "circle" || node.name === "ellipse") {
    const cx = number("cx");
    const cy = number("cy");
    const rx = node.name === "circle" ? number("r") : number("rx");
    const ry = node.name === "circle" ? rx : number("ry");
    if (rx < 0 || ry < 0) throw new Error(`SVG ${node.name} radii must be nonnegative`);
    if (!rx || !ry) return [];
    return parsePath(`M${cx + rx},${cy}A${rx},${ry} 0 0 1 ${cx - rx},${cy}A${rx},${ry} 0 0 1 ${cx + rx},${cy}Z`);
  }
  throw new Error(`Unsupported SVG primitive <${node.name}>`);
}
