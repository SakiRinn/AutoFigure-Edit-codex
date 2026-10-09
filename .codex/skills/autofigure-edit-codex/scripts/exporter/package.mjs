/** Complete and verify the editable OOXML objects produced by Artifact Tool. */
import path from 'node:path';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const DRAWABLE = new Set(['p:sp', 'p:cxnSp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
const node = (name, attributes = {}, elements = []) => ({ type: 'element', name, attributes, elements });
const children = (n, name) => (n.elements ?? []).filter(e => e.type === 'element' && (!name || e.name === name));
const child = (n, name) => children(n, name)[0];
const descendants = (n, name) => children(n).flatMap(e => [ ...(e.name === name ? [e] : []), ...descendants(e, name) ]);
const first = (n, name) => descendants(n, name)[0];
const text = n => (n?.elements ?? []).map(e => e.type === 'text' ? e.text : text(e)).join('');
const textNode = (name, value) => node(name, {}, [{ type: 'text', text: String(value) }]);
const remove = (n, names) => { n.elements = (n.elements ?? []).filter(e => !names.includes(e.name)); };
const put = (n, replacement) => { remove(n, [replacement.name]); (n.elements ??= []).push(replacement); };
const requireValue = (value, message) => { if (!value) throw new Error(message); return value; };
const column = index => { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

/** Read and serialize XML without rewriting package parts through string substitution. */
function xmlIO(zip, xml) {
  const normalize = tree => {
    if (tree.type === 'element') tree.elements ??= [];
    for (const element of tree.elements ?? []) normalize(element);
    return tree;
  };
  return {
    async read(name) { return normalize(xml.xml2js(await requireValue(zip.file(name), `Missing package part ${name}`).async('string'))); },
    write(name, tree) { zip.file(name, xml.js2xml(tree)); },
  };
}

/** Add package relationships using IDs that are unique within their part. */
function relationships(tree) {
  const root = requireValue(child(tree, 'Relationships'), 'Invalid relationship document');
  return {
    root,
    get(id) { return children(root, 'Relationship').find(e => e.attributes.Id === id); },
    add(type, target) {
      const used = new Set(children(root, 'Relationship').map(e => e.attributes.Id));
      let i = 1; while (used.has(`rId${i}`)) i++;
      const id = `rId${i}`; root.elements.push(node('Relationship', { Id: id, Type: REL + type, Target: target }));
      return id;
    },
  };
}

const blankRelationships = () => ({ elements: [node('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' })] });
const resolveTarget = (part, target) => target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(part), target));
const relPath = part => path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');

/** Change an exported shape into a real connector and bind its endpoints. */
function fixConnector(object, record, ids) {
  const options = record.connector ?? {};
  if (object.name === 'p:sp') {
    object.name = 'p:cxnSp';
    const nv = requireValue(child(object, 'p:nvSpPr'), `Connector ${record.id} lacks nonvisual properties`);
    nv.name = 'p:nvCxnSpPr';
    const props = requireValue(child(nv, 'p:cNvSpPr'), `Connector ${record.id} lacks shape properties`);
    props.name = 'p:cNvCxnSpPr'; remove(props, ['a:spLocks']);
    remove(object, ['p:txBody']);
  }
  requireValue(object.name === 'p:cxnSp', `${record.id} must be a connector`);
  const nv = requireValue(first(object, 'p:cNvCxnSpPr'), `${record.id} lacks connector properties`);
  remove(nv, ['a:stCxn', 'a:endCxn']);
  for (const [key, tag] of [['from', 'a:stCxn'], ['to', 'a:endCxn']]) {
    const endpoint = options[key];
    if (endpoint) {
      const id = requireValue(ids.get(endpoint.id), `${record.id} references missing endpoint ${endpoint.id}`);
      requireValue(Number.isInteger(endpoint.index) && endpoint.index >= 0, `${record.id} has invalid connection site`);
      nv.elements.push(node(tag, { id: String(id), idx: String(endpoint.index) }));
    }
  }
  const sp = requireValue(child(object, 'p:spPr'), `${record.id} lacks drawing properties`);
  const line = child(sp, 'a:ln') ?? node('a:ln');
  if (!child(sp, 'a:ln')) sp.elements.push(line);
  remove(line, ['a:headEnd', 'a:tailEnd']);
  for (const end of ['headEnd', 'tailEnd']) {
    const values = options[end] ?? { type: 'none' };
    line.elements.push(node(`a:${end}`, Object.fromEntries(Object.entries(values).map(([k, v]) => [k === 'width' ? 'w' : k === 'length' ? 'len' : k, String(v)]))));
  }
  const preset = options.preset ?? record.preset;
  if (preset && !options.custom) writePreset(sp, preset, options.adjustments ?? record.adjustments);
}

/** Set a preset geometry while preserving custom paths when explicitly requested. */
function writePreset(sp, preset, adjustments) {
  const existing = child(sp, 'a:prstGeom');
  if (adjustments === undefined && existing?.attributes?.prst === preset) return;
  remove(sp, ['a:prstGeom', 'a:custGeom']);
  const geometry = node('a:prstGeom', { prst: preset }, [node('a:avLst', {}, (adjustments ?? []).map(a => node('a:gd', { name: a.name, fmla: a.formula })))]);
  const transformIndex = (sp.elements ?? []).findIndex(e => e.name === 'a:xfrm');
  sp.elements.splice(transformIndex + 1, 0, geometry);
}

/** Preserve SVG stroke ends, joins and dash lengths as native DrawingML line properties. */
function writeStroke(object, record) {
  if (!record.stroke) return;
  const sp = requireValue(child(object, 'p:spPr'), `${record.id} lacks stroke properties`);
  const line = child(sp, 'a:ln') ?? node('a:ln');
  if (!child(sp, 'a:ln')) sp.elements.push(line);
  line.attributes ??= {};
  const cap = { butt: 'flat', round: 'rnd', square: 'sq' }[record.stroke.cap];
  if (record.stroke.cap) line.attributes.cap = requireValue(cap, `${record.id} invalid stroke cap`);
  remove(line, ['a:round', 'a:bevel', 'a:miter', 'a:prstDash', 'a:custDash']);
  const details = [];
  const dash = record.stroke.dash;
  if (dash?.length) {
    requireValue(record.lineWidth > 0 && dash.every(v => Number.isFinite(v) && v >= 0) && dash.some(v => v > 0), `${record.id} invalid dash pattern`);
    const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
    const stops = [];
    for (let i = 0; i < pattern.length; i += 2) stops.push(node('a:ds', { d: String(Math.round(pattern[i] / record.lineWidth * 100000)), sp: String(Math.round(pattern[i + 1] / record.lineWidth * 100000)) }));
    details.push(node('a:custDash', {}, stops));
  } else details.push(node('a:prstDash', { val: 'solid' }));
  const join = { miter: 'a:miter', round: 'a:round', bevel: 'a:bevel' }[record.stroke.join];
  if (record.stroke.join) details.push(node(requireValue(join, `${record.id} invalid stroke join`)));
  const endsAt = (line.elements ?? []).findIndex(e => ['a:headEnd', 'a:tailEnd', 'a:extLst'].includes(e.name));
  line.elements.splice(endsAt < 0 ? line.elements.length : endsAt, 0, ...details);
}

/** Read Artifact Tool runs and paragraphs without losing explicit line breaks. */
function visibleCell(value) {
  if (Array.isArray(value)) {
    const paragraphs = value.some(part => part && typeof part === 'object' && Array.isArray(part.runs));
    return value.map(visibleCell).join(paragraphs ? '\n' : '');
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.runs)) return value.runs.map(visibleCell).join('');
    if (Array.isArray(value.paragraphs)) return value.paragraphs.map(visibleCell).join('\n');
    return String(value.run ?? value.text ?? '');
  }
  return String(value ?? '');
}

/** Read paragraph and soft-break text from a native table cell. */
function tableCellText(cell) {
  const paragraphText = element => element.name === 'a:br' ? '\n' : element.name === 'a:t' ? text(element) : children(element).map(paragraphText).join('');
  return descendants(cell, 'a:p').map(paragraphText).join('\n');
}

/** Attach an SVG to the existing image object and keep its PNG fallback. */
function addVector(zip, io, types, object, record, rels, index, xml) {
  const svg = xml.xml2js(record.svgAsset.xml);
  requireValue(!first(svg, 'image') && !first(svg, 'svg:image'), `${record.id} vector contains a bitmap`);
  requireValue(child(svg, 'svg') || children(svg).some(e => e.name?.endsWith(':svg')), `${record.id} vector is not SVG`);
  const blip = requireValue(first(object, 'a:blip'), `${record.id} lacks PNG fallback`);
  const fallback = requireValue(rels.get(blip.attributes?.['r:embed']), `${record.id} lacks PNG relationship`);
  const fallbackPath = resolveTarget('ppt/slides/slide1.xml', fallback.attributes.Target);
  requireValue(zip.file(fallbackPath) && fallbackPath.toLowerCase().endsWith('.png'), `${record.id} fallback must be PNG`);
  const asset = `ppt/media/autofigure-vector-${index}.svg`;
  requireValue(!zip.file(asset), `SVG asset collision ${asset}`);
  zip.file(asset, record.svgAsset.xml);
  const rid = rels.add('image', `../media/${path.posix.basename(asset)}`);
  let list = child(blip, 'a:extLst'); if (!list) { list = node('a:extLst'); blip.elements.push(list); }
  list.elements = children(list).filter(e => e.attributes?.uri !== '{96DAC541-7B7A-43D3-8B79-37D633B846F1}');
  list.elements.push(node('a:ext', { uri: '{96DAC541-7B7A-43D3-8B79-37D633B846F1}' }, [node('asvg:svgBlip', { 'xmlns:asvg': 'http://schemas.microsoft.com/office/drawing/2016/SVG/main', 'r:embed': rid })]));
  const root = child(types, 'Types');
  if (!children(root, 'Default').some(e => e.attributes.Extension === 'svg')) root.elements.push(node('Default', { Extension: 'svg', ContentType: 'image/svg+xml' }));
  return { path: asset, fallback: fallbackPath, relationship: rid };
}

/** Convert a literal chart field to a workbook reference while keeping its cache. */
function chartReference(parent, field, formula, numeric, values) {
  const target = child(parent, field) ?? node(field);
  if (!child(parent, field)) parent.elements.push(target);
  const existingCache = first(target, numeric ? 'c:numCache' : 'c:strCache') ?? first(target, numeric ? 'c:numLit' : 'c:strLit');
  const cache = existingCache ?? node(numeric ? 'c:numCache' : 'c:strCache', {}, [
    ...(numeric ? [textNode('c:formatCode', 'General')] : []), node('c:ptCount', { val: String(values.length) }),
    ...values.map((v, idx) => node('c:pt', { idx: String(idx) }, [textNode('c:v', v)])),
  ]);
  cache.name = numeric ? 'c:numCache' : 'c:strCache';
  const points = children(cache, 'c:pt');
  requireValue(points.length === values.length && points.every((p, i) => numeric ? Number(text(child(p, 'c:v'))) === values[i] : text(child(p, 'c:v')) === String(values[i])), `Chart cache differs from supplied data for ${field}`);
  target.elements = [node(numeric ? 'c:numRef' : 'c:strRef', {}, [textNode('c:f', formula), cache])];
}

/** Build a real XLSX source for a literal-data chart through Artifact Tool. */
async function ensureChartWorkbook(zip, io, types, part, record, runtime) {
  const chartTree = await io.read(part);
  const chartSpace = requireValue(child(chartTree, 'c:chartSpace'), `Invalid chart ${part}`);
  const chart = requireValue(record.chart, `${record.id} lacks chart data`);
  const chartBody = requireValue(child(chartSpace, 'c:chart'), `${record.id} lacks chart body`);
  if (!chart.title || chart.titlePlacement === 'none') {
    remove(chartBody, ['c:title', 'c:autoTitleDeleted']);
    chartBody.elements.unshift(node('c:autoTitleDeleted', { val: '1' }));
  }
  const seriesNodes = descendants(chartSpace, 'c:ser');
  requireValue(seriesNodes.length === chart.series.length, `${record.id} chart series count differs`);
  const workbook = runtime.Workbook.create();
  const sheet = workbook.worksheets.add('Data');
  let nextColumn = 0;
  for (let i = 0; i < chart.series.length; i++) {
    const series = chart.series[i]; const item = seriesNodes[i];
    const count = series.values.length;
    requireValue(count > 0 && series.values.every(Number.isFinite), `${record.id} contains invalid numerical chart data`);
    const write = (values, label) => {
      const col = column(nextColumn++);
      sheet.getRange(`${col}1:${col}${values.length + 1}`).values = [[label], ...values.map(v => [typeof v === 'string' && v.startsWith('=') ? "'" + v : v])];
      return { header: `'Data'!$${col}$1`, values: `'Data'!$${col}$2:$${col}$${values.length + 1}` };
    };
    const y = write(series.values, series.name);
    chartReference(item, 'c:tx', y.header, false, [series.name]);
    const isXY = Boolean(child(item, 'c:xVal')) || ['scatter', 'bubble'].includes(chart.type);
    if (isXY) {
      requireValue(series.xValues?.length === count && series.xValues.every(Number.isFinite), `${record.id} requires complete X values`);
      const x = write(series.xValues, `${series.name} X`);
      chartReference(item, 'c:xVal', x.values, true, series.xValues);
      chartReference(item, 'c:yVal', y.values, true, series.values);
    } else {
      requireValue(chart.categories.length === count, `${record.id} category count differs`);
      const x = write(chart.categories, 'Category');
      chartReference(item, 'c:cat', x.values, false, chart.categories);
      chartReference(item, 'c:val', y.values, true, series.values);
    }
    if (chart.type === 'bubble' || child(item, 'c:bubbleSize')) {
      requireValue(series.bubbleSizes?.length === count && series.bubbleSizes.every(Number.isFinite), `${record.id} requires complete bubble sizes`);
      const sizes = write(series.bubbleSizes, `${series.name} Size`);
      chartReference(item, 'c:bubbleSize', sizes.values, true, series.bubbleSizes);
    }
  }
  const file = await runtime.SpreadsheetFile.exportXlsx(workbook);
  const data = file.data;
  const target = `ppt/embeddings/autofigure-${path.posix.basename(part, '.xml')}.xlsx`;
  zip.file(target, data);
  const rp = relPath(part); const rt = zip.file(rp) ? await io.read(rp) : blankRelationships();
  const rels = relationships(rt);
  remove(chartSpace, ['c:externalData']);
  const rid = rels.add('package', path.posix.relative(path.posix.dirname(part), target));
  const extensionIndex = (chartSpace.elements ?? []).findIndex(e => e.name === 'c:extLst');
  const external = node('c:externalData', { 'r:id': rid }, [node('c:autoUpdate', { val: '0' })]);
  chartSpace.elements.splice(extensionIndex < 0 ? chartSpace.elements.length : extensionIndex, 0, external);
  chartSpace.attributes['xmlns:r'] ??= REL.slice(0, -1);
  const typeRoot = child(types, 'Types');
  if (!children(typeRoot, 'Default').some(e => e.attributes.Extension === 'xlsx')) typeRoot.elements.push(node('Default', { Extension: 'xlsx', ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  io.write(part, chartTree); io.write(rp, rt);
  return { part, workbook: target, series: chart.series, categories: chart.categories, type: chart.type };
}

/** Map each semantic record to one exported object, correct its XML, and audit the final ZIP. */
export async function finishPackage(bytes, records, runtime) {
  const zip = await runtime.JSZip.loadAsync(bytes); const io = xmlIO(zip, runtime.xml);
  const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  requireValue(slides.length === 1 && slides[0] === 'ppt/slides/slide1.xml', 'Exporter requires exactly one slide');
  const slide = await io.read(slides[0]); const tree = requireValue(first(slide, 'p:spTree'), 'Slide lacks object tree');
  const slideRoot = child(slide, 'p:sld');
  slideRoot.attributes['xmlns:a'] = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  slideRoot.attributes['xmlns:r'] = REL.slice(0, -1);
  const relTree = await io.read('ppt/slides/_rels/slide1.xml.rels'); const rels = relationships(relTree);
  const types = await io.read('[Content_Types].xml');
  const objects = children(tree).filter(e => DRAWABLE.has(e.name));
  const pictures = objects.filter(e => e.name === 'p:pic');
  const tables = objects.filter(e => first(e, 'a:tbl')); const charts = objects.filter(e => first(e, 'c:chart'));
  const selected = []; const mapped = new Map(); const ids = new Map();
  for (const record of records.filter(r => r.kind !== 'background')) {
    requireValue(!ids.has(record.id), `Duplicate record ID ${record.id}`);
    const candidates = record.kind === 'table' ? [tables[record.tableIndex]] : record.kind === 'chart' ? [charts[record.chartIndex]] : ['vector', 'image'].includes(record.kind) ? [pictures[record.imageIndex]] : objects.filter(o => {
      const meta = first(o, 'p:cNvPr'); return [meta?.attributes?.name, meta?.attributes?.descr].includes(record.name ?? `af:${record.id}`);
    });
    requireValue(candidates.length === 1 && candidates[0], `${record.id} must match exactly one PPT object`);
    const object = candidates[0]; requireValue(!selected.includes(object), `${record.id} maps to an already used PPT object`);
    const meta = requireValue(first(object, 'p:cNvPr'), `${record.id} lacks object ID`);
    meta.attributes.name = record.name ?? `af:${record.id}`; meta.attributes.descr = record.name ?? `af:${record.id}`;
    requireValue(Number.isInteger(Number(meta.attributes.id)) && Number(meta.attributes.id) > 0, `${record.id} has invalid PPT ID`);
    ids.set(record.id, meta.attributes.id); selected.push(object); mapped.set(record.id, object);
  }
  requireValue(new Set(ids.values()).size === ids.size, 'PPT object IDs are duplicated');
  requireValue(objects.length === selected.length, 'PPT contains visible objects absent from semantic records');
  const report = { objects: [], visual: 'pending', editing: 'pending', notesEmpty: true, structure: 'passed' };
  for (const [index, record] of records.entries()) {
    if (record.kind === 'background') { report.objects.push({ id: record.id, kind: 'background', type: 'background', sourceIds: record.sourceIds, pptId: null }); continue; }
    const object = mapped.get(record.id);
    if (record.kind === 'connector') fixConnector(object, record, ids);
    else if (record.preset && record.kind !== 'custom') writePreset(requireValue(child(object, 'p:spPr'), `${record.id} lacks geometry`), record.preset, record.adjustments);
    const expectedType = { shape: 'p:sp', custom: 'p:sp', connector: 'p:cxnSp', text: 'p:sp', vector: 'p:pic', image: 'p:pic', table: 'p:graphicFrame', chart: 'p:graphicFrame' }[record.kind];
    requireValue(expectedType && object.name === expectedType, `${record.id} has wrong PPT object type ${object.name}`);
    if (record.kind === 'custom' || record.connector?.custom) requireValue(first(object, 'a:custGeom'), `${record.id} lacks editable custom geometry`);
    if (record.kind === 'shape') requireValue(first(object, 'a:prstGeom'), `${record.id} lacks preset geometry`);
    if (['shape', 'custom', 'connector'].includes(record.kind)) writeStroke(object, record);
    const item = { id: record.id, kind: record.kind, type: record.kind, sourceIds: record.sourceIds, pptId: Number(ids.get(record.id)), pptType: object.name };
    if (record.kind === 'vector') item.svg = addVector(zip, io, types, object, record, rels, index, runtime.xml);
    if (record.kind === 'table') {
      const values = children(first(object, 'a:tbl'), 'a:tr').map(row => children(row, 'a:tc').map(tableCellText));
      requireValue(JSON.stringify(values) === JSON.stringify(record.table.values.map(row => row.map(visibleCell))), `${record.id} table values differ`);
      item.table = { values };
    }
    if (record.kind === 'chart') {
      const rel = requireValue(rels.get(first(object, 'c:chart').attributes['r:id']), `${record.id} chart relationship missing`);
      item.chart = await ensureChartWorkbook(zip, io, types, resolveTarget(slides[0], rel.attributes.Target), record, runtime);
    }
    item.preset = first(object, 'a:prstGeom')?.attributes?.prst ?? null;
    if (record.stroke) item.stroke = {
      cap: first(object, 'a:ln')?.attributes?.cap,
      join: ['a:miter', 'a:round', 'a:bevel'].find(name => first(object, name)) ?? null,
      dash: descendants(object, 'a:ds').map(stop => stop.attributes),
    };
    if (record.kind === 'connector') item.connector = {
      from: first(object, 'a:stCxn')?.attributes ?? null, to: first(object, 'a:endCxn')?.attributes ?? null,
      headEnd: first(object, 'a:headEnd')?.attributes, tailEnd: first(object, 'a:tailEnd')?.attributes,
      custom: Boolean(first(object, 'a:custGeom')), reason: record.connector?.reason,
    };
    if (record.kind === 'text') {
      item.text = descendants(object, 'a:t').map(text).join('');
      item.fonts = [...new Set(['a:latin', 'a:ea', 'a:cs'].flatMap(name => descendants(object, name).map(n => n.attributes?.typeface)).filter(Boolean))];
      requireValue(record.text === undefined || item.text === record.text.replace(/\n/g, ''), `${record.id} text content differs`);
    }
    report.objects.push(item);
  }
  tree.elements = [...(tree.elements ?? []).filter(e => !DRAWABLE.has(e.name)), ...selected];
  for (const name of Object.keys(zip.files).filter(p => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))) {
    const notes = await io.read(name);
    for (const t of descendants(notes, 'a:t')) t.elements = [];
    io.write(name, notes);
  }
  io.write(slides[0], slide); io.write('ppt/slides/_rels/slide1.xml.rels', relTree); io.write('[Content_Types].xml', types);
  const result = await zip.generateAsync({ type: 'uint8array' });
  // Re-open the delivered bytes so reporting describes the serialized package.
  const finalZip = await runtime.JSZip.loadAsync(result); const finalIO = xmlIO(finalZip, runtime.xml);
  for (const name of Object.keys(finalZip.files).filter(p => p.endsWith('.rels'))) {
    const part = name === '_rels/.rels' ? '' : name.replace('/_rels/', '/').slice(0, -5);
    const rels = relationships(await finalIO.read(name));
    for (const rel of children(rels.root, 'Relationship')) {
      if (rel.attributes.TargetMode === 'External') continue;
      const target = part ? resolveTarget(part, rel.attributes.Target) : rel.attributes.Target.replace(/^\//, '');
      requireValue(finalZip.file(target), 'Missing relationship target ' + target + ' from ' + name);
    }
  }
  const finalTree = first(await finalIO.read(slides[0]), 'p:spTree');
  const finalObjects = children(finalTree).filter(e => DRAWABLE.has(e.name));
  requireValue(finalObjects.length === selected.length && finalObjects.every((o, i) => first(o, 'p:cNvPr')?.attributes?.id === first(selected[i], 'p:cNvPr')?.attributes?.id), 'Final object order differs');
  for (const name of Object.keys(finalZip.files).filter(p => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))) requireValue(descendants(await finalIO.read(name), 'a:t').every(t => !text(t)), 'Final notes contain text');
  for (const item of report.objects) {
    if (item.svg) requireValue(finalZip.file(item.svg.path) && finalZip.file(item.svg.fallback), `${item.id} SVG resources missing`);
    if (item.chart) requireValue(finalZip.file(item.chart.workbook), `${item.id} embedded chart workbook missing`);
  }
  return { bytes: result, report };
}
