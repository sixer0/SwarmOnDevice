// Swarm 1.2.6 row 62 (T-06, register E-10): the DATUM-25 refusal names WHICH colour values were
// counted, the source of each (edge.kind, mark, ...) and the remaining allowance. Limit unchanged (5).
// Red at e363918a69: the message printed only "6 nilai warna ... maksimum 5".
// Pure engine calls: no network, no model, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..");
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine");
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"));
const tokens = await import(path.join(ENGINE, "diagram", "core", "tokens.ts"));

const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04.studio.json"), "utf8"));
const spec = (patch?: (s: any) => void): any => {
  const s = structuredClone(CASE04);
  patch?.(s);
  return s;
};
const hex = (token: string): string => String(tokens.colourOf(token)).toUpperCase();
const refusal = (s: any): string => {
  try {
    build.buildDiagramSvg(s, { release: false });
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected a DATUM-25 refusal");
};

/** The six-colour guard of row124-svg.test.ts: a verify edge (verd) plus an ASUMSI glyph (alert). */
const SIX = (s: any) => {
  s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
  s.legend.push("ASUMSI = asumsi retensi");
  s.edges[4].kind = "verify";
};

describe("T-06 DATUM-25 detail: counted values, sources, remainder", () => {
  test("the refusal keeps its id, count and limit (limit unchanged)", () => {
    const msg = refusal(spec(SIX));
    expect(msg).toContain("DATUM-25: 6 nilai warna dalam satu gambar, maksimum 5");
  });

  test("the refusal lists every counted hex value with its source and the remainder", () => {
    const msg = refusal(spec(SIX));
    expect(msg).toContain("dihitung 6:");
    const listed = [...msg.matchAll(/(#[0-9A-F]{6}) \(([^)]+)\)/g)].map((m) => ({ hex: m[1], src: m[2] }));
    expect(listed.length).toBe(6);
    expect(new Set(listed.map((l) => l.hex)).size).toBe(6);
    for (const l of listed) expect(l.src.length).toBeGreaterThan(0);
    const by = new Map(listed.map((l) => [l.hex, l.src]));
    expect(by.get(hex("verd"))).toContain("edge.kind verify");
    expect(by.get(hex("alert"))).toContain("mark ASUMSI");
    expect(msg).toMatch(/sisa −1\b/);
  });

  test("one value drawn by both a line kind and a glyph names both sources (rev 178/193 shape)", () => {
    // Case 04 carries glyphs TERUKUR, DITURUNKAN, PEMASOK; add an accent line (signal, same hex as the
    // DITURUNKAN glyph), an alert line and an ASUMSI glyph (alert), and a verify line (verd).
    const s = spec((x: any) => {
      SIX(x);
      x.edges[1].kind = "accent";
      x.legend.push("accent = jalur utama");
    });
    const msg = refusal(s);
    const by = new Map([...msg.matchAll(/(#[0-9A-F]{6}) \(([^)]+)\)/g)].map((m) => [m[1], m[2]]));
    const signal = by.get(hex("signal")) ?? "";
    expect(signal).toContain("edge.kind accent");
    expect(signal).toContain("mark DITURUNKAN");
    expect(by.get(hex("verd"))).toContain("edge.kind verify");
    expect(msg).toMatch(/sisa −\d+/);
  });

  test("a figure within the limit builds unchanged", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    expect(r.report.colourValues.length).toBeLessThanOrEqual(5);
  });
});
