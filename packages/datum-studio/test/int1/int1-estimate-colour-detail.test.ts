// Swarm 1.2.6 integration pass INT-1 item 5 (row 62 follow-up, T-06 / E-10): the estimate-time DATUM-25 refusal
// (engine/diagram/core/estimate.ts, the twin of build/svg.ts) names each counted colour value with its sources and the
// remainder, like the build-time refusal. Red at e363918a69: it printed only "6 nilai warna ... maksimum 5".
// Pure engine calls: no network, no model, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..");
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine");
const core = await import(path.join(ENGINE, "diagram", "core", "estimate.ts"));
const tokens = await import(path.join(ENGINE, "diagram", "core", "tokens.ts"));
const dispatch = await import(path.join(PKG, "vendor", "src", "lib", "studio", "contract", "dispatch.ts"));

const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04.studio.json"), "utf8"));
const hex = (token: string): string => String(tokens.colourOf(token)).toUpperCase();

/** The six-colour guard of row124-svg.test.ts: a verify edge (verd) plus an ASUMSI glyph (alert). */
const six = (): any => {
  const s = structuredClone(CASE04);
  s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
  s.legend.push("ASUMSI = asumsi retensi");
  s.edges[4].kind = "verify";
  return s;
};

const refusal = (s: any): string => {
  try {
    core.estimate(s, dispatch.DIAGRAM_LAYOUTS[s.family]);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected a DATUM-25 refusal");
};

describe("INT-1 item 5: estimate DATUM-25 refusal carries colourCountDetail", () => {
  test("id, count and limit unchanged", () => {
    expect(refusal(six())).toContain("DATUM-25: 6 nilai warna dalam satu gambar, maksimum 5");
  });

  test("lists every counted value with its source and the remainder", () => {
    const msg = refusal(six());
    expect(msg).toContain("dihitung 6:");
    const by = new Map([...msg.matchAll(/(#[0-9A-F]{6}) \(([^)]+)\)/g)].map((m) => [m[1], m[2]]));
    expect(by.size).toBe(6);
    expect(by.get(hex("verd"))).toContain("edge.kind verify");
    expect(by.get(hex("alert"))).toContain("mark ASUMSI");
    expect(msg).toMatch(/sisa −1\b/);
  });

  test("a figure within the limit estimates unchanged", () => {
    const s = structuredClone(CASE04);
    const e = core.estimate(s, dispatch.DIAGRAM_LAYOUTS[s.family]);
    expect(e.nColour).toBeLessThanOrEqual(5);
  });
});
