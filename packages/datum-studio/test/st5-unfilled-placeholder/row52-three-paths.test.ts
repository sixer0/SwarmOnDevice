// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 52 (ST-5): ONE fixture through the three paths. Preview (the figure preview's engine call), document
// lint (structure lint, and the report the render writes) and render (the figure build of a render job) refuse the
// same unfilled `{{key}}` with the same id, field and token; the filled fixture passes all three.
import { useStudioEnv } from "../ported/_env"; useStudioEnv();
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realDocxFigures from "@/lib/studio/engine/docx/figures";
import { LINT_REGISTRY } from "@/lib/studio/registry/lint";
import { defaultEnforcement } from "@/lib/studio/engine/lint/structure/enforcement";
import { STRUCTURE_CHECKS, lintStructureWith, structureCoverageGaps } from "@/lib/studio/engine/lint/structure";
import { lintAfterRender, releaseFor } from "@/lib/studio/services/render/lint";
import { splitSkeletonOf } from "@/lib/studio/engine/diagram/build/capacity";
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures";
import * as preview from "../../src/mcp-host/local-api/routes/figure-preview-figure";

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
const figs = await import("@/lib/studio/services/render/figures");
const { InlineSpecReader, createDetachedJob } = await import("@/lib/studio/services/render/pure/job");

const ID = "PLACEHOLDER_UNFILLED";
const TOKEN = "{{dems.pengguna}}";
const FIELD = "/nodes/1/sub";
const TIERS = ["NOTA", "TERBIT", "SERAH"] as const;
const LOG = { info() {}, warn() {}, error() {} } as never;

/** The fixture: the R3 form (`{{dems.pengguna}} orang` as a node sub line), or the same spec filled. */
const spec = (sub: string, id = "9.1") => ({
  $schema: "studio.diagram/v1",
  family: "flow",
  id,
  title: "Alur uji.",
  classification: "BIASA",
  width_mm: 166,
  apparatus: "page",
  labels_verified: true,
  sources: ["Uji row 52"],
  nodes: [
    { id: "a", label: "Gudang utama", class: { col: 0, row: 0 } },
    { id: "b", label: "Penyidik", sub, class: { col: 0, row: 1 } },
  ],
  edges: [{ from: "a", to: "b", kind: "data", label: "kirim" }],
});
const UNFILLED = `${TOKEN} orang`;
const FILLED = "120 orang";
const block = (s: unknown) => ({ type: "diagram", caption: { inline: { text: "Alur uji gudang." } }, source: { inline: { text: "SUMBER uji internal." } }, spec: s });
let KAN: any;
beforeAll(() => {
  KAN = canonicalTemplate();
});

const previewOf = (s: unknown) =>
  preview.renderResolved({ block: { blockId: "b52", address: "6.1", type: "diagram", content: {} } as never, type: "diagram", spec: s as never }, { params: {} } as never, { inline: true, withSvg: true, lang: "ID" });
const lintOf = (s: unknown, tier: string) => lintStructureWith(snapshotOf(makeDoc({ tier, blocks: [block(s)] })), KAN, tier as never, { only: [ID] });
async function renderOf(s: unknown, tier: string) {
  const job = createDetachedJob(["HTML"]);
  const snapshot = { doc: { meta: { issueDate: "2026-11-17", tier } }, numbering: {}, blocks: [{ blockId: "b1", type: "diagram", content: { spec: s }, address: "6.1.1", unitKey: "6" }] };
  const r = await figs.buildFigures({ snapshot, tpl: { params: {} }, tier, job, reader: new InlineSpecReader({}) } as never);
  return { r, job };
}

describe("row 52: the registry row and its check land together", () => {
  test("registry: PLACEHOLDER_UNFILLED once, group D, structure, build, all tiers, release-blocking, never blocks ingest", () => {
    const rows = LINT_REGISTRY.filter((d) => d.id === ID);
    expect(rows).toHaveLength(1);
    const d = rows[0];
    expect([d.group, d.module, d.stage, d.blocksIngest, [...d.tiers], d.notRunReason]).toEqual(["D", "structure", "build", false, [...TIERS], undefined]);
    expect(d.limit).toBe("0 {{kunci}} belum terisi");
    expect(defaultEnforcement(d)).toBe("release");
  });
  test("the structure check exists (no coverage gap)", () => {
    expect(typeof STRUCTURE_CHECKS[ID]).toBe("function");
    expect(structureCoverageGaps()).toEqual([]);
  });
});

describe("row 52: one unfilled fixture, three paths, one answer", () => {
  test("preview: refused (no figure, no SVG) with PLACEHOLDER_UNFILLED, the field and the token", async () => {
    let e: any;
    try {
      await previewOf(spec(UNFILLED));
    } catch (err) {
      e = err;
    }
    // figure-preview.ts returns `{ rendered: false, error: { code, message, details } }` from exactly these fields.
    expect(e?.code).toBe("BY_CONSTRUCTION_FAILED");
    expect(e.details).toEqual({ checkId: ID, pointer: FIELD });
    expect(e.message).toContain(`${TOKEN} di ${FIELD}`);
  });

  for (const tier of TIERS) {
    test(`document lint at ${tier}: FAIL, pointer to the field, detail names the token; release FAIL`, () => {
      const out = lintOf(spec(UNFILLED), tier);
      expect(out.map((i) => `${i.checkId}:${i.status}`)).toEqual([`${ID}:FAIL`]);
      expect(out[0].pointer!.endsWith(`/spec${FIELD}`)).toBe(true);
      expect(out[0].detail).toContain(TOKEN);
      expect(out[0].detail).toContain(`spec${FIELD}`);
      expect(releaseFor(out, tier as never)).toBe("FAIL");
    });

    test(`render at ${tier}: the figure is not built (job error names id, field, token), and the lint report of the render fails on the same id`, async () => {
      const { r, job } = await renderOf(spec(UNFILLED), tier);
      expect(r.svgs).toHaveLength(0); // nothing drawn: the token cannot reach a file
      const errors = (job.errors ?? []) as Array<{ code: string; message: string }>;
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("BY_CONSTRUCTION_FAILED");
      expect(errors[0].message).toContain(ID);
      expect(errors[0].message).toContain(`${TOKEN} di ${FIELD}`);
      const lint = lintAfterRender({ snapshot: snapshotOf(makeDoc({ tier, blocks: [block(spec(UNFILLED))] })), tpl: KAN, tier, svgs: r.svgs, extra: r.extra, log: LOG } as never);
      const rows = lint.checks.filter((c) => c.checkId === ID);
      expect(rows.map((c) => c.status)).toEqual(["FAIL"]);
      expect(rows[0].detail).toContain(TOKEN);
      expect(lint.releaseStatus).toBe("FAIL");
    });
  }

  test("the filled fixture passes the three paths", async () => {
    const p = await previewOf(spec(FILLED));
    expect(p.defects).toEqual([]);
    expect(p.svg).toContain("120 orang");
    expect(p.svg).not.toContain("{{");
    for (const tier of TIERS) {
      expect(lintOf(spec(FILLED), tier)).toEqual([{ checkId: ID, status: "PASS", detail: "1 diagram tanpa penanda {{kunci}} yang belum terisi" }]);
      const { r, job } = await renderOf(spec(FILLED), tier);
      expect(job.errors ?? []).toEqual([]);
      expect(r.svgs).toHaveLength(1);
      const lint = lintAfterRender({ snapshot: snapshotOf(makeDoc({ tier, blocks: [block(spec(FILLED))] })), tpl: KAN, tier, svgs: r.svgs, extra: r.extra, log: LOG } as never);
      expect(lint.checks.filter((c) => c.checkId === ID).map((c) => c.status)).toEqual(["PASS"]);
    }
  });

  test("a document without a diagram: PASS at every tier (the check runs at NOTA too)", () => {
    for (const tier of TIERS) {
      const out = lintStructureWith(snapshotOf(makeDoc({ tier })), KAN, tier as never, { only: [ID] });
      expect(out).toEqual([{ checkId: ID, status: "PASS", detail: "0 diagram tanpa penanda {{kunci}} yang belum terisi" }]);
    }
  });

  test("two figures, three tokens: one FAIL per token, each with its own pointer", () => {
    const two = spec(UNFILLED, "9.2");
    two.title = "Alur {{sistem}}.";
    const out = lintStructureWith(snapshotOf(makeDoc({ tier: "TERBIT", blocks: [block(spec(UNFILLED)), block(two)] })), KAN, "TERBIT", { only: [ID] });
    expect(out.map((i) => i.status)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(out.map((i) => i.pointer!.replace(/^.*\/spec/, "")).sort()).toEqual([FIELD, FIELD, "/title"].sort());
    expect(new Set(out.map((i) => i.pointer)).size).toBe(3);
  });
});

describe("row 52: the split skeleton placeholders (row 51) through the three paths", () => {
  const wide = {
    ...spec(FILLED),
    family: "graph",
    width_mm: 128,
    nodes: Array.from({ length: 7 }, (_, i) => ({ id: `g${i + 1}`, label: `Simpul ${i + 1}`, class: { col: i, row: 0 } })),
    edges: Array.from({ length: 6 }, (_, i) => ({ from: `g${i + 1}`, to: `g${i + 2}`, kind: "data", label: "alir" })),
  };
  test("part 1 left unfilled: preview, lint and render all name PLACEHOLDER_UNFILLED and {{id_blok_bagian_2}} at ref.figure", async () => {
    const part = splitSkeletonOf(wide as never)!.specs[0] as any;
    const token = "{{id_blok_bagian_2}}";
    let e: any;
    try {
      await previewOf(part);
    } catch (err) {
      e = err;
    }
    expect(e?.details?.checkId).toBe(ID);
    expect(e.details.pointer).toMatch(/^\/nodes\/\d+\/ref\/figure$/);
    expect(e.message).toContain(token);
    const out = lintOf(part, "TERBIT");
    expect(out.every((i) => i.checkId === ID && i.status === "FAIL")).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    for (const i of out) expect(i.pointer).toMatch(/\/spec\/nodes\/\d+\/ref\/figure$/);
    const { r, job } = await renderOf(part, "TERBIT");
    expect(r.svgs).toHaveLength(0);
    expect((job.errors ?? [])[0].message).toContain(token);
  });
});
