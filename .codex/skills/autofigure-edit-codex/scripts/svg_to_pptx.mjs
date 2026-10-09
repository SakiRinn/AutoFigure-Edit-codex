/**
 * Export an editable, one-slide PPTX from SVG and an Agent-authored semantic plan.
 * Usage: node svg_to_pptx.mjs INPUT.svg OUTPUT.pptx [--plan PLAN.json]
 * Requires RUNTIME_NODE_MODULES, ARTIFACT_TOOL_PATH, fontconfig and chosen fonts.
 * See ../references/exporter.md for the plan contract and native-object examples.
 * Outputs OUTPUT.pptx, OUTPUT.pptx.preview.png and OUTPUT.pptx.objects.json.
 * The preview is rendered after importing the final PPTX. The JSON reports actual
 * package structure; visual fidelity and user editing still need inspection.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRuntime, installedFonts, fontPolicy } from './exporter/runtime.mjs';
import { readSvg } from './exporter/svg.mjs';
import { resolvePlan } from './exporter/plan.mjs';
import { emitObjects } from './exporter/objects.mjs';
import { finishPackage } from './exporter/package.mjs';

/** Complete native construction and serialized-package checks before publishing. */
export async function exportSvg({ input, output, plan = {}, runtime }) {
  input = path.resolve(input); output = path.resolve(output);
  if (input === output) throw new Error('Keep the input SVG; output must use a different path');
  runtime ??= await loadRuntime();
  const svg = await readSvg(input, runtime.sax);
  const objects = resolvePlan(svg, plan);
  const available = await installedFonts();
  const policy = fontPolicy(plan.fonts, available);
  const built = await emitObjects(svg, objects, runtime, policy, available);
  const draft = await runtime.PresentationFile.exportPptx(built.presentation);
  const finished = await finishPackage(draft.data, built.records, runtime);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(output), '.autofigure-export-'));
  try {
    const candidate = path.join(temporary, 'candidate.pptx');
    await fs.writeFile(candidate, finished.bytes);
    const imported = await runtime.PresentationFile.importPptx(await runtime.FileBlob.load(candidate));
    const slide = imported.slides.items[0];
    const importedNames = new Set(slide.shapes.items.map((shape) => shape.name));
    const missing = built.records.filter((record) => ['shape', 'custom', 'connector', 'text'].includes(record.kind) && !importedNames.has(record.name));
    const previewWarnings = missing.map((record) => 'The preview renderer omitted ' + record.id + '; inspect its native object with another PPTX renderer before visual acceptance.');
    for (const record of built.records) {
      for (const warning of record.previewLimitations ?? []) previewWarnings.push(record.id + ': ' + warning);
      if (record.stroke?.dash?.length) previewWarnings.push(record.id + ': The preview renderer may show custom dashes as solid; verify the final PPTX line pattern.');
    }
    const preview = await imported.export({ slide, format: 'png', scale: 1 });
    const report = {
      ...finished.report, input, output, slideSize: { width: svg.width, height: svg.height },
      fontPolicy: policy, previewWarnings, previewComplete: previewWarnings.length === 0, previewSource: 'reimported-final-pptx',
      counts: Object.fromEntries([...new Set(built.records.map((r) => r.kind))].map((kind) => [kind, built.records.filter((r) => r.kind === kind).length])),
    };
    const previewFile = path.join(temporary, 'preview.png');
    const reportFile = path.join(temporary, 'objects.json');
    await fs.writeFile(previewFile, new Uint8Array(await preview.arrayBuffer()));
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    await fs.rename(candidate, output);
    await fs.rename(previewFile, output + '.preview.png');
    await fs.rename(reportFile, output + '.objects.json');
    return report;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node svg_to_pptx.mjs INPUT.svg OUTPUT.pptx [--plan PLAN.json]\nSee references/exporter.md for object plans and runtime requirements.');
    return;
  }
  if (!(args.length === 2 || args.length === 4 && args[2] === '--plan')) throw new Error('Usage: svg_to_pptx.mjs INPUT.svg OUTPUT.pptx [--plan PLAN.json]');
  const plan = args[3] ? JSON.parse(await fs.readFile(args[3], 'utf8')) : {};
  const report = await exportSvg({ input: args[0], output: args[1], plan });
  console.log(JSON.stringify({ output: report.output, counts: report.counts, structure: report.structure, visual: report.visual, editing: report.editing, previewComplete: report.previewComplete, previewWarnings: report.previewWarnings }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
