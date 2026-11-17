// @ts-nocheck shares the vitest-typed ported fixtures (test/ported/engine-core/fixtures.ts); checked at run time.
// Swarm 1.3.3 row 64 (ST-9 item 3; register 03 s7 `LintReport.notRun`): the lint report lists the rules and
// modules that were NOT run, one reason each, and tells "not applicable to this document" (cause `tier`,
// `not-applicable`) from "could not run" (cause `staged`, `could-not-run`). The list only reads the result:
// `checks`, the release status and the banner stay as they were. No module mock: faults come from real input.
import { describe, expect, test } from "bun:test";
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures";
import { JobLog } from "../../vendor/src/lib/studio/services/render/joblog";
import { lintAfterRender, lintArtifact, lintNotRun, NOT_RUN_REASON_MAX, RENDER_NO_INPUT_REASON } from "../../vendor/src/lib/studio/services/render/lint";
import { runLint } from "../../vendor/src/lib/studio/engine/lint/scan";
import { LINT_REGISTRY } from "../../vendor/src/lib/studio/registry/lint";

const CAUSES = ["tier", "not-applicable", "human", "staged", "could-not-run"];
const byId = (list, id) => list.find((e) => e.id === id);
const run = (tier, opts = {}) =>
  lintAfterRender({ snapshot: snapshotOf(makeDoc({ tier, ...opts.doc })), tpl: canonicalTemplate(), tier, svgs: [], log: new JobLog("row64"), ...opts.input });

describe("row 64: LintReport.notRun", () => {
  test("shape: every entry is {id, kind, reason, cause}, one entry per id, reasons bounded", () => {
    const rep = run("TERBIT");
    expect(Array.isArray(rep.notRun)).toBe(true);
    expect(rep.notRun.length).toBeGreaterThan(0);
    for (const e of rep.notRun) {
      expect(Object.keys(e).sort()).toEqual(["cause", "id", "kind", "reason"]);
      expect(["rule", "module"]).toContain(e.kind);
      expect(CAUSES).toContain(e.cause);
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeLessThanOrEqual(NOT_RUN_REASON_MAX);
    }
    const keys = rep.notRun.map((e) => `${e.kind}:${e.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    // JSON round trip (the report is stored as lint_json): the field survives.
    expect(JSON.parse(JSON.stringify(rep)).notRun).toEqual(rep.notRun);
  });

  test("a tier that skips rules lists each of them with the tier reason (not applicable, not a fault)", () => {
    const rep = run("NOTA");
    const outOfTier = LINT_REGISTRY.filter((d) => !d.tiers.includes("NOTA"));
    expect(outOfTier.length).toBeGreaterThan(0);
    const ranIds = new Set(rep.checks.filter((c) => c.status !== "NOT_RUN").map((c) => c.checkId));
    const skipped = outOfTier.filter((d) => !ranIds.has(d.id));
    expect(skipped.length).toBeGreaterThan(0);
    for (const d of skipped) {
      const e = byId(rep.notRun, d.id);
      expect(e, d.id).toBeDefined();
      expect(e.kind).toBe("rule");
      expect(e.cause).toBe("tier");
      expect(e.reason).toContain("tidak berlaku pada tier NOTA");
      expect(e.reason).toContain(d.tiers.join(", "));
    }
    // The same rules at TERBIT are not "tier" entries.
    const terbit = run("TERBIT");
    const inTerbit = new Set(LINT_REGISTRY.filter((d) => d.tiers.includes("TERBIT")).map((d) => d.id));
    expect(terbit.notRun.filter((e) => e.cause === "tier" && inTerbit.has(e.id))).toEqual([]);
  });

  test("staged rules (notRunReason) appear as not run with the registry reason, never as passed", () => {
    const rep = run("TERBIT");
    const staged = LINT_REGISTRY.filter((d) => d.notRunReason !== undefined && d.tiers.includes("TERBIT"));
    expect(staged.map((d) => d.id)).toEqual(expect.arrayContaining(["C-14", "C-21"])); // C-35 (row 84), C-36 (row 85/86) and C-37 (row 103) run; the older language rules are still staged
    for (const d of staged) {
      const e = byId(rep.notRun, d.id);
      expect(e, d.id).toBeDefined();
      expect(e.cause).toBe("staged");
      expect(e.reason).toBe(d.notRunReason.length > NOT_RUN_REASON_MAX ? e.reason : d.notRunReason);
      expect(rep.checks.filter((c) => c.checkId === d.id).map((c) => c.status)).toEqual(["NOT_RUN"]);
    }
  });

  test("human checks are their own cause", () => {
    const rep = run("SERAH");
    const human = LINT_REGISTRY.filter((d) => d.module === "human" && d.tiers.includes("SERAH"));
    expect(human.length).toBeGreaterThan(0);
    for (const d of human) expect(byId(rep.notRun, d.id)?.cause, d.id).toBe("human");
  });

  test("missing input: no rendered page and no SVG -> module render and its rules are 'could not run'", () => {
    const rep = run("TERBIT");
    expect(byId(rep.notRun, "render")).toEqual({ id: "render", kind: "module", reason: RENDER_NO_INPUT_REASON, cause: "could-not-run" });
    const renderRules = LINT_REGISTRY.filter((d) => d.module === "render" && d.tiers.includes("TERBIT") && d.notRunReason === undefined);
    expect(renderRules.length).toBeGreaterThan(0);
    for (const d of renderRules) {
      const e = byId(rep.notRun, d.id);
      expect(e, d.id).toBeDefined();
      expect(e.cause).toBe("could-not-run");
      expect(e.reason).toContain(RENDER_NO_INPUT_REASON);
      // Today these rules are simply absent from `checks`; the list is the only place they show.
      expect(rep.checks.some((c) => c.checkId === d.id)).toBe(false);
    }
    // With metrics the module is called: no module entry, the rules report for themselves.
    const measured = run("TERBIT", { input: { metrics: { pageCount: 0, elements: [] } } });
    expect(byId(measured.notRun, "render")).toBeUndefined();
    for (const d of renderRules) expect(measured.checks.some((c) => c.checkId === d.id), d.id).toBe(true);
  });

  test("not applicable to this document: an Indonesian-only rule on an EN document", () => {
    const rep = run("TERBIT", { doc: { language: "EN" } });
    for (const id of ["C-20", "C-34"]) {
      const c = rep.checks.filter((x) => x.checkId === id);
      if (!c.some((x) => x.status === "NOT_RUN")) continue;
      expect(byId(rep.notRun, id)?.cause, id).toBe("not-applicable");
    }
    expect(rep.notRun.some((e) => e.cause === "not-applicable")).toBe(true);
    expect(run("TERBIT").notRun.some((e) => e.cause === "not-applicable")).toBe(false);
  });

  test("a thrown module appears as a module entry with its error, and its rules as 'could not run'", () => {
    const log = new JobLog("row64-fault");
    // A snapshot without a document makes the lint modules throw for real (no mock).
    const rep = lintAfterRender({ snapshot: {}, tpl: canonicalTemplate(), tier: "TERBIT", svgs: [], log });
    const modules = rep.notRun.filter((e) => e.kind === "module");
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) {
      expect(["scan", "structure", "language", "render"]).toContain(m.id);
      expect(m.cause).toBe("could-not-run");
      expect(m.reason.length).toBeGreaterThan(0);
    }
    expect(modules.some((m) => m.id !== "render")).toBe(true);
    // Modules come first, then rules.
    const firstRule = rep.notRun.findIndex((e) => e.kind === "rule");
    expect(rep.notRun.slice(0, firstRule).every((e) => e.kind === "module")).toBe(true);
    expect(rep.notRun.slice(firstRule).every((e) => e.kind === "rule")).toBe(true);
    // Every registry rule that did not run at this tier is listed.
    const ranIds = new Set(rep.checks.filter((c) => c.status !== "NOT_RUN").map((c) => c.checkId));
    for (const d of LINT_REGISTRY) if (!ranIds.has(d.id)) expect(byId(rep.notRun, d.id), d.id).toBeDefined();
    const faulted = modules.filter((m) => m.id !== "render").map((m) => m.id);
    const hit = rep.notRun.filter((e) => e.kind === "rule" && e.cause === "could-not-run" && faulted.some((m) => e.reason.includes(m)));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("a rule without scanner and a module fault reported by the runner are both read from `checks`", () => {
    const list = lintNotRun({
      tier: "TERBIT",
      checks: [
        { checkId: "DATUM-04", status: "NOT_RUN", detail: "modul engine/lint/scan tidak dijalankan: cacat instrumen uji" },
        { checkId: "C-14", status: "NOT_RUN", detail: "pemindai belum terdaftar di engine/lint/language" }, // C-14 is still staged (C-35..C-37 run since rows 84, 85/86, 103)
        { checkId: "DATUM-01", status: "PASS" },
      ],
    });
    expect(list).toEqual([
      { id: "scan", kind: "module", reason: "cacat instrumen uji", cause: "could-not-run" },
      { id: "DATUM-04", kind: "rule", reason: "modul engine/lint/scan tidak dijalankan: cacat instrumen uji", cause: "could-not-run" },
      { id: "C-14", kind: "rule", reason: "pemindai belum terdaftar di engine/lint/language", cause: "staged" },
    ]);
  });

  test("a run where everything runs has an empty list", () => {
    const ids = LINT_REGISTRY.filter((d) => d.tiers.includes("TERBIT")).map((d) => d.id);
    const all = [...ids.map((checkId) => ({ checkId, status: "PASS" })), { checkId: "P1-other", status: "REPORT" }, { checkId: "DATUM-03", status: "FAIL", address: "1.1" }];
    expect(lintNotRun({ tier: "TERBIT", checks: all })).toEqual([]);
    expect(lintNotRun({ tier: "TERBIT", checks: LINT_REGISTRY.map((d) => ({ checkId: d.id, status: "PASS" })), cover: ["scan", "structure", "language", "render", "human"] })).toEqual([]);
    expect(lintNotRun({ tier: "NOTA", checks: [] })).toEqual([]);
  });

  test("partly run and unregistered checks; deterministic order", () => {
    const checks = [
      { checkId: "ZZ-unregistered", status: "NOT_RUN", detail: "alat tidak ada" },
      { checkId: "DATUM-25", status: "NOT_RUN", detail: "SVG tidak terurai: x", pointer: "/a" },
      { checkId: "DATUM-25", status: "PASS" },
      { checkId: "AA-unregistered", status: "NOT_RUN" },
    ];
    const list = lintNotRun({ tier: "TERBIT", checks });
    expect(list.map((e) => e.id)).toEqual(["DATUM-25", "AA-unregistered", "ZZ-unregistered"]);
    expect(list[0]).toEqual({ id: "DATUM-25", kind: "rule", reason: "sebagian: 1 butir tidak diperiksa; SVG tidak terurai: x", cause: "could-not-run" });
    expect(list[1].reason).toBe("tanpa keterangan");
    expect(lintNotRun({ tier: "TERBIT", checks: [...checks].reverse() }).map((e) => e.id)).toEqual(list.map((e) => e.id));
    const long = lintNotRun({ tier: "TERBIT", checks: [{ checkId: "X", status: "NOT_RUN", detail: "y".repeat(1000) }] });
    expect(long[0].reason.length).toBe(NOT_RUN_REASON_MAX);
  });

  test("the list does not change checks, release status or banner", () => {
    const snapshot = snapshotOf(makeDoc({ tier: "TERBIT" }));
    const tpl = canonicalTemplate();
    const base = runLint({ snapshot, tpl, tier: "TERBIT", stage: "post" });
    const rep = lintAfterRender({ snapshot, tpl, tier: "TERBIT", svgs: [], log: new JobLog("row64-same") });
    expect(rep.releaseStatus).toBe(base.releaseStatus);
    expect(rep.banner).toBe(base.banner);
    expect(rep.checks.map((c) => `${c.checkId}|${c.status}`).sort()).toEqual(base.checks.map((c) => `${c.checkId}|${c.status}`).sort());
    // Every NOT_RUN check of the report is in the list, and nothing that fully ran is.
    const nr = new Set(rep.checks.filter((c) => c.status === "NOT_RUN").map((c) => c.checkId));
    const listed = new Set(rep.notRun.filter((e) => e.kind === "rule").map((e) => e.id));
    for (const id of nr) expect(listed.has(id), id).toBe(true);
    const ranOnly = rep.checks.filter((c) => c.status !== "NOT_RUN" && !nr.has(c.checkId)).map((c) => c.checkId);
    for (const id of ranOnly) expect(listed.has(id), id).toBe(false);
  });

  test("stand-alone artefact: only the render module is covered", () => {
    const rep = lintArtifact({ svgs: [], log: new JobLog("row64-art") });
    expect(byId(rep.notRun, "render")).toEqual({ id: "render", kind: "module", reason: RENDER_NO_INPUT_REASON, cause: "could-not-run" });
    const rules = rep.notRun.filter((e) => e.kind === "rule");
    const renderIds = new Set(LINT_REGISTRY.filter((d) => d.module === "render").map((d) => d.id));
    expect(rules.length).toBe(renderIds.size);
    for (const e of rules) expect(renderIds.has(e.id), e.id).toBe(true);
  });
});
