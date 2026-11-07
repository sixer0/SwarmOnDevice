// Row 163 (decision U24 C): the Vega chart family V-01..V-08 for chart types the Rev A families lack.
// Security binding: verification/18_row160_engine_deps_security.md §4 (C1-C9, C11) and §6 (T1-T7, T9; T8 is ELK,
// row 162). Pure engine calls plus the render bridge stand-in of rows 67/108 (Electron cannot run under bun):
// no network (dead proxy in the test env), no model, no files outside the test's temp folder.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { View, parse } from "vega";
import { compile } from "vega-lite";
import type { BridgeTransport } from "../../../vendor/src/lib/studio/engine/browser/runtime";
import { FIXTURES, VARIANTS } from "./fixtures";

const PKG = path.resolve(import.meta.dir, "..", "..", "..");
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio");
const LINT_PY = path.resolve(PKG, "..", "desktop", "datum", "datum-house-style", "scripts", "datum_lint.py");
// Folder names without "_" (Rev A lint 38 reads the containing folder name).
const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "row163-")));
const LINT_DIR = path.join(WORK, "Vega Lint");
mkdirSync(LINT_DIR, { recursive: true });
process.env.STUDIO_ASSETS_ROOT = path.join(STUDIO, "assets");
process.env.STUDIO_WORKSPACE_ROOT = path.join(WORK, "ws");
mkdirSync(process.env.STUDIO_WORKSPACE_ROOT, { recursive: true });
delete process.env.DATUM_RENDER_SOCKET;
delete process.env.DATUM_RENDER_TOKEN;

const family = await import("../../../vendor/src/lib/studio/engine/chart/family-v/index.ts");
const input = await import("../../../vendor/src/lib/studio/engine/chart/family-v/input.ts");
const registry = await import("../../../vendor/src/lib/studio/registry/charts.ts");
const renderLint = await import("../../../vendor/src/lib/studio/engine/lint/render/index.ts");
const runtime = await import("../../../vendor/src/lib/studio/engine/browser/runtime");
const browser = await import("../../../vendor/src/lib/studio/engine/browser/index");

const ALL: Record<string, Record<string, unknown>> = { ...FIXTURES, ...VARIANTS };
const clone = <T>(v: T): T => structuredClone(v);

/** Rev A check 25 as datum_lint.py counts it: every fill/stroke hex, grounds removed. */
const lintColours = (svg: string): string[] => {
  const all = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()));
  for (const g of ["#FCFCFB", "#FBFAF7", "#FFFFFF"]) all.delete(g);
  return [...all].sort();
};

async function errOf(p: Promise<unknown> | (() => unknown)): Promise<{ code?: string; message: string; details?: Record<string, unknown> }> {
  try {
    await (typeof p === "function" ? p() : p);
    return { message: "no-throw" };
  } catch (e) {
    const x = e as { code?: string; message: string; details?: Record<string, unknown> };
    return { code: x.code, message: x.message, details: x.details };
  }
}

const rendered = new Map<string, Awaited<ReturnType<typeof family.renderVegaChart>>>();
for (const [k, f] of Object.entries(ALL)) rendered.set(k, await family.renderVegaChart(clone(f)));

afterAll(() => {
  runtime.setRenderBridgeTransport(null);
});

// ── Registry ─────────────────────────────────────────────────────────────
describe("registry: VEGA_CHART_REGISTRY (additive)", () => {
  test("8 Vega codes, same list as the engine; Rev A registry count unchanged (76)", () => {
    expect(registry.VEGA_CHART_REGISTRY.map((d: { code: string }) => d.code)).toEqual([...family.VEGA_CHART_CODES]);
    expect(registry.VEGA_CHART_REGISTRY_COUNT).toBe(8);
    expect(registry.CHART_REGISTRY_COUNT).toBe(76);
    expect(registry.CHART_REGISTRY.length).toBe(76);
  });
  test("undrawn Rev A codes point to their Vega type", () => {
    expect(registry.vegaChartFor("DF-01")).toBe("V-06");
    expect(registry.vegaChartFor("DF-13")).toBe("V-02");
    expect(registry.vegaChartFor("DF-05")).toBeNull(); // word cloud: needs a canvas (research/16 R5)
  });
});

// ── One fixture per type: SVG, Rev A lint 27/27, colour roles <= 5, chart + render lint ─────────
describe("each Vega type renders a Rev A clean SVG", () => {
  for (const k of Object.keys(ALL)) {
    test(`${k}: SVG 128 mm, Rev A file lint 27/27, <= 5 colour values, no lint FAIL`, () => {
      const r = rendered.get(k)!;
      expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="128mm"')).toBe(true);
      expect(r.widthMm).toBe(128);
      expect(lintColours(r.svg).length).toBeLessThanOrEqual(5);
      expect(r.report.issues.filter((i: { status: string }) => i.status === "FAIL")).toEqual([]);
      // Caption and source (Rev A 29, 30) present; real text, no raster.
      expect(r.svg).toContain(">GAMBAR 4.");
      expect(r.svg).toContain(">SUMBER  ");
      expect(r.svg).not.toMatch(/<image\b|<foreignObject\b|<script\b/);
      // Studio render lint (the module the template guard runs, lintAfterRender's SVG part): no FAIL.
      const ri = renderLint.lintRendered({ svgs: [{ svg: r.svg, widthMm: r.widthMm, heightMm: r.heightMm, report: r.report }], metrics: { pageCount: 0, elements: [] } });
      expect(ri.filter((i: { status: string }) => i.status === "FAIL").map((i: { checkId: string; detail?: string }) => `${i.checkId} ${i.detail}`)).toEqual([]);
      // Claude's Rev A linter (bundled skill copy), as rows 102/124 run it.
      const file = path.join(LINT_DIR, `Vega ${k.replace(/ /g, "-")}.svg`);
      writeFileSync(file, r.svg);
      const out = spawnSync("python3", ["-I", LINT_PY, file], { encoding: "utf8" });
      expect(out.stdout).toContain("✓ 27/27 file-lint checks clean.");
    });
  }
  test("deterministic: same input -> byte-identical SVG", async () => {
    for (const k of ["V-01", "V-07", "V-08"]) expect((await family.renderVegaChart(clone(ALL[k]))).svg).toBe(rendered.get(k)!.svg);
  });
  test("text is real text in Plex faces, sizes >= 5.5 pt, strokes >= 0.18 mm", () => {
    for (const r of rendered.values()) {
      for (const f of r.svg.matchAll(/font-family="([^"]+)"/g)) expect(f[1]).toMatch(/^IBM Plex (Sans Condensed|Mono)$/);
      for (const s of r.svg.matchAll(/font-size="([0-9.]+)"/g)) expect(Number(s[1]) / (25.4 / 72)).toBeGreaterThanOrEqual(5.5 - 1e-6);
      for (const w of r.svg.matchAll(/stroke-width="([0-9.]+)"/g)) expect(Number(w[1])).toBeGreaterThanOrEqual(0.18 - 1e-9);
    }
  });
  test("colours are template tokens only (paper, ink900/700/400/200, accent)", () => {
    for (const r of rendered.values()) expect(lintColours(r.svg).every((c) => ["#101418", "#2B3640", "#6B7783", "#C3CBD1", "#B45309"].includes(c))).toBe(true);
  });
  test("166 mm width renders too; a width outside the template set is refused (G2)", async () => {
    const wide = await family.renderVegaChart({ ...clone(FIXTURES["V-02"]), widthMm: 166 });
    expect(wide.widthMm).toBe(166);
    const e = await errOf(family.renderVegaChart({ ...clone(FIXTURES["V-02"]), widthMm: 150 }));
    expect(e.code).toBe("BY_CONSTRUCTION_FAILED");
    expect(e.message).toContain("[G2]");
  });
});

// ── PNG raster through the render bridge (CP-47: 128 mm = 1512 px at 300 dpi) ────────────────
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
function fakePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])), chunk("IEND", Buffer.alloc(0))]);
}
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] };

describe("PNG raster via the render bridge", () => {
  for (const k of Object.keys(FIXTURES)) {
    test(`${k}: 300 dpi PNG 1512 px wide; only hello + png ops; the SVG sent has no external reference`, async () => {
      const seen: Array<{ op: string; width?: number; src?: string }> = [];
      const transport: BridgeTransport = async (req) => {
        const s: { op: string; width?: number; src?: string } = { op: String(req.op) };
        seen.push(s);
        if (req.op === "hello") return { ok: true, ...GOOD_INFO };
        if (req.op === "png") {
          s.width = Number(req.width);
          s.src = readFileSync(String(req.src), "utf8");
          writeFileSync(String(req.dst), fakePng(Number(req.width), Number(req.height)));
          return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height };
        }
        return { ok: false, code: "UNKNOWN_OP", message: "?" };
      };
      runtime.setRenderBridgeTransport(transport);
      const r = rendered.get(k)!;
      const png = await family.rasterizeVegaChart(r);
      const size = browser.readPngSize(png)!;
      expect(size.widthPx).toBe(1512);
      expect(Math.abs(size.heightPx - Math.round((r.heightMm / 25.4) * 300))).toBeLessThanOrEqual(2);
      expect(seen.map((s) => s.op).every((o) => o === "hello" || o === "png")).toBe(true);
      const sent = seen.find((s) => s.op === "png")!;
      expect(sent.width).toBe(1512);
      // Only Studio's own embedded fonts (data: URLs in the bridge's <style>) may reference anything.
      expect(sent.src!.replace(/<style[\s\S]*?<\/style>/g, "").replace(/\sxmlns(?::xlink)?="http:\/\/www\.w3\.org\/[^"]*"/g, "")).not.toMatch(/https?:|file:|xlink:href|<image/);
      runtime.setRenderBridgeTransport(null);
    });
  }
});

// ── Capacity (U24 B): refuse with FIGURE_OVER_CAPACITY instead of squeezing ───────────────────
describe("over-capacity input is refused with FIGURE_OVER_CAPACITY and a suggestion", () => {
  const cases: Array<[string, () => Record<string, unknown>, string]> = [
    [
      "V-05 20 categories",
      () => ({ ...clone(FIXTURES["V-05"]), accent: undefined, data: { shape: "categorical", points: Array.from({ length: 20 }, (_, i) => ({ label: `K${i}`, value: i + 1 })) } }),
      "kategori",
    ],
    [
      "V-06 4 series",
      () => {
        const f = clone(FIXTURES["V-06"]) as { data: { series: Array<{ name: string; values: number[] }> } };
        f.data.series.push({ name: "Tim C", values: [1, 2, 3, 4, 5, 6] }, { name: "Tim D", values: [1, 2, 3, 4, 5, 6] });
        return f as unknown as Record<string, unknown>;
      },
      "seri",
    ],
    [
      "V-01 two years",
      () => {
        const t0 = Date.UTC(2025, 0, 1);
        return { ...clone(FIXTURES["V-01"]), accent: undefined, data: { shape: "days", days: Array.from({ length: 700 }, (_, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), value: i % 9 })) } };
      },
      "hari",
    ],
    [
      "V-08 too many leaves",
      () => ({ ...clone(FIXTURES["V-08"]), accent: undefined, data: { shape: "hierarchy", nodes: [{ id: "r", label: "Akar" }, ...Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, parent: "r", label: `Daun ${i}` }))] } }),
      "daun",
    ],
  ];
  for (const [name, make, unit] of cases) {
    test(name, async () => {
      const e = await errOf(family.renderVegaChart(make()));
      expect(e.code).toBe("FIGURE_OVER_CAPACITY");
      expect(e.details?.figure).toBe("chart");
      expect(e.details?.unit).toBe(unit);
      expect(Number(e.details?.measured)).toBeGreaterThan(Number(e.details?.limit));
      expect(String(e.details?.suggestion).length).toBeGreaterThan(10);
      expect(e.message).toContain("; saran: ");
    });
  }
  test("at capacity still renders (V-05 with 16 short labels)", async () => {
    const r = await family.renderVegaChart({ ...clone(FIXTURES["V-05"]), accent: undefined, data: { shape: "categorical", points: Array.from({ length: 16 }, (_, i) => ({ label: `K${i}`, value: i + 1 })) } });
    expect(lintColours(r.svg).length).toBeLessThanOrEqual(5);
  });
});

// ── Security tests of verification/18_row160 §6 ───────────────────────────────────────────────
describe("T1 no Function / eval during a Vega render (C1)", () => {
  test("0 Function and 0 eval calls across every fixture; the probe sees > 0 without the interpreter", async () => {
    const realFunction = globalThis.Function;
    const realEval = globalThis.eval;
    let calls = 0;
    const counting = new Proxy(realFunction, {
      apply(t, self, args) {
        calls++;
        return Reflect.apply(t, self, args);
      },
      construct(t, args) {
        calls++;
        return Reflect.construct(t, args);
      },
    });
    let evals = 0;
    // Validators are compiled once by ajv from Studio's constant schemas (warm-up above); the window below is
    // the Vega render path: spec build, Vega-Lite compile, parse, dataflow, SVG.
    (globalThis as { Function: unknown }).Function = counting;
    (globalThis as { eval: unknown }).eval = (s: string) => {
      evals++;
      return realEval(s);
    };
    try {
      for (const f of Object.values(ALL)) await family.renderVegaChart(clone(f));
      expect(calls).toBe(0);
      expect(evals).toBe(0);
      // Control: the same kind of spec through vega's DEFAULT path (no interpreter) does call Function.
      const vg = compile({ data: { values: [{ a: 1 }, { a: 2 }] }, transform: [{ calculate: "datum.a * 2", as: "b" }], mark: "point", encoding: { x: { field: "b", type: "quantitative" } } } as never).spec;
      const view = new View(parse(vg), { renderer: "none" });
      await view.toSVG();
      view.finalize();
      expect(calls).toBeGreaterThan(0);
    } finally {
      (globalThis as { Function: unknown }).Function = realFunction;
      (globalThis as { eval: unknown }).eval = realEval;
    }
  });
});

describe("T2 agent expressions refused before Vega (C2)", () => {
  const base = () => clone(FIXTURES["V-05"]) as Record<string, unknown>;
  const cases: Array<[string, (f: Record<string, unknown>) => void]> = [
    ["calculate", (f) => ((f.data as Record<string, unknown>).calculate = "datum.value * 2")],
    ["filter string", (f) => (f.filter = "datum.value > 1")],
    ["params", (f) => (f.params = [{ name: "p", value: 1 }])],
    ["signal value", (f) => (f.options = { max: { signal: "width" } })],
    ["expr", (f) => ((f.data as { points: Array<Record<string, unknown>> }).points[0].expr = "1")],
    ["encoding", (f) => (f.encoding = { x: { field: "constructor.constructor" } })],
    ["transform", (f) => (f.transform = [{ type: "formula", expr: "1", as: "x" }])],
    ["config", (f) => (f.config = { background: "red" })],
    ["colour", (f) => (f.options = { color: "#FF0000" })],
    ["unknown field", (f) => (f.mystery = 1)],
  ];
  for (const [name, mutate] of cases) {
    test(name, async () => {
      const f = base();
      mutate(f);
      const e = await errOf(family.renderVegaChart(f));
      expect(e.code).toBe("SCHEMA_INVALID");
    });
  }
  test("expression-looking agent text is drawn as literal text, never evaluated", async () => {
    const realFunction = globalThis.Function;
    let calls = 0;
    (globalThis as { Function: unknown }).Function = new Proxy(realFunction, {
      apply: (t, s, a) => (calls++, Reflect.apply(t, s, a)),
      construct: (t, a) => (calls++, Reflect.construct(t, a)),
    });
    try {
      const f = clone(FIXTURES["V-05"]) as { data: { points: Array<{ label: string }> } };
      f.data.points[0].label = "datum.constructor.constructor('x')()";
      const r = await family.renderVegaChart(f);
      expect(r.svg).toContain("datum.constructor.constructor(&#39;x&#39;)()".replace(/&#39;/g, "'"));
      expect(calls).toBe(0);
    } finally {
      (globalThis as { Function: unknown }).Function = realFunction;
    }
  });
  test("markup in agent text is refused", async () => {
    const f = clone(FIXTURES["V-05"]) as { title: string };
    f.title = "Judul <script>alert(1)</script>.";
    expect((await errOf(family.renderVegaChart(f))).code).toBe("SCHEMA_INVALID");
  });
});

describe("T3 no file read (C3, C4)", () => {
  const SECRET = "ROW163-SECRET-6f1c";
  const secretFile = path.join(WORK, "secret.json");
  writeFileSync(secretFile, JSON.stringify([{ a: SECRET }]));
  test("data.url (path, file://, //host) refused by the validator", async () => {
    for (const url of [secretFile, `file://${secretFile}`, "//127.0.0.1:9/x.json"]) {
      const f = clone(FIXTURES["V-05"]) as { data: Record<string, unknown> };
      f.data.url = url;
      expect((await errOf(family.renderVegaChart(f))).code).toBe("SCHEMA_INVALID");
    }
  });
  test("validator bypassed: the deny-all loader refuses, no file opened, the secret never reaches the SVG", async () => {
    const spies = [spyOn(fs, "readFile"), spyOn(fs, "readFileSync"), spyOn(fs.promises, "readFile")];
    try {
      for (const url of [secretFile, `file://${secretFile}`]) {
        const spec = { width: 100, height: 50, data: [{ name: "d", url, format: { type: "json" } }], marks: [{ type: "text", from: { data: "d" }, encode: { enter: { text: { field: "a" } } } }] };
        const e = await errOf(family.vegaSvg(spec as never));
        expect(e.code).toBe("RENDER_FAILED");
        expect(e.message).toContain("DATUM: external data is disabled");
        expect(e.message).not.toContain(SECRET);
      }
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
  test("the compiled-spec guard also refuses url data and csv format", () => {
    expect(() => family.assertStudioVegaSpec({ data: [{ name: "d", url: "x.json" }] })).toThrow(/C4\/C5/);
    expect(() => family.assertStudioVegaSpec({ data: [{ name: "d", values: [], format: { type: "csv" } }] })).toThrow(/C4/);
    expect(() => family.assertStudioVegaSpec({ data: [{ name: "d", values: "a,b\n1,2" }] })).toThrow(/C4/);
  });
});

describe("T4 no network, no crash (C3, C5)", () => {
  test("href / image / tooltip keys refused by the validator", async () => {
    for (const key of ["href", "image", "tooltip"]) {
      const f = clone(FIXTURES["V-05"]) as { data: { points: Array<Record<string, unknown>> } };
      f.data.points[0][key] = "http://127.0.0.1:9/x.png";
      expect((await errOf(family.renderVegaChart(f))).code).toBe("SCHEMA_INVALID");
    }
  });
  test("validator bypassed: image + href marks render with no external URL and no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const spec = {
        width: 100,
        height: 50,
        marks: [
          { type: "image", encode: { enter: { url: { value: "http://127.0.0.1:9/pixel.png" }, x: { value: 1 }, y: { value: 1 }, width: { value: 10 }, height: { value: 10 } } } },
          { type: "text", encode: { enter: { text: { value: "tautan" }, href: { value: "https://127.0.0.1:9/track" }, x: { value: 20 }, y: { value: 20 } } } },
        ],
      };
      const out = await family.vegaSvg(spec as never);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      expect(out.svg).not.toMatch(/127\.0\.0\.1|https?:\/\/(?!www\.w3\.org)/);
      // The Studio guard refuses the image mark before Vega would ever see it.
      expect(() => family.assertStudioVegaSpec(spec)).toThrow(/image|C5/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("T5 SVG output gate (C6)", () => {
  const base = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10mm" height="10mm" viewBox="0 0 10 10">';
  const bad = [
    `${base}<rect fill="url(https://x/y)"/></svg>`,
    `${base}<image href="https://x/p.png"/></svg>`,
    `${base}<a href="https://x"><text>t</text></a></svg>`,
    `${base}<use xlink:href="file:///etc/hosts"/></svg>`,
    `${base}<script>1</script></svg>`,
    `${base}<foreignObject/></svg>`,
    `${base}<style>@import "x.css";</style></svg>`,
    `${base}<rect onload="x()"/></svg>`,
  ];
  for (const s of bad) {
    test(`refused: ${s.slice(base.length, base.length + 40)}`, () => {
      expect(() => family.assertSafeSvg(s)).toThrow(/gerbang C6/);
    });
  }
  test("allowed: internal url(#id), text that names a web page (SUMBER line)", () => {
    expect(() => family.assertSafeSvg(`${base}<rect fill="url(#p)"/><text>SUMBER  https://bps.go.id</text></svg>`)).not.toThrow();
  });
  test("a non-token colour (named, rgb(), url()) is refused by the colour gate", () => {
    const allowed = new Set(["#101418"]);
    expect(() => family.tokenColours('<rect fill="#101418"/>', allowed)).not.toThrow();
    for (const c of ["red", "rgb(1,2,3)", "url(https://x)", "#FF0000"]) expect(() => family.tokenColours(`<rect fill="${c}"/>`, allowed)).toThrow(/DATUM-25/);
  });
});

describe("T6 size, depth, rows and time limits (C8)", () => {
  test("input > 256 KiB -> PAYLOAD_TOO_LARGE", async () => {
    const f = clone(FIXTURES["V-04"]) as { data: { groups: Array<{ name: string; values: number[] }> } };
    f.data.groups = Array.from({ length: 60 }, (_, i) => ({ name: `g${i}`, values: Array.from({ length: 1000 }, (_, k) => k + 0.123456) }));
    expect((await errOf(family.renderVegaChart(f))).code).toBe("PAYLOAD_TOO_LARGE");
  });
  test("nesting deeper than 64 -> PAYLOAD_TOO_LARGE", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect((await errOf(family.renderVegaChart({ ...clone(FIXTURES["V-05"]), x: deep }))).code).toBe("PAYLOAD_TOO_LARGE");
  });
  test("more than 5 000 rows -> PAYLOAD_TOO_LARGE", async () => {
    const f = clone(FIXTURES["V-04"]) as { data: { groups: Array<{ name: string; values: number[] }> } };
    f.data.groups = [{ name: "a", values: Array.from({ length: 5001 }, (_, k) => k % 7) }];
    expect((await errOf(family.renderVegaChart(f))).code).toBe("PAYLOAD_TOO_LARGE");
  });
  test("a string longer than 1 000 characters -> SCHEMA_INVALID", async () => {
    expect((await errOf(family.renderVegaChart({ ...clone(FIXTURES["V-05"]), title: "x".repeat(1001) }))).code).toBe("SCHEMA_INVALID");
  });
  test("a render over the time limit -> RENDER_TIMEOUT (clear message, limit in details)", async () => {
    const e = await errOf(family.renderVegaChart(clone(FIXTURES["V-01"]), undefined, { timeoutMs: 1 }));
    expect(e.code).toBe("RENDER_TIMEOUT");
    expect(e.details?.limitMs).toBe(1);
  });
});

describe("T7 key hygiene (C9)", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    test(`key ${key} refused at any depth; Object.prototype untouched`, async () => {
      const raw = JSON.parse(`{"kind":"V-05","title":"t.","source":"s.","widthMm":128,"data":{"shape":"categorical","points":[{"label":"a","value":1,"${key}":{"polluted":true}}]}}`);
      const e = await errOf(family.renderVegaChart(raw));
      expect(e.code).toBe("SCHEMA_INVALID");
      expect((({}) as { polluted?: unknown }).polluted).toBeUndefined();
    });
  }
  test("the compiled-spec guard refuses the same keys", () => {
    expect(() => family.assertStudioVegaSpec(JSON.parse('{"marks":[{"__proto__":{"x":1}}]}'))).toThrow(/__proto__/);
  });
});

describe("T9 canvas is never resolvable (C11)", () => {
  test("import('canvas') fails; vega-canvas returns no canvas, Studio measures text itself", async () => {
    const e = await errOf(import("canvas" as string));
    expect(e.message).not.toBe("no-throw");
    // vega-canvas is vega's own dependency (not ours): resolve it from vega's folder, as vega-scenegraph does.
    const { canvas } = await import(Bun.resolveSync("vega-canvas", path.dirname(Bun.resolveSync("vega-scenegraph", path.dirname(Bun.resolveSync("vega", PKG))))));
    expect(canvas(10, 10)).toBeNull();
  });
  test("one Vega entry point: only family-v/sandbox.ts imports parse/View from vega in the vendored and host code", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        return statSync(p).isDirectory() ? (n === "node_modules" ? [] : files(p)) : /\.(ts|tsx|mts)$/.test(n) ? [p] : [];
      });
    const hits = [...files(path.join(PKG, "vendor", "src")), ...files(path.join(PKG, "src"))].filter((f) => /from\s+["']vega["']/.test(readFileSync(f, "utf8")) && /\b(View|parse)\b[^;]*from\s+["']vega["']/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(PKG, f))).toEqual(["vendor/src/lib/studio/engine/chart/family-v/sandbox.ts"]);
  });
});

describe("validation details", () => {
  test("hierarchy: two roots, a cycle and an unknown parent are refused", async () => {
    const mk = (nodes: unknown[]) => ({ ...clone(FIXTURES["V-08"]), accent: undefined, data: { shape: "hierarchy", nodes } });
    expect((await errOf(family.renderVegaChart(mk([{ id: "a", label: "A" }, { id: "b", label: "B" }])))).code).toBe("SCHEMA_INVALID");
    expect((await errOf(family.renderVegaChart(mk([{ id: "r", label: "R" }, { id: "a", parent: "b", label: "A" }, { id: "b", parent: "a", label: "B" }])))).code).toBe("SCHEMA_INVALID");
    expect((await errOf(family.renderVegaChart(mk([{ id: "r", label: "R" }, { id: "a", parent: "zz", label: "A" }])))).code).toBe("SCHEMA_INVALID");
  });
  test("series lengths must match the categories; dates must be real dates", async () => {
    const s = clone(FIXTURES["V-02"]) as { data: { series: Array<{ values: number[] }> } };
    s.data.series[0].values.pop();
    expect((await errOf(family.renderVegaChart(s))).code).toBe("SCHEMA_INVALID");
    const d = clone(FIXTURES["V-01"]) as { data: { days: Array<{ date: string }> } };
    d.data.days[0].date = "2026-02-30";
    expect((await errOf(family.renderVegaChart(d))).code).toBe("SCHEMA_INVALID");
  });
  test("validateVegaChartInput returns a private copy", () => {
    const f = clone(FIXTURES["V-05"]);
    const v = input.validateVegaChartInput(f);
    expect(v).not.toBe(f);
    expect(v).toEqual(f as never);
  });
});
