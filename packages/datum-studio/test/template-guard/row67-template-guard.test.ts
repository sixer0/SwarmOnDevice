// Row 67 (masterplan/01_specs_studio_templates.md §5 with the U16 amendment U.1-U.5, U.9 row 67; decisions
// C19 D-B, C65): template preview with the Swarm sample, and the Rev A template guard installed into the
// row 66 service. Runs against a REAL temp DATUM Studio store, the vendored Studio ingest + renderSnapshot +
// lintAfterRender, and the row 108 bridge client. The only stand-in is the render bridge transport
// (`setRenderBridgeTransport`, the seam row 108's twins test uses): Electron cannot run under bun. It answers
// `hello` like the row 24 bridge, `checkPage` (Studio MEASURE_SCRIPT) with a paged layout without elements,
// and `pdf` with a small valid PDF. So the render-module lint checks (DATUM-14, 15, 25, 28, 32, 33, 37) see
// no measured elements here; real Chromium measurement is for rows 42/43/71.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth";
import type { LintIssue, LintReport, StudioTemplateV2 } from "../../vendor/src/lib/studio/contract";
import type { TemplateGuard, TemplateGuardInput } from "../../vendor/src/lib/studio/services/templates/service";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const STUDIO = path.join(VENDOR, "src", "lib", "studio");
const TEMPLATES = path.join(PKG, "templates");
const base = process.env.ROW67_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row67-")));
const ROOT = path.join(WORK, "datum-studio");
const LOG = path.join(WORK, "logs", "store.jsonl");
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl");

process.env.STUDIO_WORKSPACE_ROOT = ROOT;
process.env.STUDIO_ASSETS_ROOT = path.join(STUDIO, "assets");

const caller: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row67-test", agentId: "row67-test", canWriteClassK: false };

let store: SqliteStudioStore;
let templates: typeof import("../../vendor/src/lib/studio/services/templates");
let service: typeof import("../../vendor/src/lib/studio/services/templates/service");
let guardMod: typeof import("../../vendor/src/lib/studio/services/templates/guard");
let sampleMod: typeof import("../../vendor/src/lib/studio/services/templates/sample-render");
let preview: typeof import("../../vendor/src/lib/studio/services/templates/preview");
let skeleton: typeof import("../../vendor/src/lib/studio/services/skeleton");
let registry: typeof import("../../vendor/src/lib/studio/registry/lint");
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime");

// ── Render bridge transport stand-in (see header) ────────────────────────
const ops: string[] = [];
let measureFails = false;
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] };
function installTransport(): void {
  runtime.setRenderBridgeTransport(async (req) => {
    ops.push(req.op);
    if (req.op === "hello") return { ok: true, ...GOOD_INFO };
    if (req.op === "checkPage") {
      if (measureFails) return { ok: false, code: "RENDER_FAILED", message: "checkPage refused (test)" };
      return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } };
    }
    if (req.op === "pdf") {
      writeFileSync(String(req.dst), Buffer.from("%PDF-1.7\n1 0 obj<</Type /Pages /Count 6>>endobj\n%%EOF\n", "latin1"));
      return { ok: true, electron: "42.3.3", dst: req.dst };
    }
    return { ok: false, code: "UNKNOWN_OP", message: req.op };
  });
}

type Raw = Record<string, unknown>;
function reader(): { get(s: string, p?: unknown[]): Raw | undefined; all(s: string, p?: unknown[]): Raw[] } {
  return (store as unknown as { requireReader(): { get(s: string, p?: unknown[]): Raw | undefined; all(s: string, p?: unknown[]): Raw[] } }).requireReader();
}
function versionRow(slug: string, no: number): Raw {
  const r = reader().get("SELECT v.* FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = ? AND v.version_no = ?", [slug, no]);
  if (!r) throw new Error(`no version ${slug} v${no}`);
  return r;
}
const versionCount = () => Number(reader().get("SELECT count(*) AS n FROM template_version")?.n);
const previewRows = () => reader().all("SELECT * FROM output_file WHERE kind = 'preview' ORDER BY rel_path");
const latestNo = (slug: string) => Number(reader().get("SELECT latest_version_no AS n FROM template WHERE slug = ?", [slug])?.n ?? 0);

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; swarm?: string; details: Raw }> {
  try {
    await p;
  } catch (e) {
    return { code: (e as { code?: string }).code, swarm: service.templateErrorCode(e), details: ((e as { details?: Raw }).details ?? {}) as Raw };
  }
  throw new Error("expected a refusal, got success");
}

type Report = import("../../vendor/src/lib/studio/services/templates/guard").TemplateGuardReport;

/** A candidate folded WITHOUT the form lock (the "lock seam off" of spec §9 row 67 (3)), as the guard receives it. */
function unlockedCandidate(def: StudioTemplateV2): TemplateGuardInput["candidate"] {
  const fold = templates.foldTemplateDefinition(def, templates.presetFoldBase(def.preset!.slug, def.preset!.version));
  const sk = skeleton.skeletonForInsert(fold.skeleton);
  return { definition: def, payload: fold.payload, skeleton: sk.skeleton, skeletonSha256: sk.skeletonSha256 };
}

async function gspDefinition(): Promise<StudioTemplateV2> {
  const d = await templates.getTemplateV2("datum-gsp", undefined, { includeAdvanced: true });
  return d.definition as StudioTemplateV2;
}

async function gspReference(): Promise<TemplateGuardInput["reference"]> {
  const d = await templates.getTemplate("datum-gsp");
  return { slug: "datum-gsp", versionNo: d.version.versionNo, versionId: d.version.id };
}

const COPY = "user-uji-pemeriksa";
let realGuard: TemplateGuard;

beforeAll(async () => {
  mkdirSync(path.dirname(TPL_LOG), { recursive: true });
  store = await openHostStore(ROOT, { release: "1.2.0", logFile: LOG });
  templates = await import("../../vendor/src/lib/studio/services/templates");
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`));
  service = await import("../../vendor/src/lib/studio/services/templates/service");
  guardMod = await import("../../vendor/src/lib/studio/services/templates/guard");
  sampleMod = await import("../../vendor/src/lib/studio/services/templates/sample-render");
  preview = await import("../../vendor/src/lib/studio/services/templates/preview");
  skeleton = await import("../../vendor/src/lib/studio/services/skeleton");
  registry = await import("../../vendor/src/lib/studio/registry/lint");
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime");
  installTransport();
  await templates.ensureBuiltinTemplates();
  realGuard = guardMod.createTemplateGuard();
  service.configureTemplateGuard(realGuard);
});

afterAll(async () => {
  service.configureTemplateGuard(null);
  runtime.setRenderBridgeTransport(null);
  templates.setTemplatesLogSink(null);
  await closeHostStore(store);
});

describe("row 67: sample and registry facts", () => {
  test("A1 (U.3): the Swarm sample rendered with datum-kanonik at TERBIT is lint-clean (releaseStatus PASS, no FAIL)", async () => {
    for (const slug of ["datum-kanonik", "datum-gsp"]) {
      const d = await templates.getTemplate(slug);
      const side = await sampleMod.sideFromVersion(d.version.id);
      const doc = sampleMod.swarmSampleDocument({ slug, tier: "TERBIT", slots: side.skeleton.skeleton.slots, language: "ID" });
      const out = await sampleMod.renderSample(side, doc, { tier: "TERBIT", formats: ["DOCX", "HTML"], timeoutMs: 60_000, correlationId: `a1-${slug}` });
      expect(out.ingest.valid).toBe(true);
      expect(out.render!.status).toBe("SUCCEEDED");
      const lint = out.render!.lint!;
      const n = { PASS: 0, FAIL: 0, REPORT: 0, NOT_RUN: 0 } as Record<string, number>;
      for (const c of lint.checks) n[c.status] += 1;
      const ids = new Set(lint.checks.map((c) => c.checkId)).size;
      console.log(`row67: A1 ${slug} lint ${lint.tier} releaseStatus=${lint.releaseStatus} issues=${lint.checks.length} ids=${ids} PASS=${n.PASS} FAIL=${n.FAIL} REPORT=${n.REPORT} NOT_RUN=${n.NOT_RUN} sampleSha256=${sampleMod.sampleSha256(doc)}`);
      console.log(`row67: A1 ${slug} REPORT/NOT_RUN ids: ${lint.checks.filter((c) => c.status !== "PASS").map((c) => `${c.checkId}:${c.status}`).join(" ")}`);
      expect(lint.tier).toBe("TERBIT");
      expect(lint.releaseStatus).toBe("PASS");
      expect(n.FAIL).toBe(0);
      // Studio's plain sample (no Swarm additions) fails D17, D18 and C-27 on the same template: the additions are needed.
      const plain = (await import("../../vendor/src/components/studio/template-preview/sample-document-v2")).sampleDocumentV2({ slug, tier: "TERBIT", slots: side.skeleton.skeleton.slots, language: "ID" });
      const out0 = await sampleMod.renderSample(side, plain, { tier: "TERBIT", formats: ["DOCX", "HTML"], timeoutMs: 60_000, correlationId: `a1-plain-${slug}` });
      const fails0 = [...new Set(out0.render!.lint!.checks.filter((c) => c.status === "FAIL").map((c) => c.checkId))].sort();
      console.log(`row67: A1 ${slug} Studio plain sample FAIL ids: ${fails0.join(" ")}`);
      expect(fails0).toEqual(["C-27", "D17", "D18"]);
    }
  });

  test("G-U1: LINT_REGISTRY_COUNT from the code and the S1-S5 classes sum to it at TERBIT and SERAH", () => {
    const count = registry.LINT_REGISTRY_COUNT;
    for (const tier of ["TERBIT", "SERAH"] as const) {
      const c = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 } as Record<string, number>;
      for (const d of registry.LINT_REGISTRY) c[guardMod.guardClassOf(d, tier)] += 1;
      console.log(`row67: classes ${tier} registry=${count} groups=${JSON.stringify(registry.LINT_GROUP_COUNTS)} ${JSON.stringify(c)}`);
      expect(c.S1 + c.S2 + c.S3 + c.S4 + c.S5).toBe(count);
      expect(c.S3).toBe(4);
      expect(c.S4).toBe(16);
    }
    expect(count).toBe(103);
    expect(registry.LINT_GROUP_COUNTS.C).toBe(19);
  });

  test("U.5: skillSha = sha of the shipped lint closure; every closure entry of vendor/provenance.json matches the file on disk", () => {
    const manifest = JSON.parse(readFileSync(path.join(VENDOR, "provenance.json"), "utf8")) as { files: Array<{ path: string; sha256: string; bytes: number }> };
    const closure = manifest.files.filter((f) => guardMod.isLintClosurePath(f.path));
    for (const f of closure) {
      const disk = readFileSync(path.join(VENDOR, f.path));
      expect(`${f.path} ${new Bun.CryptoHasher("sha256").update(disk).digest("hex")}`).toBe(`${f.path} ${f.sha256}`);
    }
    const shipped = guardMod.shippedLintClosure();
    expect(shipped).toEqual(guardMod.lintClosureSha(manifest));
    expect(shipped.sha256).toMatch(/^[0-9a-f]{64}$/);
    console.log(`row67: lint closure files=${shipped.files} sha256=${shipped.sha256}`);
    expect(shipped.files).toBe(closure.length);
  });

  test("U.9 (10): no Claude lint, datum-python or scorer in the guard code; no `unmapped` reason", () => {
    const dir = path.join(STUDIO, "services", "templates");
    for (const f of ["guard.ts", "sample-render.ts", "preview.ts"]) {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect([f, /datum_lint|datum-python|datum_conformance|\bunmapped\b/.test(text)]).toEqual([f, false]);
    }
  });
});

describe("row 67: the guard in the service", () => {
  test("a copy of datum-gsp passes; the version row carries verdict + report + skillSha (U.5 report shape)", async () => {
    const before = versionCount();
    const r = await service.createUserTemplateV2({ slug: COPY, name: "Uji Pemeriksa", kind: "DOCUMENT", changeNote: "Salinan datum-gsp", from: { slug: "datum-gsp" } }, caller);
    expect(r.guard.verdict).toBe("pass");
    expect(versionCount()).toBe(before + 1);
    const row = versionRow(COPY, 1);
    expect(row.guard_verdict).toBe("pass");
    expect(row.guard_skill_sha).toBe(guardMod.shippedLintClosure().sha256);
    const rep = JSON.parse(String(row.guard_report)) as Report;
    expect(Buffer.byteLength(String(row.guard_report))).toBeLessThanOrEqual(guardMod.GUARD_REPORT_MAX_BYTES);
    expect(rep.checks.length).toBe(registry.LINT_REGISTRY_COUNT);
    expect(new Set(rep.checks.map((c) => c.id)).size).toBe(registry.LINT_REGISTRY_COUNT);
    expect(Object.values(rep.classCounts!).reduce((a, b) => a + b, 0)).toBe(registry.LINT_REGISTRY_COUNT);
    expect(rep.lintTier).toBe("TERBIT");
    expect(rep.lintParamPin).toBe("equal");
    expect(rep.formats).toEqual(["DOCX", "HTML"]);
    expect(rep.releaseStatus).toEqual({ reference: "PASS", candidate: "PASS" });
    expect(rep.sampleSha256!.reference).toBe(rep.sampleSha256!.candidate);
    expect(rep.checks.filter((c) => c.outcome === "reject")).toEqual([]);
    const outcomes: Record<string, number> = {};
    for (const c of rep.checks) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    console.log(`row67: copy ${COPY} v1 guard_verdict=${row.guard_verdict} guard_skill_sha=${row.guard_skill_sha} report bytes=${Buffer.byteLength(String(row.guard_report))} classCounts=${JSON.stringify(rep.classCounts)} outcomes=${JSON.stringify(outcomes)} reference=${JSON.stringify(rep.reference)} durationMs=${rep.durationMs}`);
  });

  test("case 06 op 2 (cover.title.sizePt 26) passes and is saved; op 3 (Calibri) is refused by the form lock before the guard", async () => {
    const calls: TemplateGuardInput[] = [];
    service.configureTemplateGuard(async (i) => {
      calls.push(i);
      return realGuard(i);
    });
    try {
      const r = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 1, changeNote: "Judul sampul 26 pt", changes: { advanced: { "cover.title.sizePt": 26 } } }, caller);
      expect(r.guard.verdict).toBe("pass");
      expect(versionRow(COPY, 2).guard_verdict).toBe("pass");
      expect(calls.length).toBe(1);
      const before = versionCount();
      const e = await errorOf(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 2, changeNote: "x", changes: { advanced: { "type.face.serif": "Calibri" } } }, caller));
      expect([e.swarm, e.details.reason]).toEqual(["TEMPLATE_FORM_LOCKED", "category:tipografi"]);
      expect(calls.length).toBe(1);
      expect(versionCount()).toBe(before);
      expect(latestNo(COPY)).toBe(2);
    } finally {
      service.configureTemplateGuard(realGuard);
    }
  });

  test("Rev A break at guard level (lock seam off): Calibri in type.face.serif -> DATUM-05 FAIL on the candidate only -> reject; through the service GUARD_REJECTED, nothing saved", async () => {
    const def = await gspDefinition();
    def.advanced = { ...(def.advanced ?? {}), "type.face.serif": "Calibri" };
    const candidate = unlockedCandidate(def);
    const out = await realGuard({ op: "check", slug: "datum-gsp", lintTier: "TERBIT", reference: await gspReference(), candidate, correlationId: "row67-calibri" });
    expect(out.verdict).toBe("reject");
    const rep = (out as { report: Report }).report;
    const d05 = rep.checks.find((c) => c.id === "DATUM-05")!;
    console.log(`row67: guard report DATUM-05 entry: ${JSON.stringify(d05)}`);
    console.log(`row67: guard report ingest: ${JSON.stringify(rep.ingest)} releaseStatus=${JSON.stringify(rep.releaseStatus)}`);
    console.log(`row67: guard report rejects: ${JSON.stringify(rep.checks.filter((c) => c.outcome === "reject").map((c) => [c.id, c.reason, c.reference.failCount, c.candidate.failCount]))}`);
    expect(d05.outcome).toBe("reject");
    expect(d05.reason).toBe("REGRESSION");
    expect(d05.reference.failCount).toBe(0);
    expect(d05.candidate.failCount).toBeGreaterThan(0);
    expect(d05.issues!.some((i) => i.detail.includes("type.face.serif") && i.detail.includes("Calibri"))).toBe(true);
    expect("skillSha" in out).toBe(false);

    // The service with the lock seam off: the guard sees this candidate in place of what the lock let through.
    service.configureTemplateGuard((i) => realGuard({ ...i, candidate }));
    try {
      const before = versionCount();
      const e = await errorOf(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "lock seam off", changes: { advanced: { "chapter.kicker.pattern": "BAB {n}" } } }, caller));
      expect([e.code, e.swarm]).toEqual(["BY_CONSTRUCTION_FAILED", "GUARD_REJECTED"]);
      const quoted = (e.details.report as Report).checks.find((c) => c.id === "DATUM-05")!;
      console.log(`row67: service refusal ${e.swarm} (${e.code}); quoted DATUM-05: ${JSON.stringify({ outcome: quoted.outcome, reason: quoted.reason, issue: quoted.issues![0] })}`);
      expect(quoted.outcome).toBe("reject");
      expect(versionCount()).toBe(before);
    } finally {
      service.configureTemplateGuard(realGuard);
    }
  });

  test("U.1a lint-parameter pin (U.9 add 8): one lint-parameter key changed (lock off) -> reject lint-param without rendering", async () => {
    const def = await gspDefinition();
    def.advanced = { ...(def.advanced ?? {}), "naming.underscore.allowed": true };
    const n = ops.length;
    const out = await realGuard({ op: "check", slug: "datum-gsp", lintTier: "TERBIT", reference: await gspReference(), candidate: unlockedCandidate(def), correlationId: "row67-pin" });
    expect(out.verdict).toBe("reject");
    const rep = (out as { report: Report }).report;
    expect(rep.lintParamPin).toBe("differs");
    expect(rep.lintParamDiffs).toEqual([{ key: "naming.underscore.allowed", reference: false, candidate: true }]);
    expect(rep.checks).toEqual([expect.objectContaining({ id: "lint-param", key: "naming.underscore.allowed", outcome: "reject" })]);
    expect(ops.length).toBe(n); // nothing rendered (no bridge call)
    // Through the service the lock refuses first (P3 internal surface); the pin is the second line.
    const e = await errorOf(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: { advanced: { "naming.underscore.allowed": true } } }, caller));
    expect(e.swarm).toBe("PARAM_SURFACE_FORBIDDEN");
  });

  test("U.9 add 9 + §9 (4): artifact.tier NOTA is linted at TERBIT (pass); SERAH is linted at SERAH, pin re-derived at SERAH, pre-existing D01/D16 -> warn and saved", async () => {
    const nota = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "tier NOTA", changes: { advanced: { "artifact.tier": "NOTA" } } }, caller);
    const repN = JSON.parse(String(versionRow(COPY, nota.version.versionNo).guard_report)) as Report;
    // datum-gsp itself resolves artifact.tier NOTA, so NOTA needs no re-derivation (lintParamTier null).
    expect(versionRow(COPY, 1).resolved_params).toContain('"artifact.tier":"NOTA"');
    expect([nota.guard.verdict, repN.lintTier, repN.renderTier, repN.lintParamTier]).toEqual(["pass", "TERBIT", "TERBIT", null]);
    const serah = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "tier SERAH", changes: { advanced: { "artifact.tier": "SERAH" } } }, caller);
    const row = versionRow(COPY, serah.version.versionNo);
    const repS = JSON.parse(String(row.guard_report)) as Report;
    const warns = repS.checks.filter((c) => c.outcome === "warn").map((c) => [c.id, c.reason]);
    console.log(`row67: SERAH copy v${serah.version.versionNo} verdict=${row.guard_verdict} lintTier=${repS.lintTier} lintParamTier=${repS.lintParamTier} releaseStatus=${JSON.stringify(repS.releaseStatus)} warns=${JSON.stringify(warns)}`);
    expect([row.guard_verdict, repS.lintTier, repS.lintParamPin, repS.lintParamTier]).toEqual(["warn", "SERAH", "equal", "SERAH"]);
    expect(warns).toEqual([
      ["D01", "REFERENCE_FAILS"],
      ["D16", "REFERENCE_FAILS"],
    ]);
  });

  test("U.1 step 5 fail closed: LAYOUT_NOT_MEASURED (real: the bridge refuses checkPage) and LINT_MODULE_NOT_RUN -> GUARD_UNAVAILABLE, nothing saved", async () => {
    measureFails = true;
    try {
      const before = versionCount();
      const e = await errorOf(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: { advanced: { "cover.title.sizePt": 25 } } }, caller));
      expect([e.swarm, e.details.reason]).toEqual(["GUARD_UNAVAILABLE", "LAYOUT_NOT_MEASURED"]);
      expect(versionCount()).toBe(before);
    } finally {
      measureFails = false;
    }
    const notRun: typeof sampleMod.renderSample = async (side, doc, o) => {
      const out = await sampleMod.renderSample(side, doc, o);
      out.render!.log.entries.push({ level: "warn", message: "lint module structure not run: injected", code: "LINT_MODULE_NOT_RUN" } as never);
      return out;
    };
    service.configureTemplateGuard(guardMod.createTemplateGuard({ renderSampleImpl: notRun }));
    try {
      const before = versionCount();
      const e = await errorOf(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: { advanced: { "cover.title.sizePt": 25 } } }, caller));
      expect([e.swarm, e.details.reason]).toEqual(["GUARD_UNAVAILABLE", "LINT_MODULE_NOT_RUN"]);
      expect(versionCount()).toBe(before);
    } finally {
      service.configureTemplateGuard(realGuard);
    }
  });

  test("U.1 step 5: the 1 s whole-guard timeout -> GUARD_TIMEOUT; more than 4 waiting -> GUARD_BUSY; queued runs keep order", async () => {
    const slow = (ms: number): typeof sampleMod.renderSample => async (side, doc, o) => {
      await Bun.sleep(ms);
      return sampleMod.renderSample(side, doc, o);
    };
    const def = await gspDefinition();
    const input = async (n: number): Promise<TemplateGuardInput> => ({ op: "check", slug: "datum-gsp", lintTier: "TERBIT", reference: await gspReference(), candidate: unlockedCandidate(def), correlationId: `q-${n}` });
    const timed = guardMod.createTemplateGuard({ totalTimeoutMs: 1_000, renderSampleImpl: slow(1_500) });
    expect(await timed(await input(0))).toEqual({ verdict: "unavailable", reason: "GUARD_TIMEOUT" });
    const order: number[] = [];
    const queued = guardMod.createTemplateGuard({ maxWaiting: 4, renderSampleImpl: slow(50) });
    const inputs = await Promise.all([0, 1, 2, 3, 4, 5].map(input));
    const runs = await Promise.all(
      inputs.map((i, n) =>
        queued(i).then((r) => {
          order.push(n);
          return r.verdict === "unavailable" ? (r as { reason: string }).reason : r.verdict;
        }),
      ),
    );
    console.log(`row67: queue of 6 with 1 running + 4 waiting -> ${JSON.stringify(runs)} completion order ${JSON.stringify(order)}`);
    expect(runs).toEqual(["pass", "pass", "pass", "pass", "pass", "GUARD_BUSY"]);
    expect(order).toEqual([5, 0, 1, 2, 3, 4]);
  });
});

describe("row 67: verdict rules (U.2), pure", () => {
  const rep = (checks: LintIssue[]): LintReport => ({ tier: "TERBIT", checks, releaseStatus: "PASS", banner: "" });
  const pass = (id: string): LintIssue => ({ checkId: id, status: "PASS" });
  const fail = (id: string, detail = "x"): LintIssue => ({ checkId: id, status: "FAIL", detail });
  const report = (id: string): LintIssue => ({ checkId: id, status: "REPORT", detail: "r" });
  const entry = (c: ReturnType<typeof guardMod.compareLintReports>, id: string) => [...c.checks, ...c.unregistered].find((e) => e.id === id)!;

  test("S1 regression rejects; equal pre-existing failure warns REFERENCE_FAILS; a lost check rejects; fewer failures warn", () => {
    const c = guardMod.compareLintReports(rep([pass("DATUM-05"), fail("DATUM-10"), pass("DATUM-21"), fail("D06"), fail("D06")]), rep([fail("DATUM-05"), fail("DATUM-10"), { checkId: "DATUM-21", status: "NOT_RUN" }, fail("D06")]), "TERBIT");
    expect([entry(c, "DATUM-05").outcome, entry(c, "DATUM-05").reason]).toEqual(["reject", "REGRESSION"]);
    expect([entry(c, "DATUM-10").outcome, entry(c, "DATUM-10").reason]).toEqual(["warn", "REFERENCE_FAILS"]);
    expect([entry(c, "DATUM-21").outcome, entry(c, "DATUM-21").reason]).toEqual(["reject", "CHECK_LOST"]);
    expect([entry(c, "D06").outcome, entry(c, "D06").reason]).toEqual(["warn", "REFERENCE_FAILS"]);
    expect(c.verdict).toBe("reject");
  });

  test("§9 (4) G3 / S2: a new DATUM-36 REPORT (even a FAIL) only warns; the same REPORT on both sides passes", () => {
    const a = guardMod.compareLintReports(rep([pass("DATUM-36")]), rep([report("DATUM-36")]), "TERBIT");
    expect([entry(a, "DATUM-36").class, entry(a, "DATUM-36").outcome, a.verdict]).toEqual(["S2", "warn", "warn"]);
    const b = guardMod.compareLintReports(rep([pass("DATUM-36")]), rep([fail("DATUM-36")]), "TERBIT");
    expect([entry(b, "DATUM-36").outcome, b.verdict]).toEqual(["warn", "warn"]);
    const c = guardMod.compareLintReports(rep([report("C-INFO-OPENER")]), rep([report("C-INFO-OPENER")]), "TERBIT");
    expect([entry(c, "C-INFO-OPENER").outcome, c.verdict]).toEqual(["pass", "pass"]);
  });

  test("S3 eye half, S4 human, S5 by design (D01-D03, D07 at TERBIT; notRunReason C ids), unregistered ids under S1", () => {
    const c = guardMod.compareLintReports(rep([pass("DATUM-08"), pass("D01"), pass("X-NEW")]), rep([fail("DATUM-08"), fail("D01"), fail("X-NEW"), fail("C-14")]), "TERBIT");
    expect([entry(c, "DATUM-08").class, entry(c, "DATUM-08").outcome, entry(c, "DATUM-08").eye]).toEqual(["S3", "reject", "MANUAL_NOT_CHECKED"]);
    expect([entry(c, "H01").class, entry(c, "H01").outcome]).toEqual(["S4", "manual"]);
    expect([entry(c, "D01").class, entry(c, "D01").outcome]).toEqual(["S5", "not-run"]);
    expect([entry(c, "C-14").class, entry(c, "C-14").outcome]).toEqual(["S5", "not-run"]);
    expect([entry(c, "X-NEW").class, entry(c, "X-NEW").outcome]).toEqual(["unregistered", "reject"]);
    const s = guardMod.compareLintReports(rep([pass("D01")]), rep([fail("D01")]), "SERAH");
    expect([entry(s, "D01").class, entry(s, "D01").outcome]).toEqual(["S1", "reject"]);
  });

  test("report cap: a report over 64 KiB is cut to fit (issue details first)", () => {
    // Every automated registry id fails 20 times with 290-char details on the candidate only.
    const many = registry.LINT_REGISTRY.flatMap((d) => Array.from({ length: 20 }, (_, i) => fail(d.id, `${"d".repeat(290)}${i}`)));
    const c = guardMod.compareLintReports(rep([]), rep(many), "TERBIT");
    expect(entry(c, "DATUM-05").issues!.length).toBe(guardMod.GUARD_MAX_ISSUES_PER_CHECK);
    const full = { checks: c.checks, unregistered: c.unregistered, jobWarnings: [] } as unknown as Report;
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(guardMod.GUARD_REPORT_MAX_BYTES);
    const fitted = guardMod.fitReport(full);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(guardMod.GUARD_REPORT_MAX_BYTES);
    expect(fitted.checks.length).toBe(registry.LINT_REGISTRY_COUNT);
  });
});

describe("row 67: preview with sample content (U.4)", () => {
  test("a stored version -> DOCX, HTML, PDF sample renders kept as kind 'preview' rows; names and parent folder without underscore; lint attached", async () => {
    const before = previewRows().length;
    const r = await preview.previewTemplate({ slug: "datum-gsp", formats: ["docx", "html", "pdf"] });
    expect(r.files.map((f) => f.format).sort()).toEqual(["DOCX", "HTML", "PDF"]);
    expect(r.failed).toEqual([]);
    for (const f of r.files) {
      expect(f.relPath).toMatch(/^tmp\/preview\/[0-9a-f-]{36}\/GSP Pratinjau Templat\.(docx|html|pdf)$/);
      expect(path.basename(f.relPath).includes("_") || path.basename(path.dirname(f.relPath)).includes("_")).toBe(false);
      const bytes = readFileSync(path.join(ROOT, f.relPath));
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(f.sha256);
    }
    const docx = readFileSync(path.join(ROOT, r.files.find((f) => f.format === "DOCX")!.relPath));
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(readFileSync(path.join(ROOT, r.files.find((f) => f.format === "PDF")!.relPath)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(readFileSync(path.join(ROOT, r.files.find((f) => f.format === "HTML")!.relPath), "utf8")).toContain("Rencana dan realisasi pemasangan saluran per segmen.");
    const rows = previewRows().slice(before);
    expect(rows.length).toBe(3);
    for (const row of rows) expect([row.kind, row.document_id, row.revision_id, row.template_version_id, row.lint_verdict]).toEqual(["preview", null, null, r.template.versionId, "PASS"]);
    expect(r.lint!.releaseStatus).toBe("PASS");
    console.log(`row67: preview ${r.previewId} files=${JSON.stringify(r.files.map((f) => [f.fileName, f.bytes]))} lint=${r.lint!.releaseStatus} checks=${r.lint!.checks.length} tier=${r.tier} language=${r.language} durationMs=${r.durationMs}`);
  });

  test("an unsaved definition (case 06 V = 26) previews after the form check; A-U2 does not hold: datum-gsp-preset's own cover-title run (szHalfPt 50) wins, so the DOCX w:sz set is unchanged; Calibri is never rendered; png refused", async () => {
    const def = await gspDefinition();
    def.advanced = { ...(def.advanced ?? {}), "cover.title.sizePt": 26 };
    const r = await preview.previewTemplate({ template: def, base: { slug: "datum-gsp" }, formats: ["docx"] });
    expect(r.template).toEqual({ slug: null, versionNo: null, versionId: null, unsaved: true, changedKeys: 1 });
    const szOf = (relPath: string) => {
      const xml = new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(path.join(ROOT, relPath))))["word/document.xml"]);
      return new Set([...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((m) => Number(m[1])));
    };
    const cand = szOf(r.files[0].relPath);
    const ref = szOf((await preview.previewTemplate({ slug: "datum-gsp", formats: ["docx"] })).files[0].relPath);
    console.log(`row67: w:sz values candidate=${JSON.stringify([...cand].sort((a, b) => a - b))} reference=${JSON.stringify([...ref].sort((a, b) => a - b))}`);
    // Both render the cover title at w:sz 50 (templates/datum-gsp-preset.json roleFormats cover.titleFirst/titleLast
    // run.szHalfPt 50, which wins over cover.title.sizePt per formats.ts pick); V = 26 has no DOCX effect.
    expect(cand.has(50) && ref.has(50)).toBe(true);
    expect(cand.has(52)).toBe(false);
    expect([...cand].sort((a, b) => a - b)).toEqual([...ref].sort((a, b) => a - b));
    expect(r.tier).toBe("TERBIT");

    const rows = previewRows().length;
    const bad = await gspDefinition();
    bad.advanced = { ...(bad.advanced ?? {}), "type.face.serif": "Calibri" };
    const e = await errorOf(preview.previewTemplate({ template: bad, base: { slug: "datum-gsp" }, formats: ["docx"] }));
    expect([e.swarm, e.details.reason]).toEqual(["TEMPLATE_FORM_LOCKED", "category:tipografi"]);
    const p = await errorOf(preview.previewTemplate({ slug: "datum-gsp", formats: ["png"] }));
    expect(p.code).toBe("SCHEMA_INVALID");
    expect(JSON.stringify(p.details)).toContain("docx, html, pdf");
    expect(previewRows().length).toBe(rows);
  });

  test("studio_template_check with the guard: valid copy -> pass, saves nothing; no guard -> GUARD_NOT_CONFIGURED", async () => {
    const before = versionCount();
    const def = await gspDefinition();
    const ok = await preview.checkTemplateWithGuard({ template: def, base: { slug: "datum-gsp" } });
    expect([ok.valid, ok.guard?.verdict]).toEqual([true, "pass"]);
    const none = await preview.checkTemplateWithGuard({ template: def, base: { slug: "datum-gsp" } }, null);
    expect([none.valid, none.code, none.guard?.reason]).toEqual([false, "GUARD_UNAVAILABLE", "GUARD_NOT_CONFIGURED"]);
    expect(versionCount()).toBe(before);
  });

  test("durable log: guard and preview lines are JSON with correlation ids", () => {
    const lines = readFileSync(TPL_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Raw);
    const codes = new Set(lines.map((l) => l.code));
    for (const c of ["GUARD_DONE", "GUARD_REJECTED", "GUARD_UNAVAILABLE", "TEMPLATE_PREVIEW_RENDERED"]) expect([c, codes.has(c)]).toEqual([c, true]);
    const busy = lines.find((l) => l.code === "GUARD_UNAVAILABLE" && (l.context as Raw).reason === "GUARD_BUSY")!;
    expect(busy.level).toBe("warn");
    expect(typeof busy.correlationId).toBe("string");
  });
});
