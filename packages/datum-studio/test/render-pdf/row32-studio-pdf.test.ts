// Row 32 (studio spec §4, D-15 reversed): Studio prints its PDF from its own HTML through the render
// bridge `pdf` op. No soffice anywhere on the render path.
//
// What runs for real: the vendored Studio (submit pipeline over a temp DATUM Studio store, builtin
// template datum-gsp, renderSnapshot, assembleHtml, services/render/pdf.ts), the row 108 bridge client
// (engine/browser/runtime.ts socketTransport over a Unix socket with the token), and the row 24 bridge
// itself (desktop/src/main/datum-render: startRenderBridge -> socket server, token check, request
// validation, path policy, font block, dispatch, atomic output write).
// What is faked: only the row 24 PageEngine seam (`engine` option of startRenderBridge, the same seam
// bridge.test.ts uses), because Electron cannot run under bun. The fake answers like Chromium's
// Page.printToPDF with preferCSSPageSize for Studio's page markup whose units each fit on one page:
//   - one page per sheet `<section class="page ...">` (engine/html/base/css.ts:234-236
//     `.page{height:var(--page-h);overflow:hidden;break-after:page;page:st-sheet}`);
//   - one page per flow unit `<section class="st-unit ...">`, each unit after the first starting a
//     new page (css.ts:241 `.st-unit + .st-unit{break-before:page}`; `.st-flow` units do not break);
// at the requested paper size, as a real, parseable PDF (catalog, page tree, xref). It does not
// paginate long content (that needs layout): the samples keep every unit far below one page body.
// A real Electron print (true pagination) is carried to rows 42/43.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth";
import type { AnyNormSnapshot, StudioDocV2 } from "../../vendor/src/lib/studio/contract";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const STUDIO = path.join(VENDOR, "src", "lib", "studio");
const DESKTOP = path.resolve(PKG, "..", "desktop");
const BRIDGE_DIR = path.join(DESKTOP, "src", "main", "datum-render");
const FONTS = path.join(DESKTOP, "datum", "datum-house-style", "assets", "fonts");
const base = process.env.ROW32_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row32-")));
const ROOT = path.join(WORK, "datum-studio");

process.env.STUDIO_WORKSPACE_ROOT = ROOT;
process.env.STUDIO_ASSETS_ROOT = path.join(STUDIO, "assets");
delete process.env.DATUM_RENDER_SOCKET;
delete process.env.DATUM_RENDER_TOKEN;

const caller: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row32-test", agentId: "row32-test", canWriteClassK: false };

// ── row 24 bridge, loaded by path (desktop code; not part of this package's type graph) ──────────

type EngineInfo = Record<string, unknown>;
type PageEngine = {
  png(job: { html: string; width: number; height: number }): Promise<Buffer>;
  pdf(job: { html: string; widthMm: number; heightMm: number; preferCSSPageSize: boolean }): Promise<Buffer>;
  evaluate(job: { html: string; viewportWidth: number; viewportHeight: number; expression: string }): Promise<unknown>;
  info(): EngineInfo;
};
type RenderBridge = { env: { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string }; close(): Promise<void>; scripts: string[] };
type BridgeModule = {
  startRenderBridge(o: { fontsDir: string; extraScripts?: Record<string, string>; log: (...a: unknown[]) => void; engine: PageEngine; baseDir?: string }): Promise<RenderBridge>;
};
type PagesModule = { htmlWithFonts(html: string, fontCss: string): string; renderWebPreferences(kind: "raster" | "check"): Record<string, unknown> };
type FontsModule = { buildFontBundle(dir: string): { css: string } };

const bridgeIndex = path.join(BRIDGE_DIR, "index.ts");
const bridgePages = path.join(BRIDGE_DIR, "pages.ts");
const bridgeFonts = path.join(BRIDGE_DIR, "fonts.ts");

/** Minimal, valid PDF 1.7 with `n` empty pages of w x h mm (catalog, page tree, pages, xref, trailer). */
function realPdf(n: number, wMm: number, hMm: number): Buffer {
  const w = ((wMm * 72) / 25.4).toFixed(2);
  const h = ((hMm * 72) / 25.4).toFixed(2);
  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> >>`);
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Page count read from the PDF by this test (independent of services/render/pdf.ts): page objects + xref check. */
function pdfPagesOf(pdf: Buffer): { pages: number; mediaBoxes: string[]; xrefOk: boolean } {
  const s = pdf.toString("latin1");
  const mediaBoxes = [...s.matchAll(/\/Type \/Page \/Parent \d+ 0 R \/MediaBox \[([^\]]+)\]/g)].map((m) => m[1]);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)?.[1] ?? -1);
  return { pages: mediaBoxes.length, mediaBoxes, xrefOk: startxref > 0 && s.startsWith("xref\n", startxref) };
}

/** Pages Chromium prints for Studio page markup with one-page units (see header). */
function sheetsOf(html: string): number {
  const sheets = (html.match(/<section class="page[" ]/g) ?? []).length;
  const units = [...html.matchAll(/<section class="(st-unit[^"]*)"/g)].filter((m) => !/\bst-flow\b/.test(m[1])).length;
  return sheets + units;
}

type PdfJob = { html: string; widthMm: number; heightMm: number; preferCSSPageSize: boolean };
const pdfJobs: PdfJob[] = [];
const bridgeLog: unknown[][] = [];
let info: EngineInfo = {};
const fakeEngine: PageEngine = {
  async png() {
    throw new Error("png not expected in this test (no figures in the sample sheet)");
  },
  async pdf(job) {
    pdfJobs.push(job);
    return realPdf(Math.max(1, sheetsOf(job.html)), job.widthMm, job.heightMm);
  },
  async evaluate() {
    throw new Error("checkPage not expected (measureLayout off)");
  },
  info: () => info,
};

let bridge: RenderBridge;
let pages: PagesModule;
let fontCss = "";
let store: SqliteStudioStore;
let templates: typeof import("../../vendor/src/lib/studio/services/templates");
let submit: typeof import("../../vendor/src/lib/studio/services/submit");
let pure: typeof import("../../vendor/src/lib/studio/services/render/pure");
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime");
let snapshot: AnyNormSnapshot;

async function snapshotOf(doc: StudioDocV2): Promise<AnyNormSnapshot> {
  const r = await submit.submitDocumentV2(caller, doc);
  const rev = await store.getRevision(r.document.id, 1);
  return rev!.revision.snapshot as unknown as AnyNormSnapshot;
}

function sampleSheet(chapters = 1): StudioDocV2 {
  return {
    $schema: "studio.doc/v2",
    template: { slug: "datum-gsp" },
    meta: { title: "Lembar uji cetak PDF", typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 32", issueDate: "2026-11-07", rev: "A" },
    mission: { folder: `2026-11-07_row32-pdf-${chapters}` },
    sections: {
      content: {
        type: "chapter",
        chapters: Array.from({ length: chapters }, (_, i) => ({
          key: String(i + 1),
          title: { text: i === 0 ? "Ringkasan" : `Bab uji ${i + 1}` },
          sections: [
            {
              title: { text: "Cetak PDF dari HTML" },
              blocks: [
                { type: "paragraph", text: "Lembar ini dicetak dari HTML Studio sendiri lewat op pdf render bridge." },
                { type: "paragraph", text: "Tidak ada LibreOffice dalam jalur render." },
              ],
            },
          ],
        })),
      },
    },
  } as unknown as StudioDocV2;
}

function lockedInfo(): EngineInfo {
  const raster = pages.renderWebPreferences("raster");
  return {
    electron: "fake-row32",
    chrome: "fake-row32",
    partition: "datum-render",
    sandbox: raster.sandbox,
    contextIsolation: raster.contextIsolation,
    nodeIntegration: raster.nodeIntegration,
    javascriptContent: raster.javascript,
    network: "blocked",
  };
}

beforeAll(async () => {
  const bridgeMod = (await import(bridgeIndex)) as BridgeModule;
  pages = (await import(bridgePages)) as PagesModule;
  fontCss = ((await import(bridgeFonts)) as FontsModule).buildFontBundle(FONTS).css;
  info = lockedInfo();
  bridge = await bridgeMod.startRenderBridge({ fontsDir: FONTS, log: (...a) => bridgeLog.push(a), engine: fakeEngine, baseDir: WORK });
  // The real transport: the Studio twin reads these two variables (runtime.ts socketTransport).
  process.env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET;
  process.env.DATUM_RENDER_TOKEN = bridge.env.DATUM_RENDER_TOKEN;

  store = await openHostStore(ROOT, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") });
  templates = await import("../../vendor/src/lib/studio/services/templates");
  templates.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: "1.2.0" });
  submit = await import("../../vendor/src/lib/studio/services/submit");
  pure = await import("../../vendor/src/lib/studio/services/render/pure");
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime");

  snapshot = await snapshotOf(sampleSheet());
});

afterAll(async () => {
  templates?.configureTemplateSource(null);
  if (store) await closeHostStore(store);
  if (bridge) await bridge.close();
  rmSync(WORK, { recursive: true, force: true });
  // T-2 (C71): do not leave this suite's (now removed) root cached for the next suite.
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env");
  resetStudioEnvCache();
});

describe("row 32: Studio PDF from its own HTML through the bridge pdf op", () => {
  test("one sample sheet: PDF + HTML, the PDF has the expected page count", async () => {
    const tpl = await templates.resolveTemplate("datum-gsp");
    pdfJobs.length = 0;
    const res = await pure.renderSnapshot(snapshot, tpl, { formats: ["PDF", "HTML"], measureLayout: false });

    expect(res.errors).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.status).toBe("SUCCEEDED");
    const pdfFile = res.files.find((f) => f.format === "PDF");
    const htmlFile = res.files.find((f) => f.format === "HTML");
    expect(pdfFile?.fileName).toMatch(/\.pdf$/);
    expect(htmlFile).toBeDefined();
    const html = String(htmlFile!.data);

    // Exactly one bridge pdf job, and what it printed is Studio's HTML plus only the bridge font block.
    expect(pdfJobs.length).toBe(1);
    const job = pdfJobs[0];
    expect(job.preferCSSPageSize).toBe(true);
    expect(job.html).toBe(pages.htmlWithFonts(html, fontCss));
    expect([job.widthMm, job.heightMm]).toEqual([210, 297]);

    // Page count: Studio's HTML sheets = pages read from the PDF = pages reported by pdf.ts = pinned.
    const expectedPages = sheetsOf(html);
    const pdf = Buffer.from(pdfFile!.data as Uint8Array);
    const read = pdfPagesOf(pdf);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(read.xrefOk).toBe(true);
    expect(read.pages).toBe(expectedPages);
    expect(read.mediaBoxes.every((b) => b === "0 0 595.28 841.89")).toBe(true);
    const printed = res.log.entries.find((e) => e.code === "PDF_PRINTED");
    expect((printed?.context as { pages?: number } | undefined)?.pages).toBe(expectedPages);
    expect(expectedPages).toBe(1);
    console.log(`row32: sample sheet pages=${expectedPages} pdfBytes=${pdf.length} htmlChars=${html.length} bridgeEngine=${JSON.stringify(res.engine)}`);

    // The bridge removed nothing it should keep and Studio's work folder is gone.
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("datum-studio-render-"))).toEqual([]);
  });

  test("PDF alone still assembles the HTML and prints it; no DOCX is built", async () => {
    const tpl = await templates.resolveTemplate("datum-gsp");
    pdfJobs.length = 0;
    const res = await pure.renderSnapshot(snapshot, tpl, { formats: ["PDF"], measureLayout: false });
    expect(res.status).toBe("SUCCEEDED");
    expect(res.files.map((f) => f.format)).toEqual(["PDF"]);
    expect(pdfJobs.length).toBe(1);
    expect(res.log.entries.some((e) => e.code === "DOCX_ASSEMBLED")).toBe(false);
    expect(pdfPagesOf(Buffer.from(res.files[0].data as Uint8Array)).pages).toBe(1);
  });

  test("three chapters: three pages (the count follows Studio's HTML, it is not fixed)", async () => {
    const tpl = await templates.resolveTemplate("datum-gsp");
    pdfJobs.length = 0;
    const res = await pure.renderSnapshot(await snapshotOf(sampleSheet(3)), tpl, { formats: ["PDF", "HTML"], measureLayout: false });
    expect(res.status).toBe("SUCCEEDED");
    const html = String(res.files.find((f) => f.format === "HTML")!.data);
    expect(sheetsOf(html)).toBe(3);
    const pdf = Buffer.from(res.files.find((f) => f.format === "PDF")!.data as Uint8Array);
    expect(pdfPagesOf(pdf).pages).toBe(3);
    expect(pdfJobs.length).toBe(1);
    expect(pdfJobs[0].html).toBe(pages.htmlWithFonts(html, fontCss));
  });

  test("bridge not locked down: PDF fails PDF_ENGINE_UNAVAILABLE, HTML still delivered", async () => {
    const tpl = await templates.resolveTemplate("datum-gsp");
    info = { ...lockedInfo(), sandbox: false };
    runtime.setRenderBridgeTransport(null); // drop the cached handshake
    pdfJobs.length = 0;
    try {
      const res = await pure.renderSnapshot(snapshot, tpl, { formats: ["PDF", "HTML"], measureLayout: false });
      expect(res.failed).toEqual(["PDF"]);
      expect(res.status).toBe("PARTIAL");
      expect(res.errors.map((e) => e.code)).toEqual(["PDF_ENGINE_UNAVAILABLE"]);
      expect(res.files.map((f) => f.format)).toEqual(["HTML"]);
      expect(pdfJobs.length).toBe(0);
    } finally {
      info = lockedInfo();
      runtime.setRenderBridgeTransport(null);
    }
  });

  test("bridge absent: PDF fails PDF_ENGINE_UNAVAILABLE without any process launch", async () => {
    const tpl = await templates.resolveTemplate("datum-gsp");
    const saved = process.env.DATUM_RENDER_SOCKET;
    delete process.env.DATUM_RENDER_SOCKET;
    runtime.setRenderBridgeTransport(null);
    try {
      const res = await pure.renderSnapshot(snapshot, tpl, { formats: ["PDF"], measureLayout: false });
      expect(res.status).toBe("FAILED");
      expect(res.errors.map((e) => e.code)).toEqual(["PDF_ENGINE_UNAVAILABLE"]);
      expect(res.files).toEqual([]);
    } finally {
      process.env.DATUM_RENDER_SOCKET = saved;
      runtime.setRenderBridgeTransport(null);
    }
  });

  test("a caller readiness gate that is not ready refuses the PDF before the bridge is asked", async () => {
    const tpl = await templates.resolveTemplate("datum-gsp");
    pdfJobs.length = 0;
    const notReady = { ready: false, checkedAt: new Date().toISOString(), manifestSha256: "ab".repeat(32), soffice: { found: false, version: null, versionOk: false }, chromium: { found: false }, fonts: [], errors: ["render bridge not ready"] };
    const res = await pure.renderSnapshot(snapshot, tpl, { formats: ["PDF", "HTML"], measureLayout: false, readiness: notReady });
    expect(res.failed).toEqual(["PDF"]);
    expect(res.errors.map((e) => e.code)).toEqual(["PDF_ENGINE_UNAVAILABLE"]);
    expect(res.engine.renderEnvManifestSha256).toBe("ab".repeat(32));
    expect(pdfJobs.length).toBe(0);
  });

  test("no soffice reference left in the render path (render.ts, pdf.ts)", () => {
    for (const f of ["services/render/pure/render.ts", "services/render/pdf.ts"]) {
      const hits = readFileSync(path.join(STUDIO, f), "utf8")
        .split("\n")
        .map((l, i) => `${f}:${i + 1}: ${l}`)
        .filter((l) => /soffice|convertDocxToPdf/i.test(l));
      expect(hits).toEqual([]);
    }
  });
});
