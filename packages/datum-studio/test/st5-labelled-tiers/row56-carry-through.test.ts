// Swarm 1.3.3 row 56, three carry-through requests in files row 56 owns:
//  (a) row 26: `services/adapt-v1/blocks.ts` `adaptDiagramSpec` carries root `tiers` (the schema-tie test
//      test/diagram-visio/rel128-vis-58b-schema-tie.test.ts is the gate; this file pins the adapter alone);
//  (b) row 53: the `KEYROW_SUPERSEDED` notice (`keyRowNotice`) reaches the compose warnings (`ComposeResult.warnings`,
//      through the new `BlockCtx.warn`), and at render an artefact-reference block reports it as a REPORT lint row;
//  (c) row 50: a capacity refusal's `details.split` survives the document render (job error `details.split`).
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { afterAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as realDocxFigures from "@/lib/studio/engine/docx/figures";

type J = Record<string, any>;

// Same pattern as test/st9-labels-verified-draft/row60-labels-verified-draft.test.ts: the store step needs the render
// bridge, so it is replaced only while this file runs; every other export stays real.
const mockOn = { active: true };
afterAll(() => {
  mockOn.active = false;
});
const realFigures = { ...realDocxFigures };
mock.module("@/lib/studio/engine/docx/figures", () => ({
  ...realFigures,
  prepareFigureStore: async (snap: any, opts: any, ...rest: any[]) => {
    if (!mockOn.active) return (realFigures.prepareFigureStore as any)(snap, opts, ...rest);
    const out: unknown[] = [];
    for (const b of snap.blocks) out.push(await opts.svgFor(b));
    return { results: out };
  },
}));

const { adaptDiagramSpec } = await import("@/lib/studio/services/adapt-v1/blocks");
const { composeV2, mapBlock } = await import("@/lib/studio/services/compose");
const { KEYROW_SUPERSEDED_MESSAGE } = await import("@/lib/studio/engine/diagram/core/sheet");
const figs = await import("@/lib/studio/services/render/figures");
const { InlineSpecReader, createDetachedJob } = await import("@/lib/studio/services/render/pure/job");
const S = await import("../ported/structure/_kit");

const t = (text: string) => ({ text });
const FLOW = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram", "dg_flow.json"), "utf8")) as J;
const AUTHORED_KEY = "Garis penuh menandai alur utama penulis.";

describe("(a) adapt-v1 carries root tiers", () => {
  const tiers = [
    { tier: 0, label: "Lapisan akses" },
    { tier: 1, label: "Lapisan inti" },
  ];
  const v1 = { $schema: "studio.diagram/v1", family: "layered", nodes: [{ id: "a", label: "A", class: { tier: 0 } }, { id: "b", label: "B", class: { tier: 1 } }] };
  const recorder = () => {
    const stripped: string[] = [];
    return {
      stripped,
      rec: { rest: (o: J, keep: string[]) => stripped.push(...Object.keys(o).filter((k) => !keep.includes(k))) } as J,
    };
  };

  test("present: the array reaches DiagramSpecV2 and is not reported as stripped", () => {
    const r = recorder();
    const out = adaptDiagramSpec({ ...v1, tiers } as never, "/x", r.rec as never) as J;
    expect(out.tiers).toEqual(tiers);
    expect(r.stripped).not.toContain("tiers");
  });

  test("absent stays absent", () => {
    const r = recorder();
    expect("tiers" in (adaptDiagramSpec(v1 as never, "/x", r.rec as never) as J)).toBe(false);
  });
});

describe("(b) KEYROW_SUPERSEDED reaches the compose warnings", () => {
  const block = (keyRow?: string) => ({
    type: "diagram",
    caption: t("Alur uji kunci."),
    source: t("Sumber sintetis uji."),
    ...(keyRow ? { keyRow: t(keyRow) } : {}),
    spec: { family: FLOW.family, labels_verified: true, nodes: FLOW.nodes, edges: FLOW.edges, legend: FLOW.legend },
  });

  test("mapBlock: an authored keyRow beside legend[] calls BlockCtx.warn once with KEYROW_SUPERSEDED", () => {
    const seen: J[] = [];
    mapBlock(block(AUTHORED_KEY) as never, "p1", { glyphs: new Set<string>(), params: {}, classification: "", warn: (w: J) => seen.push(w) } as never);
    expect(seen.map((w) => w.code)).toEqual(["KEYROW_SUPERSEDED"]);
    expect(seen[0].message).toContain(KEYROW_SUPERSEDED_MESSAGE);
    expect(seen[0].message).toContain("p1");
  });

  test("mapBlock: no keyRow, or no warn channel: nothing reported, nothing thrown", () => {
    const seen: J[] = [];
    mapBlock(block() as never, "p1", { glyphs: new Set<string>(), params: {}, classification: "", warn: (w: J) => seen.push(w) } as never);
    expect(seen).toEqual([]);
    expect(() => mapBlock(block(AUTHORED_KEY) as never, "p1", { glyphs: new Set<string>(), params: {}, classification: "" } as never)).not.toThrow();
  });

  test("document compose (composeV2): the notice is in ComposeResult.warnings, named by the figure label", () => {
    const slots = S.datumSlots();
    const doc = S.e1();
    doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf sebelum figur." }, block(AUTHORED_KEY)];
    const { template: _t, ...sub } = doc;
    const r = composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }) as J;
    const hits = (r.warnings as J[]).filter((w) => w.code === "KEYROW_SUPERSEDED");
    expect(hits.length).toBe(1);
    expect(hits[0].message).toContain("Gambar 1.1");
    expect(hits[0].message).toContain(KEYROW_SUPERSEDED_MESSAGE);
  });
});

/** A layered spec that is too tall at 166 mm (8 tiers; row 36: limit 6), so the refusal carries `details.split`. */
const TALL = {
  $schema: "studio.diagram/v1",
  family: "layered",
  id: "3.1",
  title: "Delapan tingkat.",
  classification: "BIASA",
  width_mm: 166,
  apparatus: "page",
  labels_verified: true,
  sources: ["Uji row 56"],
  nodes: Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, label: `Simpul ${i}`, class: { tier: Math.floor(i / 2) } })),
  edges: Array.from({ length: 14 }, (_, i) => ({ from: `n${i}`, to: `n${i + 2}`, kind: "data", label: "data" })),
};

async function build(blocks: J[], reader = new InlineSpecReader({})) {
  const job = createDetachedJob(["HTML"]);
  const snapshot = { doc: { meta: { issueDate: "2026-11-17", tier: "NOTA" } }, numbering: { b1: "Gambar 3.1" }, blocks };
  const r = await figs.buildFigures({ snapshot, tpl: { params: {} }, tier: "NOTA", job, reader } as never);
  return { r, job };
}

describe("(c) details.split survives the document render", () => {
  test("the capacity refusal at render carries details.split on the job error and names it in the message", async () => {
    const { job } = await build([{ blockId: "b1", type: "diagram", content: { spec: TALL }, address: "3.1.1", unitKey: "3" }]);
    const errs = (job as J).errors as J[];
    expect(errs.length).toBe(1);
    expect(errs[0].code).toBe("FIGURE_OVER_CAPACITY");
    expect(errs[0].message).toContain("Gambar 3.1");
    expect(errs[0].message).toContain(figs.RENDER_SPLIT_NOTE);
    const split = errs[0].details?.split as J;
    expect(split).toBeDefined();
    expect(Array.isArray(split.specs) || Array.isArray(split.parts) || typeof split === "object").toBe(true);
    // the job's persisted engine JSON (what the DTO's `errors` is read from) keeps it
    const eng = JSON.parse(JSON.stringify((job as J).engineJson?.() ?? { errors: errs })) as J;
    expect(eng.errors[0].details.split).toEqual(JSON.parse(JSON.stringify(split)));
  });

  test("the same split as the engine's own refusal (preview path)", async () => {
    const { buildDiagramSvg } = await import("@/lib/studio/engine/diagram/build");
    let engineSplit: unknown;
    try {
      buildDiagramSvg(TALL as never, { release: false } as never);
    } catch (e) {
      engineSplit = (e as J).details?.split;
    }
    expect(engineSplit).toBeDefined();
    const { job } = await build([{ blockId: "b1", type: "diagram", content: { spec: TALL }, address: "3.1.1", unitKey: "3" }]);
    expect(JSON.stringify(((job as J).errors as J[])[0].details.split)).toBe(JSON.stringify(engineSplit));
  });

  test("a refusal without a split keeps the earlier message and has no details", async () => {
    const bad = { ...TALL, nodes: TALL.nodes.slice(0, 2).map((n) => ({ ...n, class: { tier: 0 } })), edges: [], tiers: [{ tier: 5, label: "Kosong" }] };
    const { job } = await build([{ blockId: "b1", type: "diagram", content: { spec: bad }, address: "3.1.1", unitKey: "3" }]);
    const errs = (job as J).errors as J[];
    expect(errs.length).toBe(1);
    expect(errs[0].message).not.toContain(figs.RENDER_SPLIT_NOTE);
    expect(errs[0].details).toBeUndefined();
  });
});

describe("(b) at render: an artefact-reference block reports KEYROW_SUPERSEDED", () => {
  const ART = { ...FLOW, labels_verified: true };
  test("authored keyRow + artefact legend[]: one REPORT row KEYROW_SUPERSEDED in the figure checks", async () => {
    const reader = new InlineSpecReader({ "art-1": { kind: "DIAGRAM", spec: ART } } as never);
    const { r } = await build([{ blockId: "b1", type: "diagram", content: { spec: { artifactId: "art-1" }, keyRow: { runs: [{ t: "KUNCI  " }, { t: AUTHORED_KEY }] } }, address: "3.1.1", unitKey: "3" }], reader);
    const rows = (r.extra as J[]).filter((x) => x.checkId === "KEYROW_SUPERSEDED");
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("REPORT");
    expect(rows[0].detail).toContain(KEYROW_SUPERSEDED_MESSAGE);
    expect(r.awaitingHumanCheck).toEqual([]); // not a human check: the draft state is unchanged
  });

  test("no authored keyRow: no notice", async () => {
    const reader = new InlineSpecReader({ "art-1": { kind: "DIAGRAM", spec: ART } } as never);
    const { r } = await build([{ blockId: "b1", type: "diagram", content: { spec: { artifactId: "art-1" } }, address: "3.1.1", unitKey: "3" }], reader);
    expect((r.extra as J[]).filter((x) => x.checkId === "KEYROW_SUPERSEDED")).toEqual([]);
  });
});
