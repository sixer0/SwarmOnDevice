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

/**
 * The six-colour guard of row124-svg.test.ts was a verify edge (verd) plus an ASUMSI glyph (alert) on CASE04: six
 * printed values, of which three are ink greys and one is printed only by the mark. Swarm 1.3.3 rows 57/157 (ST-6):
 * DATUM-25 now counts that figure as 2 (`tinta`, verd), so it no longer reaches the refusal. With today's tokens no
 * diagram spec can count more than 4 (`tinta`, signal, alert, verd: the edge kinds, marks and the 41 library symbols
 * print nothing else), so the refusal is a guard for new fill colours. `six()` therefore keeps the ASUMSI mark and adds
 * an accent edge (signal), an alert edge (alert: an edge source as well as the mark, so it counts), the verify edge
 * (verd), and gives the data and control kinds two new fill colours for the duration of one call (`withNewFills`):
 * tinta + 5 fill/accent colours = 6 counted, limit 5.
 */
const six = (): any => {
  const s = structuredClone(CASE04);
  s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
  s.legend.push("ASUMSI = asumsi retensi");
  s.edges[4].kind = "verify";
  s.edges[0].kind = "accent";
  s.edges[1].kind = "alert";
  return s;
};

const NEW_FILLS = { data: ["test_fill_a", "#5A3E8C"], control: ["test_fill_b", "#1F6FB2"] } as const;
/** Two fill colours that no token has today, on the data and control kinds; restored after `fn`. */
const withNewFills = <T>(fn: () => T): T => {
  const interior = tokens.INTERIOR as Record<string, string>;
  const kinds = tokens.EDGE_KINDS as Record<string, { colour: string }>;
  const saved = Object.keys(NEW_FILLS).map((k) => [k, kinds[k].colour] as const);
  try {
    for (const [kind, [tok, value]] of Object.entries(NEW_FILLS)) {
      interior[tok] = value;
      kinds[kind].colour = tok;
    }
    return fn();
  } finally {
    for (const [k, c] of saved) kinds[k].colour = c;
    for (const [tok] of Object.values(NEW_FILLS)) delete interior[tok];
  }
};

const refusal = (s: any): string => {
  try {
    withNewFills(() => core.estimate(s, dispatch.DIAGRAM_LAYOUTS[s.family]));
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
    // Row 157 (ST-6): the ink greys are one counted entry, `tinta (<greys>: <sources>)`; every other counted entry is
    // `#HEX (<sources>)`. Together they are the 6 counted.
    const by = new Map([...msg.matchAll(/(#[0-9A-F]{6}) \(([^)]+)\)/g)].map((m) => [m[1], m[2]]));
    expect(by.size).toBe(5);
    expect(msg).toMatch(new RegExp(`dihitung 6: tinta \\(${hex("ink900")}[^)]*: [^)]*label simpul`));
    expect(by.get(hex("verd"))).toContain("edge.kind verify");
    expect(by.get(hex("signal"))).toContain("edge.kind accent");
    expect(by.get(hex("alert"))).toContain("edge.kind alert");
    expect(by.get(hex("alert"))).toContain("mark ASUMSI");
    expect(by.get(NEW_FILLS.data[1])).toContain("edge.kind data");
    expect(by.get(NEW_FILLS.control[1])).toContain("edge.kind control");
    expect(msg).toMatch(/sisa −1\b/);
  });

  test("row 157: the former six (three greys, verd, and a value printed only by a mark) estimates within the limit", () => {
    const s = structuredClone(CASE04);
    s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
    s.legend.push("ASUMSI = asumsi retensi");
    s.edges[4].kind = "verify";
    const e = core.estimate(s, dispatch.DIAGRAM_LAYOUTS[s.family]);
    expect(e.nColour).toBe(6); // printed values keep their meaning
  });

  test("row 157: the token extension is undone after each call", () => {
    refusal(six());
    expect((tokens.EDGE_KINDS as any).data.colour).toBe("ink900");
    expect((tokens.EDGE_KINDS as any).control.colour).toBe("ink700");
    expect((tokens.INTERIOR as any).test_fill_a).toBeUndefined();
    expect((tokens.INTERIOR as any).test_fill_b).toBeUndefined();
  });

  test("a figure within the limit estimates unchanged", () => {
    const s = structuredClone(CASE04);
    const e = core.estimate(s, dispatch.DIAGRAM_LAYOUTS[s.family]);
    expect(e.nColour).toBeLessThanOrEqual(5);
  });
});
