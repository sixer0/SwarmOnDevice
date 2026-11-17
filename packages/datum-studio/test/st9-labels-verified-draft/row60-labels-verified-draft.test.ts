// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 60 (ST-9 item 2, owner decision U20): `labels_verified` false or absent is neither a preview defect
// nor a lint failure; the document is a draft that waits for a person (`awaitingHumanCheck`).
import { useStudioEnv } from "../ported/_env"; useStudioEnv();
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realDocxFigures from "@/lib/studio/engine/docx/figures";
import { LINT_REGISTRY } from "@/lib/studio/registry/lint";
import { defaultEnforcement } from "@/lib/studio/engine/lint/structure/enforcement";
import { lintStructureWith } from "@/lib/studio/engine/lint/structure";
import { diagramLabelsUnchecked } from "@/lib/studio/engine/lint/structure/checks-d";
import { lintAfterRender, releaseFor } from "@/lib/studio/services/render/lint";
import { canonicalTemplate, makeDoc, snapshotOf, statuses } from "../ported/engine-core/fixtures";
import * as preview from "../../src/mcp-host/local-api/routes/figure-preview-figure";
import { checkLint } from "../../src/mcp-host/verify/static-checks";

// Same pattern as test/ported/figures/secfix-render-capacity.test.ts (row42 W10): the store step needs the render
// bridge, so it is replaced only while this file runs; every other export stays real.
const mockOn = { active: true };
afterAll(() => {
  mockOn.active = false;
});
// The real exports are copied BEFORE the mock is installed: the namespace import is live and would otherwise
// point at the replacement (a call through it after this file would recurse).
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

const MARK_ID = "label belum diperiksa manusia";
const MARK_EN = "labels not yet checked by a person";

const spec = (flag: boolean | undefined, id = "9.1") => ({
  $schema: "studio.diagram/v1",
  family: "flow",
  id,
  title: "Alur uji.",
  classification: "BIASA",
  width_mm: 166,
  apparatus: "page",
  ...(flag === undefined ? {} : { labels_verified: flag }),
  sources: ["Uji row 60"],
  nodes: [
    { id: "a", label: "Gudang utama", class: { col: 0, row: 0 } },
    { id: "b", label: "Pemeriksaan mutu", class: { col: 0, row: 1 } },
  ],
  edges: [{ from: "a", to: "b", kind: "data", label: "kirim" }],
});
const block = (flag: boolean | undefined, id = "9.1") => ({
  type: "diagram",
  caption: { inline: { text: "Alur uji gudang." } },
  source: { inline: { text: "SUMBER uji internal." } },
  spec: spec(flag, id),
});
const FLAGS: Array<[string, boolean | undefined]> = [["false", false], ["absent", undefined]];
const LOG = { info() {}, warn() {}, error() {} } as never;
let KAN: any;
beforeAll(() => {
  KAN = canonicalTemplate();
});

async function build(tier: string, flags: Array<boolean | undefined>) {
  const job = createDetachedJob(["HTML"]);
  const blocks = flags.map((f, n) => ({ blockId: `b${n + 1}`, type: "diagram", content: { spec: spec(f, `9.${n + 1}`) }, address: `6.1.${n + 1}`, unitKey: "6" }));
  const snapshot = { doc: { meta: { issueDate: "2026-11-17", tier } }, numbering: {}, blocks };
  const r = await figs.buildFigures({ snapshot, tpl: { params: {} }, tier, job, reader: new InlineSpecReader({}) } as never);
  return { r, job };
}

describe("row 60 (a): preview of a figure whose labels are not verified", () => {
  for (const [name, flag] of FLAGS) {
    test(`labels_verified ${name}: no defect; the result says the labels are not yet checked by a person`, async () => {
      const p = await preview.renderResolved(
        { block: { blockId: "b60", address: "6.1", type: "diagram", content: {} } as never, type: "diagram", spec: spec(flag) as never },
        { params: {} } as never,
        { inline: true, withSvg: false, lang: "ID" },
      );
      expect(p.defects).toEqual([]);
      const n = p.notices.filter((i) => i.checkId === "P1-labels_verified");
      expect(n).toHaveLength(1);
      expect(n[0].status).not.toBe("FAIL");
      expect(n[0].detail).toContain(MARK_ID);
      expect(n[0].detail).toContain(MARK_EN);
      expect(n[0].detail).toContain("bukan cacat");
      expect(n[0].suggest).toContain("jangan mengirim labels_verified: true");
      expect(n[0].info).toBe(true);
      expect(p.layoutIssueCount).toBe(0);
      expect(p.awaitingHumanCheck).toEqual(["labels_verified"]);
    });
  }

  test("labels_verified true: as before (no issue, no awaitingHumanCheck key)", async () => {
    const p = await preview.renderResolved(
      { block: { blockId: "b60", address: "6.1", type: "diagram", content: {} } as never, type: "diagram", spec: spec(true) as never },
      { params: {} } as never,
      { inline: true, withSvg: false, lang: "ID" },
    );
    expect(p.issues).toEqual([]);
    expect(p.notices).toEqual([]);
    expect(p.defects).toEqual([]);
    expect("awaitingHumanCheck" in p).toBe(false);
  });

  test("class table: P1-labels_verified and ZONE_LABEL_CLAMP are notices; a FAIL stays a defect", () => {
    expect(preview.previewIssueClass("P1-labels_verified", "NOT_RUN")).toBe("notice");
    expect(preview.previewIssueClass("P1-labels_verified", "REPORT")).toBe("notice");
    expect(preview.previewIssueClass("ZONE_LABEL_CLAMP", "REPORT")).toBe("notice");
    expect(preview.PREVIEW_ISSUE_CLASS.ZONE_LABEL_CLAMP).toBe("notice");
    expect(preview.previewIssueClass("ZONE_LABEL_CLAMP", "FAIL")).toBe("defect");
    expect(preview.previewIssueClass("P1-labels_verified", "FAIL")).toBe("defect");
    // unchanged neighbours
    expect(preview.previewIssueClass("LABEL_MOVED", "REPORT")).toBe("notice");
    expect(preview.previewIssueClass("LABEL_LEADER", "REPORT")).toBe("notice");
    expect(preview.previewIssueClass("TEXT_OUTSIDE", "REPORT")).toBe("defect");
    const split = preview.splitPreviewIssues([
      { checkId: "ZONE_LABEL_CLAMP", status: "REPORT" },
      { checkId: "P1-labels_verified", status: "NOT_RUN" },
      { checkId: "TEXT_OUTSIDE", status: "REPORT" },
    ]);
    expect(split.notices.map((i) => i.checkId)).toEqual(["ZONE_LABEL_CLAMP", "P1-labels_verified"]);
    expect(split.defects.map((i) => i.checkId)).toEqual(["TEXT_OUTSIDE"]);
    // ZONE_LABEL_CLAMP stays a layout note (counted), the labels state does not.
    expect(preview.INFO_CODES.has("ZONE_LABEL_CLAMP")).toBe(false);
    expect(preview.INFO_CODES.has("P1-labels_verified")).toBe(true);
  });
});

describe("row 60 (b): lint D09 and the render check never fail on the flag", () => {
  test("registry: D09 is report-only (limit exactly lapor), still a TERBIT/SERAH structure rule", () => {
    const d = LINT_REGISTRY.find((x) => x.id === "D09")!;
    expect(d.limit).toBe("lapor");
    expect(defaultEnforcement(d)).toBe("report");
    expect([d.group, d.module, d.blocksIngest, [...d.tiers]]).toEqual(["D", "structure", false, ["TERBIT", "SERAH"]]);
    expect(LINT_REGISTRY.filter((x) => x.id === "D09")).toHaveLength(1);
  });

  test("predicate: only true is checked", () => {
    expect([true, false, undefined, "true", 1].map((v) => diagramLabelsUnchecked({ labels_verified: v }))).toEqual([false, true, true, true, true]);
    expect([null, undefined, "x", []].map((v) => diagramLabelsUnchecked(v))).toEqual([false, false, false, false]);
  });

  for (const tier of ["TERBIT", "SERAH"] as const) {
    for (const [name, flag] of FLAGS) {
      test(`D09 at ${tier}, labels_verified ${name}: REPORT with the marker, never FAIL`, () => {
        const out = lintStructureWith(snapshotOf(makeDoc({ tier, blocks: [block(flag)] })), KAN, tier, { only: ["D09"] });
        expect(statuses(out, "D09")).toEqual(["REPORT"]);
        expect(out.find((i) => i.checkId === "D09")!.detail).toContain(MARK_ID);
        expect(releaseFor(out, tier)).not.toBe("FAIL");
      });
    }
    test(`D09 at ${tier}, all flags true: PASS as before`, () => {
      const out = lintStructureWith(snapshotOf(makeDoc({ tier, blocks: [block(true), block(true, "9.2")] })), KAN, tier, { only: ["D09"] });
      expect(out.filter((i) => i.checkId === "D09")).toEqual([{ checkId: "D09", status: "PASS", detail: "2 diagram berlabel terverifikasi" }]);
    });
  }

  test("render check: REPORT at every tier when not true; PASS at release tiers and nothing at NOTA when true", async () => {
    const got: Record<string, unknown> = {};
    for (const tier of ["NOTA", "TERBIT", "SERAH"]) {
      const { r, job } = await build(tier, [false, undefined, true]);
      expect(job.errors ?? []).toEqual([]);
      expect(r.svgs).toHaveLength(3);
      got[tier] = { rows: r.extra.map((e) => `${e.address}:${e.checkId}:${e.status}`), awaiting: r.awaitingHumanCheck };
      for (const e of r.extra.filter((x) => x.status === "REPORT")) expect(e.detail).toContain(MARK_ID);
      expect(r.extra.some((e) => e.status === "FAIL")).toBe(false);
    }
    expect(got).toEqual({
      NOTA: { rows: ["6.1.1:P1-labels_verified:REPORT", "6.1.2:P1-labels_verified:REPORT"], awaiting: ["labels_verified"] },
      TERBIT: { rows: ["6.1.1:P1-labels_verified:REPORT", "6.1.2:P1-labels_verified:REPORT", "6.1.3:P1-labels_verified:PASS"], awaiting: ["labels_verified"] },
      SERAH: { rows: ["6.1.1:P1-labels_verified:REPORT", "6.1.2:P1-labels_verified:REPORT", "6.1.3:P1-labels_verified:PASS"], awaiting: ["labels_verified"] },
    });
  });

  test("render check, all flags true: the rows of before (old pin: PASS per diagram at TERBIT/SERAH, none at NOTA); not awaiting", async () => {
    for (const [tier, rows] of [["NOTA", []], ["TERBIT", ["PASS", "PASS"]], ["SERAH", ["PASS", "PASS"]]] as const) {
      const { r } = await build(tier, [true, true]);
      expect(r.extra.map((e) => e.status)).toEqual([...rows]);
      expect(r.extra.every((e) => e.detail === undefined)).toBe(true);
      expect(r.awaitingHumanCheck).toEqual([]);
    }
  });

  for (const tier of ["TERBIT", "SERAH"] as const) {
    test(`document lint at ${tier}: a false-flag figure fails nothing on the flag and the report exposes the awaiting state`, async () => {
      const snapshot = snapshotOf(makeDoc({ tier, blocks: [block(false)] }));
      const { r } = await build(tier, [false]);
      const lint = lintAfterRender({ snapshot, tpl: KAN, tier, svgs: r.svgs, extra: r.extra, log: LOG });
      const flagRows = lint.checks.filter((c) => c.checkId === "D09" || c.checkId === "P1-labels_verified");
      expect(flagRows.map((c) => `${c.checkId}:${c.status}`).sort()).toEqual(["D09:REPORT", "P1-labels_verified:NOT_RUN", "P1-labels_verified:REPORT"]);
      expect(figs.awaitingHumanCheckOf(lint.checks)).toEqual(["labels_verified"]);
      // what the row-close gate reads back from the store: the JSON of the report
      expect(figs.awaitingHumanCheckOf(JSON.parse(JSON.stringify(lint)).checks)).toEqual(["labels_verified"]);
      // the host LINT check has no finding that names the flag
      const v = checkLint({ format: "HTML", lintReport: JSON.stringify(lint), lintVerdict: lint.releaseStatus, tier } as never);
      expect(JSON.stringify(v)).not.toMatch(/D09|labels_verified/);

      // the same document with the flag true: same verdict, not awaiting
      const snapT = snapshotOf(makeDoc({ tier, blocks: [block(true)] }));
      const t = await build(tier, [true]);
      const lintT = lintAfterRender({ snapshot: snapT, tpl: KAN, tier, svgs: t.r.svgs, extra: t.r.extra, log: LOG });
      expect(lintT.checks.filter((c) => c.checkId === "D09" || c.checkId === "P1-labels_verified").map((c) => `${c.checkId}:${c.status}`).sort()).toEqual(["D09:PASS", "P1-labels_verified:PASS"]);
      expect(figs.awaitingHumanCheckOf(lintT.checks)).toEqual([]);
      expect(lint.releaseStatus).toBe(lintT.releaseStatus);
      const failing = (l: typeof lint) => l.checks.filter((c) => c.status === "FAIL").map((c) => c.checkId).sort();
      expect(failing(lint)).toEqual(failing(lintT));
    });
  }

  test("awaitingHumanCheckOf: reads only a REPORT row of P1-labels_verified", () => {
    const of = figs.awaitingHumanCheckOf;
    expect(of([{ checkId: "P1-labels_verified", status: "REPORT" }])).toEqual(["labels_verified"]);
    expect(of([{ checkId: "P1-labels_verified", status: "PASS" }])).toEqual([]);
    expect(of([{ checkId: "P1-labels_verified", status: "NOT_RUN" }])).toEqual([]);
    expect(of([{ checkId: "D09", status: "REPORT" }])).toEqual([]);
    expect(of([])).toEqual([]);
    expect(of(undefined)).toEqual([]);
    expect(of(null)).toEqual([]);
    expect(of([null, 3, "x"] as never)).toEqual([]);
    expect(figs.LABELS_UNCHECKED_TEXT).toEqual({ ID: MARK_ID, EN: MARK_EN });
    expect(figs.LABELS_VERIFIED_HUMAN_CHECK).toBe("labels_verified");
  });
});
