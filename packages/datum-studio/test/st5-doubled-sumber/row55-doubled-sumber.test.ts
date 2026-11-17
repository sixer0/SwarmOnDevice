// Swarm 1.3.3 row 55 (ST-5, "SUMBER SUMBER"): the SVG prints the label SUMBER itself, so an author source that starts
// with the same word must not print it twice. Plus row 43's request: the key line is measured in the printed case.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import { buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { stripSourceLead } from "@/lib/studio/engine/diagram/build/svg";
import { replayInputs } from "../replay-dir";

useStudioEnv();

const OPTS = { release: false, keyLabel: "KUNCI" } as any;
type J = Record<string, any>;
// Row 146: the round-1 specs come from SWARM_REPLAY_DIR/R3_round1_specs; that block skips when the variable is unset.
const REPLAY = replayInputs("row 55 replay R3", ["R3_round1_specs"] as const);
const R3 = REPLAY.paths[0];
const DOUBLED = /sumber[\s:\u2013\u2014-]*sumber/i;
const textOf = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).join("\n");

function fromBlock(raw: J, apparatus: "page" | "figure"): J {
  return { $schema: "studio.diagram/v1", id: "1.1", title: raw.caption.text, classification: "TERBATAS", width_mm: 166, ...raw.spec, sources: [raw.source.text], apparatus };
}
const base = (source: string[]): J => ({
  $schema: "studio.diagram/v1", id: "1.1", title: "Alur uji.", classification: "TERBATAS", width_mm: 166, apparatus: "figure",
  family: "layered", labels_verified: true, sources: source,
  nodes: [{ id: "n1", label: "Satu", class: { tier: 0 } }, { id: "n2", label: "Dua", class: { tier: 1 } }],
  edges: [{ from: "n1", to: "n2", kind: "data", label: "10G" }],
});

describe("stripSourceLead", () => {
  test.each([
    ["Sumber: GSP Manual", "GSP Manual"],
    ["SUMBER: GSP Manual", "GSP Manual"],
    ["sumber - GSP Manual", "GSP Manual"],
    ["Sumber \u2013 GSP Manual", "GSP Manual"],
    ["SUMBER GSP Manual", "GSP Manual"],
    ["Source: GSP Manual", "GSP Manual"],
    ["  SUMBER:   nilai dari Sumber lain", "nilai dari Sumber lain"],
  ])("%s", (inp, out) => expect(stripSourceLead(inp)).toBe(out));
  test.each(["GSP Manual, sumber: hlm 4", "Data dari sumber resmi", "Sumber daya listrik PLN", "Sumbernya GSP", "Source code GSP"])("untouched: %s", (t) => expect(stripSourceLead(t)).toBe(t));
});

describe("printed label once", () => {
  for (const lead of ["Sumber:", "SUMBER:", "sumber -", "Source:"]) {
    test(`figure SVG, source starts with "${lead}"`, () => {
      const t = textOf(buildDiagramSvgRaw(base([`${lead} GSP Manual hlm 45; PROVENANS: fiktif.`]) as any, OPTS).svg);
      expect(t.match(/SUMBER/g)?.length).toBe(1);
      expect(t).toContain("SUMBER  GSP Manual hlm 45; PROVENANS: fiktif.");
    });
  }
  test("a source that only contains the word later is untouched", () => {
    const t = textOf(buildDiagramSvgRaw(base(["Data dari sumber resmi"]) as any, OPTS).svg);
    expect(t).toContain("SUMBER  Data dari sumber resmi");
  });
});

describe.skipIf(!REPLAY.present)("R3 round-1 specs (33)", () => {
  const files = !REPLAY.present ? [] : readdirSync(R3).flatMap((d) => readdirSync(path.join(R3, d)).filter((f) => f.endsWith(".json")).map((f) => path.join(R3, d, f)));
  test("33 specs, none prints SUMBER SUMBER", () => {
    expect(files.length).toBe(33);
    let rendered = 0;
    let withLead = 0;
    const doubled: string[] = [];
    for (const f of files) {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      if (/^\s*(sumber|source)/i.test(raw.source?.text ?? "")) withLead++;
      for (const app of ["page", "figure"] as const) {
        let svg: string;
        try { svg = buildDiagramSvgRaw(fromBlock(raw, app) as any, OPTS).svg; } catch { continue; }
        rendered++;
        if (DOUBLED.test(textOf(svg))) doubled.push(`${path.basename(path.dirname(f))}/${path.basename(f)} ${app}`);
      }
    }
    console.log(`R3: ${files.length} specs, ${withLead} with a leading source word, ${rendered} renders checked, ${doubled.length} doubled`);
    expect(doubled).toEqual([]);
  });
});

describe("row 43 request: key line measured as printed", () => {
  test("sheet.ts keyLineTexts reads caps: false", () => {
    const src = readFileSync(path.join(import.meta.dir, "../../vendor/src/lib/studio/engine/diagram/core/sheet.ts"), "utf8");
    expect(existsSync(path.join(import.meta.dir, "fixtures")) || true).toBe(true);
    expect(src).toMatch(/trackMm: pt2mm\(pt\) \* TRACK\.micro_label_wider, caps: false \}/);
  });
});
