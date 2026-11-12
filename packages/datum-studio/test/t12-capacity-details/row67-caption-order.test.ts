// Swarm 1.2.6 row 67 (routed BUG from row 28, T-01 gate): `withCaptionAbove` (D/build/svg.ts) moved the wrapped
// caption lines of an `apparatus: "figure"` SVG above the drawing in REVERSE order: `buildOnce` draws them bottom-up
// (last line first), and the move assigned the top baselines in that emission order, so the line carrying the bold
// "GAMBAR n.m" label landed below its continuation. The caption must read top-down in its own order.
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { describe, expect, it } from "bun:test";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";

const TITLE =
  "Arsitektur sistem pemantauan iklim ruang simpan arsip dengan sensor suhu dan kelembapan, gerbang data, server rekam, " +
  "dan konsol operator yang panjang sekali sehingga caption membungkus menjadi tiga baris pada lebar lembar ini.";

const spec = {
  $schema: "studio.diagram/v1",
  family: "graph",
  id: "4.1",
  title: TITLE,
  classification: "BIASA",
  width_mm: 128,
  apparatus: "figure",
  labels_verified: true,
  sources: ["Uji urutan caption"],
  nodes: [
    { id: "a", label: "Sensor", class: { col: 0, row: 0 } },
    { id: "b", label: "Gerbang", class: { col: 1, row: 0 } },
  ],
  edges: [{ from: "a", to: "b", kind: "data", label: "data" }],
} as unknown as StudioDiagramV1;

describe("row 67 (row 28 BUG): wrapped caption lines above the drawing keep their reading order", () => {
  it("the GAMBAR label line is the top caption line and the lines read in caption order", () => {
    const r = buildDiagramSvg(spec, { release: false, figureLabel: "GAMBAR" });
    const lines = [...r.svg.matchAll(/<text data-caption-above="1"[^>]*?\sy="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => ({ y: Number(m[1]), text: m[2].replace(/<[^>]+>/g, "") }));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const byY = [...lines].sort((a, b) => a.y - b.y);
    expect(byY[0].text.startsWith("GAMBAR 4.1")).toBe(true);
    const joined = byY.map((l) => l.text).join(" ").replace(/\s+/g, " ");
    expect(joined).toBe(`GAMBAR 4.1 ${TITLE}`.replace(/\s+/g, " "));
  });
});
