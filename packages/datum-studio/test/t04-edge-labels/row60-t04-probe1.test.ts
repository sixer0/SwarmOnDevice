// Swarm 1.2.6 row 60 (T-04, E-11 LABEL_LEADER), red probe 1 per 01g section 3.4: a 3-tier chain
// with edge labels of at most 18 characters must not draw any label with a leader line. Synthetic
// fixtures (the rev 160/182 specs of the handoff are not in the repo, research/01a). This probe was
// GREEN at BASE e363918a69, so it is recorded as CHAR `T-04-probe1` (not counted as a fix); the FIX
// red test is the L-path fixture in row60-t04-edge-labels.test.ts.
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";

useStudioEnv();

const base = (family: string, extra: Record<string, unknown>, width: number): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    family,
    id: "9.1",
    title: "Uji rantai tiga tingkat.",
    classification: "BIASA",
    width_mm: width,
    apparatus: "page",
    labels_verified: true,
    sources: ["Uji"],
    ...extra,
  }) as unknown as StudioDiagramV1;

// Labels of 15-18 characters (the acceptance bound is <= 18).
const L = ["permintaan data", "konfirmasi status", "kirim telemetri 18"];

const chains = (width: number): Record<string, StudioDiagramV1> => ({
  [`layered-single-${width}`]: base(
    "layered",
    {
      nodes: [0, 1, 2].map((t) => ({ id: `n${t}`, label: `Tingkat ${t}`, class: { tier: t } })),
      edges: [
        { from: "n0", to: "n1", kind: "data", label: L[0] },
        { from: "n1", to: "n2", kind: "data", label: L[1] },
      ],
    },
    width,
  ),
  // three parallel chains with a crossing hop between tiers 1 and 2: the geometry lint finds a
  // defect, so the fit pass (and with it the label placement of fit/labels.ts) runs.
  [`layered-triple-${width}`]: base(
    "layered",
    {
      nodes: [0, 1, 2].flatMap((t) => [0, 1, 2].map((k) => ({ id: `n${t}${k}`, label: `Simpul ${t}${k}`, class: { tier: t } }))),
      edges: [0, 1, 2].flatMap((k) => [
        { from: `n0${k}`, to: `n1${k}`, kind: "data", label: L[k] },
        { from: `n1${k}`, to: `n2${(k + 1) % 3}`, kind: "control", label: L[(k + 1) % 3] },
      ]),
    },
    width,
  ),
  [`graph-diagonal-${width}`]: base(
    "graph",
    {
      nodes: [0, 1, 2].map((r) => ({ id: `g${r}`, label: `Tingkat ${r}`, class: { col: r, row: r } })),
      edges: [
        { from: "g0", to: "g1", kind: "data", label: L[0] },
        { from: "g1", to: "g2", kind: "data", label: L[1] },
      ],
    },
    width,
  ),
});

describe("T-04 probe 1: 3-tier chain, labels <= 18 chars", () => {
  for (const width of [128, 166]) {
    for (const [name, spec] of Object.entries(chains(width))) {
      it(`${name}: LABEL_LEADER count is 0`, () => {
        for (const e of (spec as unknown as { edges: Array<{ label: string }> }).edges) expect(e.label.length).toBeLessThanOrEqual(18);
        const r = buildDiagramSvg(structuredClone(spec), { release: true });
        const leaders = (r.report.geometry ?? []).filter((g) => g.checkId === "LABEL_LEADER");
        expect(leaders).toHaveLength(0);
      });
    }
  }
});
