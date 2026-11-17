// Swarm 1.3.3 row 44 (ST-3 item 5): counts of edge-label outcomes on the 16 round-2 replay specs (R2), read-only.
// Run: R2_DIR=<.../research/replay/R2_round2_specs> bun run test/st3-edge-label-budget/r2-probe.ts
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.STUDIO_ASSETS_ROOT = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio", "assets");
process.env.STUDIO_WORKSPACE_ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "row44-ws-")));

type J = Record<string, any>;
const { buildDiagramSvgRaw } = (await import("@/lib/studio/engine/diagram/build")) as J;
const { buildDiagramSvgAuto } = (await import("@/lib/studio/engine/diagram/elk")) as J;
const { withDiagramFit } = (await import("@/lib/studio/engine/diagram/fit/state")) as J;

const DIR = process.env.R2_DIR ?? "";
const OPTS = { release: false, keyLabel: "KUNCI" };
const CODES = ["LABEL_MOVED", "LABEL_LEADER", "LABEL_NUMBERED", "LABEL_UNPLACED"];

function load(file: string): J {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const d = raw.diagram ?? raw;
  const text = (v: any) => (typeof v === "string" ? v : v?.text ?? "");
  return { $schema: "studio.diagram/v1", id: "2.1", title: text(d.caption), classification: "TERBATAS", width_mm: 166, apparatus: "page", sources: [text(d.source)], ...d.spec };
}

const texts = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

function tally(s: J, svg: string, notes: Array<{ checkId: string; detail: string }>) {
  const sha = new Bun.CryptoHasher("sha256").update(svg).digest("hex").slice(0, 16);
  const printed = texts(svg);
  const labels = (s.edges ?? []).map((e: J) => String(e.label ?? "")).filter((l: string) => l.trim());
  const missing = labels.filter((l: string) => !printed.includes(l));
  const n = (c: string) => notes.filter((x) => x.checkId === c);
  const moved = n("LABEL_MOVED").reduce((a, x) => a + Number(/^(\d+)/.exec(x.detail)?.[1] ?? 0), 0);
  return { sha, labels: labels.length, missing, moved, leader: n("LABEL_LEADER").length, numbered: n("LABEL_NUMBERED").length, unplaced: n("LABEL_UNPLACED").length, detail: [...n("LABEL_NUMBERED"), ...n("LABEL_UNPLACED")].map((x) => x.detail) };
}

const rows: J[] = [];
for (const pkt of readdirSync(DIR).sort()) {
  for (const f of readdirSync(path.join(DIR, pkt)).sort()) {
    const s = load(path.join(DIR, pkt, f));
    const row: J = { spec: `${pkt}/${f}`, family: s.family };
    for (const mode of ["fit", "auto"]) {
      try {
        if (mode === "fit") {
          const notes: any[] = [];
          const r = withDiagramFit({ notes }, () => buildDiagramSvgRaw(structuredClone(s), OPTS));
          row.fit = tally(s, r.svg, notes);
        } else {
          const r = await buildDiagramSvgAuto(structuredClone(s), OPTS);
          row.auto = tally(s, r.svg, (r.report.geometry ?? []).filter((g: J) => CODES.includes(g.checkId)));
        }
      } catch (e) {
        row[mode] = { error: String((e as Error).message).slice(0, 120) };
      }
    }
    rows.push(row);
  }
}
const sum = (mode: string, k: string) => rows.reduce((a, r) => a + (Array.isArray(r[mode]?.[k]) ? r[mode][k].length : Number(r[mode]?.[k] ?? 0)), 0);
for (const r of rows) console.log(JSON.stringify(r));
for (const mode of ["fit", "auto"]) console.log(`TOTAL ${mode}: labels ${sum(mode, "labels")} missing ${sum(mode, "missing")} moved ${sum(mode, "moved")} leader ${sum(mode, "leader")} numbered ${sum(mode, "numbered")} unplaced ${sum(mode, "unplaced")} errors ${rows.filter((r) => r[mode]?.error).length}`);
