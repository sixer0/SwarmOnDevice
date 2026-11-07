// Row 124: Manual Rev A fixes in the vendored Studio diagram engine (C40 FIX list, C23, C29).
// Each describe block is one fix and fails on the unpatched engine (see
// implementation/<NN>_row124_engine_svg.md for the red and green runs).
// Pure engine calls: no network, no model, no browser, no file writes outside the test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..", "..");
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine");
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"));
const core = await import(path.join(ENGINE, "diagram", "core", "index.ts"));
const geom = await import(path.join(ENGINE, "diagram", "fit", "lint.ts"));
const renderLint = await import(path.join(ENGINE, "lint", "render", "index.ts"));
const dispatch = await import(path.join(PKG, "vendor", "src", "lib", "studio", "contract", "dispatch.ts"));

/** Case 04 Studio spec, byte copy of test/material_rev_a/Kasus 04 Diagram/gambar.studio.json (sha256 802b7e07...). */
const CASE04 = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "case04.studio.json"), "utf8"));
const spec = (patch?: (s: any) => void): any => {
  const s = structuredClone(CASE04);
  patch?.(s);
  return s;
};
const svgOf = (s: any): string => build.buildDiagramSvg(s, { release: false }).svg;

// ── SVG helpers (only the shapes this engine emits: double-quoted attributes, mm user units) ──
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
interface TextEl {
  a: Record<string, string>;
  inner: string;
  content: string;
}
const texts = (svg: string): TextEl[] =>
  [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => ({ a: attrs(m[1]), inner: m[2], content: unesc(m[2].replace(/<[^>]+>/g, "")) }));
/** Rev A check 25 as datum_lint.py counts it: every fill/stroke hex in the file, grounds removed. */
const lintColours = (svg: string): string[] => {
  const all = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()));
  for (const g of ["#FCFCFB", "#FBFAF7", "#FFFFFF"]) all.delete(g);
  return [...all].sort();
};
type Box = { id: string; x: number; y: number; w: number; h: number };
const nodeBoxes = (svg: string): Box[] =>
  [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
    const a = attrs(m[1]);
    return { id: a["data-node"], x: +a.x, y: +a.y, w: +a.width, h: +a.height };
  });
const links = (svg: string): Array<Array<[number, number]>> =>
  [...svg.matchAll(/<path\b([^>]*\bdata-mark="link"[^>]*)\/>/g)].map((m) =>
    [...attrs(m[1]).d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((q) => [+q[1], +q[2]] as [number, number]),
  );

// ── CP-43 / C23 check 25 / C29 K-32: at most 5 colour values per figure ─────────────────────
describe("CP-43 colour roles <= 5 (DT-06 ID p.48, Table 9.4 p.57)", () => {
  test("case 04 SVG has <= 5 fill/stroke hex values besides the ground (datum_lint check 25 count)", () => {
    const c = lintColours(svgOf(spec()));
    expect(c.length).toBeLessThanOrEqual(5);
  });
  test("no marker or pattern is defined that the figure does not use (no unused alert/verd colours)", () => {
    const svg = svgOf(spec());
    for (const m of svg.matchAll(/<(?:marker|pattern)\b[^>]*\bid="([^"]+)"/g)) expect(svg).toContain(`url(#${m[1]})`);
  });
  test("a figure that really needs 6 colour values is still refused (guard)", () => {
    const six = spec((s) => {
      s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
      s.legend.push("ASUMSI = asumsi retensi");
      s.edges[4].kind = "verify"; // verd: ink900, ink700, ink400, signal, alert + verd = 6
    });
    expect(() => svgOf(six)).toThrow(/DATUM-25/);
  });
  test("the engine's own DATUM-25 count equals the Rev A file count", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    expect(r.report.colourValues).toEqual(lintColours(r.svg));
  });
  test("estimate() predicts the same colour values as the built SVG", () => {
    const s = spec();
    const est = core.estimate(s, dispatch.DIAGRAM_LAYOUTS[s.family]);
    expect(est.colourValues).toEqual(build.buildDiagramSvg(s, { release: false }).report.colourValues);
  });
  test("Studio render lint DATUM-25 counts every hex value (no ink-ramp folding, K-32 dropped)", () => {
    const six = ["#101418", "#2B3640", "#6B7783", "#C3CBD1", "#B45309", "#9B1C1C"];
    const rects = six.map((c, i) => `<rect x="${i * 10}" y="0" width="8" height="8" fill="${c}"/>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="20mm" viewBox="0 0 128 20"><rect x="0" y="0" width="128" height="20" fill="#FCFCFB"/>${rects}</svg>`;
    const out = renderLint.lintRendered({ svgs: [{ svg, widthMm: 128, heightMm: 20 }], metrics: { pageCount: 0, elements: [] } });
    const c25 = out.filter((i: any) => i.checkId === "DATUM-25");
    expect(c25.some((i: any) => i.status === "FAIL")).toBe(true);
    const five = renderLint.lintRendered({
      svgs: [{ svg: svg.replace(/<rect x="50"[^>]*\/>/, ""), widthMm: 128, heightMm: 20 }],
      metrics: { pageCount: 0, elements: [] },
    });
    expect(five.filter((i: any) => i.checkId === "DATUM-25").every((i: any) => i.status === "PASS")).toBe(true);
  });
});

// ── CP-28 / CP-48: bold GAMBAR label in the figure caption ───────────────────────────────────
describe("CP-28/48 caption label GAMBAR n.m, bold (DT-15 ID p.41)", () => {
  const caption = (svg: string) => texts(svg).find((t) => t.content.includes("Arsitektur sistem pemantauan"));
  test("figure caption starts with the label GAMBAR 4.1", () => {
    expect(caption(svgOf(spec()))?.content.startsWith("GAMBAR 4.1")).toBe(true);
  });
  test("the label is bold (font-weight >= 600) and the sentence is not", () => {
    const c = caption(svgOf(spec()));
    const label = /<tspan\b([^>]*)>(GAMBAR 4\.1)<\/tspan>/.exec(c?.inner ?? "");
    expect(label).not.toBeNull();
    expect(Number(attrs(label![1])["font-weight"])).toBeGreaterThanOrEqual(600);
    expect(Number(c!.a["font-weight"])).toBeLessThan(600);
  });
  test("caption carries no middle dot between label and sentence", () => {
    expect(caption(svgOf(spec()))?.content.includes("·")).toBe(false);
  });
  test("an English document passes FIGURE; the key word can be set by the caller (CP-35 seam)", () => {
    const svg = build.buildDiagramSvg(spec(), { release: false, figureLabel: "FIGURE", keyLabel: "KUNCI" }).svg;
    expect(caption(svg)?.content.startsWith("FIGURE 4.1")).toBe(true);
    expect(texts(svg).some((t) => t.content.startsWith("KUNCI  DATA = "))).toBe(true);
  });
});

// ── CP-29: evidence-mark glyph colours per Table 7.1 (ID p.38) ───────────────────────────────
describe("CP-29 mark glyph colours (Table 7.1 ID p.38)", () => {
  const TABLE_7_1: Record<string, string> = { "■": "#101418", "◈": "#B45309", "◇": "#6B7783", "△": "#9B1C1C" };
  const withAllMarks = () =>
    spec((s) => {
      s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
      s.legend.push("ASUMSI = asumsi retensi"); // DATUM-34: every house glyph used needs a key row
    });
  test("each glyph is filled in its Table 7.1 colour", () => {
    const glyphs = texts(svgOf(withAllMarks())).filter((t) => t.content in TABLE_7_1);
    expect(new Set(glyphs.map((g) => g.content))).toEqual(new Set(Object.keys(TABLE_7_1)));
    for (const g of glyphs) expect(`${g.content} ${g.a.fill}`).toBe(`${g.content} ${TABLE_7_1[g.content]}`);
  });
  test("the four-mark figure still stays within 5 colour values", () => {
    expect(lintColours(svgOf(withAllMarks())).length).toBeLessThanOrEqual(5);
  });
});

// ── CP-41: orthogonal connectors, none through a box (ID p.63, 10.3; DT-01b p.62) ─────────────
describe("CP-41 connector routing", () => {
  const inside = (p: [number, number], b: Box, inset = 0.3) => p[0] > b.x + inset && p[0] < b.x + b.w - inset && p[1] > b.y + inset && p[1] < b.y + b.h - inset;
  const onBoundary = (p: [number, number], b: Box) =>
    p[0] >= b.x - 0.01 && p[0] <= b.x + b.w + 0.01 && p[1] >= b.y - 0.01 && p[1] <= b.y + b.h + 0.01 && !inside(p, b, 0.01);
  test("every segment is axis-parallel", () => {
    for (const pl of links(svgOf(spec()))) {
      for (let i = 0; i + 1 < pl.length; i++) {
        const [a, b] = [pl[i], pl[i + 1]];
        expect(Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6).toBe(true);
      }
    }
  });
  test("no connector runs through the interior of any box, its own two boxes included", () => {
    const svg = svgOf(spec());
    const boxes = nodeBoxes(svg);
    const bad: string[] = [];
    links(svg).forEach((pl, li) => {
      for (let i = 0; i + 1 < pl.length; i++) {
        for (let k = 0; k <= 40; k++) {
          const t = k / 40;
          const p: [number, number] = [pl[i][0] + (pl[i + 1][0] - pl[i][0]) * t, pl[i][1] + (pl[i + 1][1] - pl[i][1]) * t];
          for (const b of boxes) if (inside(p, b)) bad.push(`edge ${li} seg ${i} in ${b.id}`);
        }
      }
    });
    expect([...new Set(bad)]).toEqual([]);
  });
  test("each connector starts and ends on the boundary of its own boxes", () => {
    const svg = svgOf(spec());
    const boxes = new Map(nodeBoxes(svg).map((b) => [b.id, b]));
    links(svg).forEach((pl, li) => {
      const e = CASE04.edges[li];
      const from = boxes.get(e.from);
      const to = boxes.get(e.to);
      if (from) expect(`edge ${li} start ${onBoundary(pl[0], from)}`).toBe(`edge ${li} start true`);
      if (to) expect(`edge ${li} end ${onBoundary(pl[pl.length - 1], to)}`).toBe(`edge ${li} end true`);
    });
  });
});

// ── CP-45: specified symbol drawn, legend complete (SM-01/03/04, Table 10.1, ID p.63, 66) ─────
describe("CP-45 node symbol and legend", () => {
  const withBattery = () => spec((s) => (s.nodes.find((n: any) => n.id === "ups").symbol = "iec:battery"));
  test("iec:battery is drawn inside the UPS box", () => {
    const svg = svgOf(withBattery());
    const g = /<g\b([^>]*\bdata-symbol="iec:battery"[^>]*)>/.exec(svg);
    expect(g).not.toBeNull();
    const a = attrs(g![1]);
    expect(a["data-symbol-of"]).toBe("ups");
    const m = /translate\(([-\d.]+)[ ,]([-\d.]+)\)\s*scale\(([\d.]+)\)/.exec(a.transform ?? "");
    expect(m).not.toBeNull();
    const [tx, ty, sc] = [+m![1], +m![2], +m![3]];
    const ups = nodeBoxes(svg).find((b) => b.id === "ups")!;
    expect(tx).toBeGreaterThanOrEqual(ups.x);
    expect(ty).toBeGreaterThanOrEqual(ups.y);
    expect(tx + 24 * sc).toBeLessThanOrEqual(ups.x + ups.w);
    expect(ty + 24 * sc).toBeLessThanOrEqual(ups.y + ups.h);
  });
  test("symbol strokes keep the 0.18 mm photocopy floor at the drawn scale", () => {
    const svg = svgOf(withBattery());
    const grp = /<g\b[^>]*data-symbol="iec:battery"[^>]*scale\(([\d.]+)\)[^>]*>([\s\S]*?)<\/g>/.exec(svg)!;
    const sc = +grp[1];
    for (const w of grp[2].matchAll(/stroke-width="([\d.]+)"/g)) expect(+w[1] * sc).toBeGreaterThanOrEqual(0.18);
  });
  test("the key line has a row for the symbol used", () => {
    const key = texts(svgOf(withBattery()))
      // key lines = table_header role at the left margin (SemiBold, tracked); a wrapped key has several
      .filter((t) => t.a.x === "0" && t.a["font-weight"] === "600" && t.a["letter-spacing"] !== undefined)
      .map((t) => t.content)
      .join(" ");
    expect(key).toContain("IEC:BATTERY");
  });
  test("an unknown symbol id is refused", () => {
    expect(() => svgOf(spec((s) => (s.nodes[0].symbol = "iec:nope")))).toThrow();
  });
  test("two symbol dialects in one figure are refused (SM-04)", () => {
    expect(() =>
      svgOf(
        spec((s) => {
          s.nodes.find((n: any) => n.id === "ups").symbol = "iec:battery";
          s.nodes.find((n: any) => n.id === "op").symbol = "sec:camera";
        }),
      ),
    ).toThrow(/SM-04/);
  });
});

// ── CP-46: key line fits inside the figure, nothing clipped (ID p.63, 80) ─────────────────────
describe("CP-46 key line fits the figure width", () => {
  test("no text of the case 04 figure runs outside the 128 mm sheet", () => {
    const g = geom.lintDiagramGeometry(svgOf(spec()));
    expect(g.defects.filter((d: any) => d.kind === "textOutside")).toEqual([]);
  });
  test("every legend row is printed in full in the key", () => {
    const all = texts(svgOf(spec()))
      .map((t) => t.content)
      .join("\n");
    for (const row of CASE04.legend) expect(all).toContain(String(row).toUpperCase());
  });
  test("the figure height still includes every key line (caption and SUMBER inside the sheet)", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    for (const t of texts(r.svg)) expect(+t.a.y).toBeLessThanOrEqual(r.heightMm + 1e-6);
  });
});
