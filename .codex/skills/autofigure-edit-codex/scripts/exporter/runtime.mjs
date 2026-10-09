/** Load the same bundled libraries on desktop and webide. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

export async function loadRuntime() {
  const modules = process.env.RUNTIME_NODE_MODULES;
  const artifact = process.env.ARTIFACT_TOOL_PATH;
  if (!modules || !artifact) throw new Error("Set RUNTIME_NODE_MODULES and ARTIFACT_TOOL_PATH; see references/exporter.md");
  const require = createRequire(path.join(modules, "__autofigure__.cjs"));
  const load = async (name) => {
    const module = require(name);
    return module.default ?? module;
  };
  const [api, sax, JSZip, xml, sharp] = await Promise.all([
    import(pathToFileURL(artifact).href), load("sax"),
    load("jszip"), load("xml-js"), load("sharp"),
  ]);
  return { ...api, sax, JSZip, xml, sharp };
}

/** Fontconfig enumerates installed families; never silently substitute a font. */
export async function installedFonts() {
  const { stdout } = await promisify(execFile)("fc-list", ["-f", "%{family}\n"], { maxBuffer: 4 * 1024 * 1024 });
  return new Set(stdout.split(/[\n,]/).map((name) => name.trim().toLowerCase()).filter(Boolean));
}

export function fontPolicy(requested, available) {
  return {
    latin: requested?.latin ?? "Times New Roman",
    cjk: requested?.cjk ?? (available.has("stsong") ? "STSong" : "NSimSun"),
  };
}

export function requireFont(name, available) {
  if (!available.has(name.toLowerCase())) throw new Error("Missing installed font: " + name);
}

/** Split writing systems without changing text, whitespace or run styling. */
export function fontRuns(text, style, policy, available) {
  const parts = text.match(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]+|[^\p{Script=Han}\u3000-\u303f\uff00-\uffef]+/gu) ?? [];
  return parts.map((part) => {
    const typeface = style.typeface ?? (/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(part) ? policy.cjk : policy.latin);
    requireFont(typeface, available);
    return { run: part, textStyle: { ...style, typeface } };
  });
}
