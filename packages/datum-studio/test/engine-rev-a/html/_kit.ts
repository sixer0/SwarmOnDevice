// Row 123 test kit: render a v1 fixture to HTML through the vendored engine (normalizeDocument ->
// assembleHtml) with the canonical profile resolved in memory. Pure local: no DB, no network, no browser
// (the figure comes from a stub FigureStore), no model calls. Same seams as the row 122 DOCX kit.
import { mock } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NormDocSnapshot, RenderContext, RenderLogEntry, ResolvedTemplate, StudioDocV1 } from "../../../vendor/src/lib/studio/contract";

export const PKG = path.resolve(import.meta.dir, "..", "..", "..");
export const VENDOR = path.join(PKG, "vendor");
export const STUDIO = path.join(VENDOR, "src", "lib", "studio");

// contract/ui.ts imports lucide-react (not installed here); same stub as test/engine-twins and the row 122 kit.
const icon = () => null;
mock.module("lucide-react", () => ({ Activity: icon, FilePlus2: icon, FileStack: icon, FileText: icon, FlaskConical: icon, LayoutTemplate: icon, Shapes: icon }));

process.env.STUDIO_ASSETS_ROOT ??= path.join(STUDIO, "assets");
if (!process.env.STUDIO_WORKSPACE_ROOT) {
  const ws = path.join(process.env.TMPDIR ?? "/private/tmp/claude-501/row123/tmp", "row123-ws");
  mkdirSync(ws, { recursive: true });
  process.env.STUDIO_WORKSPACE_ROOT = ws;
}

const { Register, normalizeRegisterEntry } = await import("../../../vendor/src/lib/studio/engine/bind");
const { normalizeDocument } = await import("../../../vendor/src/lib/studio/services/ingest/normalize");
const { resolveRepoAssetPath, scanCanonicalAssets } = await import("../../../vendor/src/lib/studio/services/templates/assets");
const { DATUM_CANONICAL_SLUG, resolveProfileInMemory } = await import("../../../vendor/src/lib/studio/services/templates/profile");
export const assemble = await import("../../../vendor/src/lib/studio/engine/html/assemble");

export function loadFixture(name = "terbit_rev_a_html"): StudioDocV1 {
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

/**
 * Stub figure: an inline SVG in the form the diagram engine emits (font-family attribute naming one Plex face,
 * mark glyphs as real text), 128 mm wide. Only the HTML engine is under test here, not the diagram engine.
 */
export const FIGURE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="40mm" viewBox="0 0 128 40">' +
  '<rect x="2" y="2" width="40" height="12" fill="none" stroke="#101418" stroke-width="0.45"/>' +
  '<text x="4" y="9" font-family="IBM Plex Sans Condensed" font-size="2.68">Sensor R1-R2</text>' +
  '<text x="40" y="9" font-family="IBM Plex Mono" font-size="2.19" text-anchor="end" fill="#B45309">■</text>' +
  '<text x="80" y="9" font-family="IBM Plex Mono" font-size="2.19" text-anchor="end" fill="#B45309">◈ ◇ △</text>' +
  "</svg>";

export function makeCtx(snap: NormDocSnapshot, tpl: ResolvedTemplate): { ctx: RenderContext; logs: RenderLogEntry[] } {
  const logs: RenderLogEntry[] = [];
  const ctx: RenderContext = {
    snapshot: snap,
    tpl,
    register: new Register(snap.register ?? {}),
    fixedDate: snap.doc.meta.issueDate,
    figures: { get: (k: string) => (k === "fig-arsitektur" ? { svg: FIGURE_SVG, widthMm: 128, heightMm: 40 } : undefined) },
    log: (e) => logs.push(e),
  };
  return { ctx, logs };
}

export interface RenderedHtml {
  html: string;
  logs: RenderLogEntry[];
  /** Body markup of one wrapper/flow unit by its data-unit kind (first match). */
  unit(kind: string): string;
  units(kind: string): string[];
}

/** Render `doc` (default fixture) to the release HTML artefact with the canonical profile plus `overrides`. */
export async function renderHtml(doc: StudioDocV1 = loadFixture(), overrides: Record<string, unknown> = {}, mutate?: (tpl: ResolvedTemplate) => ResolvedTemplate): Promise<RenderedHtml> {
  const base = await canonicalTemplate(overrides);
  const tpl = mutate ? mutate(base) : base;
  const { ctx, logs } = makeCtx(snapshotOf(doc), tpl);
  const html = await assemble.assembleHtml(ctx, { preview: false });
  const units = (kind: string) => {
    const out: string[] = [];
    const re = new RegExp(`<section\\b[^>]*\\bdata-unit="${kind}"[^>]*>`, "g");
    for (const m of html.matchAll(re)) {
      const start = m.index;
      const next = html.indexOf("<section class=\"st-unit", start + m[0].length);
      const end = next >= 0 ? next : html.indexOf("</body>", start);
      out.push(html.slice(start, end));
    }
    return out;
  };
  return { html, logs, unit: (k) => units(k)[0] ?? "", units };
}

/** Visible text of an HTML fragment (tags dropped, entities for the few the engine writes decoded). */
export const textOf = (h: string): string =>
  h
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** CSS text of every <style> element. */
export const cssOf = (html: string): string => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
