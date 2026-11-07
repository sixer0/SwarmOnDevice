// Row 122 test kit: render a v1 fixture to DOCX through the vendored engine (normalizeDocument ->
// assembleDocx) with the canonical profile resolved in memory. Pure local: no DB, no network, no browser
// (figures come from a stub store), no model calls. XML is read back with fflate and plain regexes.
import { mock } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { NormDocSnapshot, RenderContext, RenderLogEntry, ResolvedTemplate, StudioDocV1 } from "../../../vendor/src/lib/studio/contract";

export const PKG = path.resolve(import.meta.dir, "..", "..", "..");
export const VENDOR = path.join(PKG, "vendor");
export const STUDIO = path.join(VENDOR, "src", "lib", "studio");

// contract/ui.ts imports lucide-react (not installed here); same stub as test/engine-twins.
const icon = () => null;
mock.module("lucide-react", () => ({ Activity: icon, FilePlus2: icon, FileStack: icon, FileText: icon, FlaskConical: icon, LayoutTemplate: icon, Shapes: icon }));

process.env.STUDIO_ASSETS_ROOT ??= path.join(STUDIO, "assets");
if (!process.env.STUDIO_WORKSPACE_ROOT) {
  const ws = path.join(process.env.TMPDIR ?? "/private/tmp/claude-501/row122/tmp", "row122-ws");
  mkdirSync(ws, { recursive: true });
  process.env.STUDIO_WORKSPACE_ROOT = ws;
}

const { Register, normalizeRegisterEntry } = await import("../../../vendor/src/lib/studio/engine/bind");
const { normalizeDocument } = await import("../../../vendor/src/lib/studio/services/ingest/normalize");
const { resolveRepoAssetPath, scanCanonicalAssets } = await import("../../../vendor/src/lib/studio/services/templates/assets");
const { DATUM_CANONICAL_SLUG, resolveProfileInMemory } = await import("../../../vendor/src/lib/studio/services/templates/profile");
export const assemble = await import("../../../vendor/src/lib/studio/engine/docx/assemble");

export function loadFixture(name = "terbit_rev_a"): StudioDocV1 {
  return JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as StudioDocV1;
}

export async function canonicalTemplate(overrides: Record<string, unknown> = {}): Promise<ResolvedTemplate> {
  const ca = await scanCanonicalAssets(VENDOR);
  return resolveProfileInMemory(
    { base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: "DOCUMENT", overrides } as never,
    { canonicalAssets: ca, resolveAssetPath: (rel: string) => resolveRepoAssetPath(rel, VENDOR) },
  );
}

export function snapshotOf(doc: StudioDocV1): NormDocSnapshot {
  const r = normalizeDocument(doc);
  if (r.issues.length > 0) throw new Error(`fixture not normalised: ${JSON.stringify(r.issues.slice(0, 3))}`);
  const snap = r.snapshot as NormDocSnapshot;
  for (const [k, e] of Object.entries(snap.register ?? {})) snap.register[k] = normalizeRegisterEntry(k, e);
  return snap;
}

export function makeCtx(snap: NormDocSnapshot, tpl: ResolvedTemplate): { ctx: RenderContext; logs: RenderLogEntry[] } {
  const logs: RenderLogEntry[] = [];
  const ctx: RenderContext = {
    snapshot: snap,
    tpl,
    register: new Register(snap.register ?? {}),
    fixedDate: snap.doc.meta.issueDate,
    figures: { get: () => undefined },
    log: (e) => logs.push(e),
  };
  return { ctx, logs };
}

export interface Rendered {
  bytes: Uint8Array;
  files: Record<string, Uint8Array>;
  doc: string;
  part(name: string): string;
  logs: RenderLogEntry[];
}

/** Render `doc` (bawaan fixture) with the canonical profile plus `overrides`. */
export async function renderDocx(doc: StudioDocV1 = loadFixture(), overrides: Record<string, unknown> = {}, mutate?: (tpl: ResolvedTemplate) => ResolvedTemplate): Promise<Rendered> {
  const base = await canonicalTemplate(overrides);
  const tpl = mutate ? mutate(base) : base;
  const { ctx, logs } = makeCtx(snapshotOf(doc), tpl);
  const { bytes } = await assemble.assembleDocx(ctx);
  const files = unzipSync(bytes);
  const dec = new TextDecoder();
  const part = (name: string) => (files[name] ? dec.decode(files[name]) : "");
  return { bytes, files, doc: part("word/document.xml"), part, logs };
}

// ── XML helpers (plain regex over WordprocessingML; no production code) ───

export const textOf = (xml: string): string => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

/** Top-level body children (paragraphs and tables) in order. */
export function bodyBlocks(docXml: string): string[] {
  const body = docXml.slice(docXml.indexOf("<w:body>") + 8, docXml.lastIndexOf("</w:body>"));
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("<w:p/>", i)) {
      out.push("<w:p/>");
      i += 6;
      continue;
    }
    const m = /^<(w:p|w:tbl|w:sectPr|w:bookmarkStart|w:bookmarkEnd)[\s>/]/.exec(body.slice(i, i + 20));
    if (!m) {
      i++;
      continue;
    }
    const tag = m[1];
    const selfClose = body.indexOf("/>", i);
    const gt = body.indexOf(">", i);
    if (selfClose >= 0 && selfClose < gt + 1 && selfClose === gt - 1) {
      out.push(body.slice(i, gt + 1));
      i = gt + 1;
      continue;
    }
    // nesting-aware end for w:p / w:tbl
    let depth = 0;
    let j = i;
    const open = new RegExp(`<${tag}[\\s>]`, "g");
    const close = `</${tag}>`;
    for (;;) {
      open.lastIndex = j;
      const o = open.exec(body);
      const c = body.indexOf(close, j);
      if (c < 0) throw new Error(`unterminated ${tag}`);
      if (o && o.index < c) {
        depth++;
        j = o.index + 1;
      } else {
        depth--;
        j = c + close.length;
        if (depth === 0) break;
      }
    }
    out.push(body.slice(i, j));
    i = j;
  }
  return out;
}

export function paragraphs(xml: string): string[] {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
}

export function runs(pXml: string): Array<{ rPr: string; text: string }> {
  return [...pXml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => ({ rPr: /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(m[1])?.[1] ?? "", text: textOf(m[1]) }));
}
