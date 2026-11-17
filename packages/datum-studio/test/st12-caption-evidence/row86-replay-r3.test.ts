// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 86 (ST-12): replay of the 33 round-1 records (R3, read from SWARM_REPLAY_DIR/R3_round1_specs; row 146: skipped when the variable is unset). The ten figures whose caption the
// round-1 review found unproven are listed in the gap matrix N14 (handoff/diagram_standard/01_gap_matrix.md:408):
// p1 1.2, 1.3; p2 1.1, 1.4; p3 3.2, 4.1; p4 18.2, 21.1; p5 1.2, 1.6. Which of them D23 catches, and every warning D23
// gives on R3, are pinned here so a change in precision is visible.
import { useStudioEnv } from "../ported/_env"; useStudioEnv();
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { lintStructureWith } from "@/lib/studio/engine/lint/structure";
import { judgeCaption } from "@/lib/studio/engine/lint/structure/checks-caption";
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures";
import { replayInputs } from "../replay-dir";

const REPLAY = replayInputs("row 86 replay R3", ["R3_round1_specs"] as const);
const R3 = REPLAY.paths[0];
const files = !REPLAY.present ? [] : readdirSync(R3).flatMap((d) => readdirSync(path.join(R3, d)).filter((f) => f.endsWith(".json")).map((f) => `${d}/${f}`)).sort();
const rawOf = (f: string) => JSON.parse(readFileSync(path.join(R3, f), "utf8"));
/** {caption, spec, keyRow} of a record; the p5 chart record ({chart, riwayat}) carries caption and data in `chart`. */
const recOf = (f: string) => {
  const r = rawOf(f);
  return r.chart ? { caption: r.chart.caption, spec: r.chart, keyRow: "" } : { caption: r.caption.text, spec: r.spec, keyRow: r.keyRow?.text ?? "" };
};
const missing = (f: string) => { const r = recOf(f); return judgeCaption(r.caption, r.spec, r.keyRow).filter((x) => !x.found).map((x) => x.claim.text); };

// Gap matrix N14 -> R3 file (p1/p2/p5 numbered 1..6 in figure order, p3/p4 by figure number).
const N14: Record<string, string> = {
  "p1 1.2": "p1-jaringan-komputasi/2.json",
  "p1 1.3": "p1-jaringan-komputasi/3.json",
  "p2 1.1": "p2-serat-daya/1.json",
  "p2 1.4": "p2-serat-daya/4.json",
  "p3 3.2": "p3-video-keamanan/3.2.json",
  "p3 4.1": "p3-video-keamanan/4.1.json",
  "p4 18.2": "p4-perangkat-lunak-data-ai/18.2.json",
  "p4 21.1": "p4-perangkat-lunak-data-ai/21.1.json",
  "p5 1.2": "p5-siber-proses/2.json",
  "p5 1.6": "p5-siber-proses/6.json",
};
// Every D23 warning on R3, claim by claim (implementation/86 section 5 judges each).
const WARNINGS: Record<string, string[]> = {
  "p1-jaringan-komputasi/2.json": ["VRF"],
  "p1-jaringan-komputasi/5.json": ["J05"],
  "p2-serat-daya/1.json": ["384", "400"],
  "p2-serat-daya/2.json": ["22,06", "29"],
  "p3-video-keamanan/3.1.json": ["208"],
  "p3-video-keamanan/3.2.json": ["685"],
  "p5-siber-proses/1.json": ["Ops"],
  "p5-siber-proses/2.json": ["FIDO2"],
  "p5-siber-proses/6.json": ["27"],
};

describe.skipIf(!REPLAY.present)("row 86: replay R3 (33 round-1 records)", () => {
  test("33 records read", () => expect(files).toHaveLength(33));
  test("gap matrix N14: 5 of the 10 trigger D23 (p1 1.2, p2 1.1, p3 3.2, p5 1.2, p5 1.6); the other 5 are quiet", () => {
    const fired = Object.entries(N14).filter(([, f]) => missing(f).length > 0).map(([k]) => k);
    expect(fired).toEqual(["p1 1.2", "p2 1.1", "p3 3.2", "p5 1.2", "p5 1.6"]);
  });
  test("every warning on R3, pinned (9 figures, 11 claims)", () => {
    const all: Record<string, string[]> = {};
    for (const f of files) { const m = missing(f); if (m.length) all[f] = m; }
    expect(all).toEqual(WARNINGS);
  });
  test("document path: the 32 diagram records through lintStructureWith give the same figures", () => {
    const KAN = canonicalTemplate();
    const got: string[] = [];
    for (const f of files) {
      const r = rawOf(f);
      if (!r.spec) continue;
      const block = {
        type: "diagram",
        caption: { inline: { text: r.caption.text } },
        source: { inline: { text: r.source.text } },
        ...(r.keyRow ? { keyRow: { text: r.keyRow.text } } : {}),
        spec: { $schema: "studio.diagram/v1", id: "1.1", title: r.caption.text, width_mm: 166, ...r.spec, sources: [r.source.text], apparatus: "page" },
      };
      const out = lintStructureWith(snapshotOf(makeDoc({ tier: "TERBIT", blocks: [block] })), KAN, "TERBIT", { only: ["D23"] });
      expect(out.every((i) => i.status === "PASS" || i.status === "REPORT")).toBe(true);
      if (out.some((i) => i.status === "REPORT")) got.push(f);
    }
    expect(got).toEqual(Object.keys(WARNINGS).filter((f) => f !== "p5-siber-proses/6.json"));
  });
});
