// Row 108: engine twins of studio spec §1.3 (browser/runtime.ts over the render bridge, soffice/index.ts
// readiness via the bridge, relabel.ts without relabelled faces) and the C31 font resolution.
// Every bridge call goes to a fake bridge; nothing launches a browser or a process.
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BridgeRequest, BridgeTransport } from "../../vendor/src/lib/studio/engine/browser/runtime";

const PKG = path.resolve(import.meta.dir, "..", "..");
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio");
const ASSETS = path.join(STUDIO, "assets");
const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "row108-")));

// contract/ui.ts (row 29 twin pending) imports lucide-react, which is not installed here.
const icon = () => null;
mock.module("lucide-react", () => ({ Activity: icon, FilePlus2: icon, FileStack: icon, FileText: icon, FlaskConical: icon, LayoutTemplate: icon, Shapes: icon }));

process.env.STUDIO_ASSETS_ROOT = ASSETS;
process.env.STUDIO_WORKSPACE_ROOT = path.join(SCRATCH, "ws");
mkdirSync(process.env.STUDIO_WORKSPACE_ROOT, { recursive: true });
delete process.env.DATUM_RENDER_SOCKET;
delete process.env.DATUM_RENDER_TOKEN;

const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime");
const browser = await import("../../vendor/src/lib/studio/engine/browser/index");
const measure = await import("../../vendor/src/lib/studio/engine/browser/measure");
const soffice = await import("../../vendor/src/lib/studio/engine/soffice/index");
const relabel = await import("../../vendor/src/lib/studio/engine/docx/fonts/relabel");
const plan = await import("../../vendor/src/lib/studio/engine/docx/fonts/plan");
const catalog = await import("../../vendor/src/lib/studio/engine/docx/fonts/catalog");
const htmlFonts = await import("../../vendor/src/lib/studio/engine/html/base/fonts");

type Req = BridgeRequest;

// ── fake bridge ──────────────────────────────────────────────────────────

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Header-only PNG of the requested size (readPngSize/withPngDpi read IHDR and chunks only). */
function fakePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])), chunk("IEND", Buffer.alloc(0))]);
}

const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] };

type Seen = { req: Req; srcText?: string };
function fakeBridge(over: { info?: Record<string, unknown>; fail?: Partial<Record<string, { code: string; message: string }>>; result?: unknown } = {}) {
  const seen: Seen[] = [];
  const transport: BridgeTransport = async (req) => {
    const s: Seen = { req: { ...req } };
    seen.push(s);
    const f = over.fail?.[req.op];
    if (f) return { ok: false, code: f.code, message: f.message, error: f.message };
    if (req.op === "hello") return { ok: true, ...(over.info ?? GOOD_INFO) };
    if (req.op === "png") {
      s.srcText = readFileSync(String(req.src), "utf8");
      writeFileSync(String(req.dst), fakePng(Number(req.width), Number(req.height)));
      return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height };
    }
    if (req.op === "pdf") {
      s.srcText = readFileSync(String(req.src), "utf8");
      writeFileSync(String(req.dst), Buffer.from("%PDF-1.4\n1 0 obj<</Type /Pages /Count 3>>endobj\n%%EOF\n", "latin1"));
      return { ok: true, electron: "42.3.3", dst: req.dst };
    }
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: over.result };
    return { ok: false, code: "UNKNOWN_OP", message: "?" };
  };
  runtime.setRenderBridgeTransport(transport);
  soffice.resetReadinessCache();
  return seen;
}

afterEach(() => {
  runtime.setRenderBridgeTransport(null);
  soffice.resetReadinessCache();
});

async function errOf(p: Promise<unknown>): Promise<{ code?: string; reason?: string; message: string }> {
  try {
    await p;
    return { message: "no-throw" };
  } catch (e) {
    const x = e as { code?: string; reason?: string; message: string };
    return { code: x.code, reason: x.reason, message: x.message };
  }
}

const SVG_128 =
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="60mm" viewBox="0 0 128 60">` +
  `<rect width="128" height="60" fill="#fff"/><text x="4" y="20" font-family="IBM Plex Sans" font-size="6">Gambar 1</text></svg>`;

// ── no Chromium of Studio's own ──────────────────────────────────────────

describe("browser twin: no playwright, no own Chromium", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|mts|tsx)$/.test(n) ? [p] : [];
    });
  test("no playwright-core import anywhere in the vendored code", () => {
    const hits = files(path.join(PKG, "vendor")).filter((f) => /(from\s+["']playwright(-core)?["'])|(import\(\s*["']playwright(-core)?["']\s*\))|(require\(\s*["']playwright)/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
  test("engine/browser and engine/soffice import no process or browser launcher", () => {
    const dirs = [path.join(STUDIO, "engine", "browser"), path.join(STUDIO, "engine", "soffice")];
    const bad = dirs.flatMap(files).filter((f) => /["'](node:)?child_process["']|chromium\.launch\(|launchPersistentContext/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

// ── rasterisation through the bridge ─────────────────────────────────────

describe("rasterizeSvg goes through the bridge png op", () => {
  test("SVG -> png op with Studio's font faces inside the SVG; 300 dpi pHYs; only hello + png sent", async () => {
    const seen = fakeBridge();
    const png = await browser.rasterizeSvg(SVG_128, { widthMm: 128, heightMm: 60, dpi: 300 });
    const ops = seen.map((s) => s.req.op);
    expect(ops[0]).toBe("hello");
    expect(ops.slice(1).every((o) => o === "png")).toBe(true);
    expect(ops.length).toBeGreaterThanOrEqual(3); // two equal captures settle the raster (D-259)
    const p = seen[1];
    expect(String(p.req.src)).toEndWith(".svg");
    expect(String(p.req.dst)).toEndWith(".png");
    expect(p.req.width).toBe(1512); // 128 mm at 300 dpi = 1512 px (CP-47, row 122)
    expect(p.req.height).toBe(709);
    expect(p.srcText).toStartWith("<svg");
    expect(p.srcText).toContain('<style data-studio-fonts="">@font-face{font-family:"IBM Plex Sans"');
    expect(p.req).not.toHaveProperty("token"); // the transport adds the token, callers never see it
    const size = browser.readPngSize(png)!;
    expect(size).toEqual({ widthPx: 1512, heightPx: 709 });
    expect(Buffer.from(png).includes(Buffer.from("pHYs", "latin1"))).toBe(true);
    // work folder removed after the op
    expect(existsSync(path.dirname(String(p.req.src)))).toBe(false);
  });

  test("handshake reporting sandbox:false -> BROWSER_UNAVAILABLE (SANDBOX_UNAVAILABLE), nothing rendered", async () => {
    const seen = fakeBridge({ info: { ...GOOD_INFO, sandbox: false } });
    const e = await errOf(browser.rasterizeSvg(SVG_128, { widthMm: 128, heightMm: 60, dpi: 300 }));
    expect(e.code).toBe("BROWSER_UNAVAILABLE");
    expect(e.reason).toBe("SANDBOX_UNAVAILABLE");
    expect(seen.map((s) => s.req.op)).toEqual(["hello"]);
  });

  test("contextIsolation false or Node in the render window also refuses", () => {
    expect(runtime.judgeBridgeInfo({ ...GOOD_INFO, contextIsolation: false })).toContain("contextIsolation=false");
    expect(runtime.judgeBridgeInfo({ ...GOOD_INFO, nodeIntegration: true })).toContain("nodeIntegration=true");
    expect(runtime.judgeBridgeInfo({ ...GOOD_INFO, network: "open" })).toContain("network=open");
    expect(runtime.judgeBridgeInfo(GOOD_INFO)).toBeNull();
  });

  test("no bridge configured (Swarm closed) -> BROWSER_UNAVAILABLE (LAUNCH_FAILED), clear message", async () => {
    runtime.setRenderBridgeTransport(null);
    const e = await errOf(browser.rasterizeSvg(SVG_128, { widthMm: 128, heightMm: 60, dpi: 300 }));
    expect(e.code).toBe("BROWSER_UNAVAILABLE");
    expect(e.reason).toBe("LAUNCH_FAILED");
    expect(e.message).toContain("Swarm app running");
  });

  test("bridge error codes map to Studio codes", async () => {
    fakeBridge({ fail: { png: { code: "SVG_INVALID", message: "bad svg" } } });
    expect((await errOf(browser.rasterizeSvg(SVG_128, { widthMm: 128, heightMm: 60, dpi: 300 }))).code).toBe("BY_CONSTRUCTION_FAILED");
    fakeBridge({ fail: { png: { code: "RENDER_TIMEOUT", message: "slow" } } });
    expect((await errOf(browser.rasterizeSvg(SVG_128, { widthMm: 128, heightMm: 60, dpi: 300 }))).code).toBe("RENDER_TIMEOUT");
    fakeBridge({ fail: { png: { code: "RENDER_FAILED", message: "x" } } });
    expect((await errOf(browser.rasterizeSvg(SVG_128, { widthMm: 128, heightMm: 60, dpi: 300 }))).code).toBe("BROWSER_UNAVAILABLE");
  });

  test("getBrowser reports the bridge (Electron/Chromium versions)", async () => {
    fakeBridge();
    const h = await browser.getBrowser();
    expect(h.version).toBe("Electron 42.3.3 (Chromium 142.0.0.0) via render bridge");
  });
});

// ── layout measurement and PDF page count ────────────────────────────────

describe("measureLayout uses checkPage with Studio's MEASURE_SCRIPT", () => {
  test("paged HTML -> one checkPage op, script = MEASURE_SCRIPT, arg = measure args, viewport from the sheet", async () => {
    const seen = fakeBridge({ result: { paged: true, pageCount: 2, truncated: false, elements: [{ kind: "page" }] } });
    const r = await browser.measureLayout(`<html><body><div class="page">a</div><div class="page">b</div></body></html>`);
    expect(r.pageCount).toBe(2);
    expect(r.pageCountSource).toBe("elements");
    const cp = seen.find((s) => s.req.op === "checkPage")!;
    expect(cp.req.script).toBe(measure.MEASURE_SCRIPT);
    expect(cp.req.arg).toEqual({ pageWidthMm: 210, pageHeightMm: 297, maxElements: 20000 });
    expect(cp.req.viewportWidth).toBe(794);
    expect(cp.req.viewportHeight).toBe(1123);
    expect(seen.map((s) => s.req.op)).toEqual(["hello", "checkPage"]);
  });
  test("flowing HTML -> page count from a bridge pdf of the same HTML", async () => {
    const seen = fakeBridge({ result: { paged: false, pageCount: 0, truncated: false, elements: [] } });
    const r = await browser.measureLayout(`<html><body><p>alir</p></body></html>`);
    expect(r.pageCountSource).toBe("print");
    expect(r.pageCount).toBe(3);
    const pdf = seen.find((s) => s.req.op === "pdf")!;
    expect(String(pdf.req.src)).toEndWith(".html");
    expect(pdf.req.preferCSSPageSize).toBe(true);
    expect(pdf.req.widthMm).toBe(210);
    expect(pdf.srcText).toContain("<p>alir</p>");
  });
  test("the script Studio sends is the one the host registers in the bridge allow-list", () => {
    expect(runtime.STUDIO_BRIDGE_SCRIPTS.map((s) => s.text)).toEqual([measure.MEASURE_SCRIPT]);
  });
  test("previewHtml (HTML screenshots) is refused, not faked", async () => {
    fakeBridge();
    expect((await errOf(browser.previewHtml(`<html><body><div class="page">x</div></body></html>`))).code).toBe("BROWSER_UNAVAILABLE");
  });
});

// ── soffice twin: readiness reports the bridge ───────────────────────────

describe("soffice twin: PDF readiness via the bridge", () => {
  test("ready: bridge handshake ok + 16 standard Plex files with matching sha256; no soffice", async () => {
    fakeBridge();
    const r = await soffice.checkRenderEnvReadiness({ force: true });
    expect(r.errors).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.bridge).toEqual({ reachable: true, electron: "42.3.3", chrome: "142.0.0.0", sandbox: true });
    expect(r.chromium.found).toBe(true);
    expect(r.soffice).toEqual({ found: false, version: null, versionOk: false });
    expect(r.fonts.length).toBe(16);
    expect(r.fonts.every((f) => f.fileExists && f.sha256Ok && f.registered)).toBe(true);
  });
  test("not ready when the bridge reports sandbox:false or is absent", async () => {
    fakeBridge({ info: { ...GOOD_INFO, sandbox: false } });
    const r = await soffice.checkRenderEnvReadiness({ force: true });
    expect(r.ready).toBe(false);
    expect(r.bridge.reachable).toBe(false);
    expect(r.errors.join(" ")).toContain("render bridge not ready");
    runtime.setRenderBridgeTransport(null);
    soffice.resetReadinessCache();
    const r2 = await soffice.checkRenderEnvReadiness();
    expect(r2.ready).toBe(false);
  });
  test("convertDocxToPdf refuses (no LibreOffice)", async () => {
    expect((await errOf(soffice.convertDocxToPdf(new Uint8Array(1), { jobId: "j", fileName: "f" }))).code).toBe("PDF_ENGINE_UNAVAILABLE");
  });
});

// ── C31: fonts resolve to the standard OFL files only ────────────────────

describe("relabel twin + C31: no renamed faces, standard OFL Plex files only", () => {
  const STD = /^fonts\/IBMPlex(Serif|Sans|SansCond|Mono)-(Regular|Italic|SemiBold|SemiBoldItalic)\.ttf$/;
  const manifest = JSON.parse(readFileSync(path.join(ASSETS, "manifest.json"), "utf8")) as { entries: Array<{ path: string; sha256: string }> };
  const shaOf = new Map(manifest.entries.map((e) => [e.path, e.sha256]));

  test("relabel tables are empty and the relabel sources refuse", () => {
    expect(relabel.RELABEL_FACES).toEqual([]);
    expect(relabel.RELABEL_ALIAS_FACES).toEqual([]);
    expect(relabel.findRelabelFace("IBM Plex Serif", "bold")).toBeUndefined();
    expect(relabel.findRelabelAlias("IBM Plex Sans Condensed", "bold")).toBeUndefined();
  });

  test("asset manifest and font folder carry no renamed face", () => {
    expect(readFileSync(path.join(ASSETS, "manifest.json"), "utf8")).not.toContain("renamed");
    expect(existsSync(path.join(ASSETS, "fonts", "renamed"))).toBe(false);
    expect(manifest.entries.filter((e) => STD.test(e.path)).length).toBe(16);
  });

  test("DOCX embed plan (datum-gsp preset families): bold -> standard SemiBold, Sans Cond -> standard files", () => {
    const preset = JSON.parse(readFileSync(path.join(PKG, "templates", "datum-gsp-preset.json"), "utf8"));
    const params = preset.advanced;
    const embed = params["render.docx.embedFonts"];
    expect(Array.isArray(embed)).toBe(true);
    const tpl = { templateId: "t", versionId: "v", versionNo: 0, params: { "render.docx.embedFonts": embed }, roleFormats: {}, sectionPlan: {}, assets: {} } as never;
    const fams = (embed as Array<{ family: string }>).map((e) => e.family);
    const d = plan.planEmbeddedFontsDetailed(tpl, new Set(fams));
    expect(d.faces.length).toBeGreaterThan(0);
    for (const f of d.faces) {
      expect(f.key).not.toContain("renamed");
      expect(f.key).toMatch(f.face === "DejaVu Sans" ? /^fonts\/DejaVuSans(-Bold)?\.ttf$/ : STD);
      expect(f.relabelled).toBeUndefined();
      expect(f.sha256).toBe(shaOf.get(f.key)!); // the bundled standard bytes, unmodified
    }
    for (const p of d.plan.fonts) expect(p.absPath).not.toContain("renamed");
    const by = (face: string, slot: string) => d.faces.find((f) => f.face === face && f.slot === slot)?.key;
    expect(by("IBM Plex Serif", "bold")).toBe("fonts/IBMPlexSerif-SemiBold.ttf");
    expect(by("IBM Plex Serif", "boldItalic")).toBe("fonts/IBMPlexSerif-SemiBoldItalic.ttf");
    expect(by("IBM Plex Sans Cond", "regular")).toBe("fonts/IBMPlexSansCond-Regular.ttf");
    expect(by("IBM Plex Sans Cond", "bold")).toBe("fonts/IBMPlexSansCond-SemiBold.ttf");
    expect(by("IBM Plex Sans Cond", "italic")).toBe("fonts/IBMPlexSansCond-Italic.ttf");
    expect(d.relabelFallbacks).toEqual([]);
  });

  test("the alias name 'IBM Plex Sans Condensed' also resolves to the standard files (no alias build)", () => {
    const tpl = { params: { "render.docx.embedFonts": [{ family: "IBM Plex Sans Condensed", boldFace: "semibold" }] }, assets: {} } as never;
    const d = plan.planEmbeddedFontsDetailed(tpl, new Set(["IBM Plex Sans Condensed"]));
    expect(d.faces.map((f) => f.key).sort()).toEqual([
      "fonts/IBMPlexSansCond-Italic.ttf",
      "fonts/IBMPlexSansCond-Regular.ttf",
      "fonts/IBMPlexSansCond-SemiBold.ttf",
      "fonts/IBMPlexSansCond-SemiBoldItalic.ttf",
    ]);
    expect(existsSync(relabel.relabelAliasCacheDir())).toBe(false);
    // registry default R-08 (params/render.ts:84) with the default `canonical` bold policy
    const canon = plan.planEmbeddedFontsDetailed({ params: {}, assets: {} } as never, new Set(["IBM Plex Sans Condensed"]), {
      families: [{ family: "IBM Plex Sans Condensed", slots: ["regular", "bold", "italic", "boldItalic"] }],
    });
    expect(canon.faces.map((f) => `${f.slot}=${f.key}`)).toEqual([
      "regular=fonts/IBMPlexSansCond-Regular.ttf",
      "bold=fonts/IBMPlexSansCond-SemiBold.ttf",
      "italic=fonts/IBMPlexSansCond-Italic.ttf",
      "boldItalic=fonts/IBMPlexSansCond-SemiBoldItalic.ttf",
    ]);
  });

  test("font catalog and HTML font files never include a renamed path", () => {
    const tpl = { params: {}, assets: {} } as never;
    expect(catalog.fontSourcesFromTemplate(tpl).some((s) => s.absPath.includes("renamed"))).toBe(false);
    expect(htmlFonts.fontFiles(tpl).some((f) => f.absPath.includes("renamed"))).toBe(false);
    const css = htmlFonts.fontFaceCssDetailed({ params: {}, assets: {} } as never, new Set(["IBM Plex Sans Cond", "IBM Plex Serif"]));
    expect(css.embedded.length).toBeGreaterThan(0);
    // every embedded face is a standard file: its base64 equals one of the 16 standard files
    const std = manifest.entries.filter((e) => STD.test(e.path)).map((e) => readFileSync(path.join(ASSETS, e.path)).toString("base64"));
    const used = [...css.css.matchAll(/base64,([A-Za-z0-9+/=]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBe(css.embedded.length);
    expect(used.every((b) => std.includes(b))).toBe(true);
  });
});

// ── the real socket transport against a fake bridge socket ───────────────

describe("socket transport (Unix socket, token per line)", () => {
  let canListen = true;
  beforeAll(async () => {
    const probe = path.join(SCRATCH, "p.sock");
    canListen = await new Promise<boolean>((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.listen(probe, () => s.close(() => res(true)));
    });
  });
  test("hello over the socket carries the token; reply parsed; wrong token refused", async () => {
    if (!canListen) {
      console.warn("row108: local socket listen not permitted here; socket transport test skipped");
      return;
    }
    const sockPath = path.join(SCRATCH, "render.sock");
    const token = createHash("sha256").update("row108").digest("hex");
    const got: Array<Record<string, unknown>> = [];
    const server = net.createServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        got.push(req);
        const reply = req.token === token ? { ok: true, ...GOOD_INFO } : { ok: false, code: "UNAUTHORIZED", message: "bad token", error: "bad token" };
        c.end(`${JSON.stringify(reply)}\n`);
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    try {
      process.env.DATUM_RENDER_SOCKET = sockPath;
      process.env.DATUM_RENDER_TOKEN = token;
      runtime.setRenderBridgeTransport(null);
      const info = await runtime.bridgeHandshake();
      expect(info.sandbox).toBe(true);
      expect(got[0]).toEqual({ op: "hello", token });
      process.env.DATUM_RENDER_TOKEN = "wrong";
      expect((await errOf(runtime.bridgeHandshake())).code).toBe("BROWSER_UNAVAILABLE");
    } finally {
      delete process.env.DATUM_RENDER_SOCKET;
      delete process.env.DATUM_RENDER_TOKEN;
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(sockPath, { force: true });
    }
  });
});
