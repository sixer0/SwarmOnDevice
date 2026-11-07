/**
 * Gerbang by-construction ingest (A10, D-34, IP-06; S48 + INT-C).
 *
 * - Lint tahap ingest dijalankan lewat modul lint (S44 `byConstructionChecks`
 *   dan `runLint({ stage: "ingest" })`); modul yang belum tersedia atau gagal
 *   dicatat NOT_RUN dengan alasan, tidak pernah dianggap PASS (KT-13) dan
 *   tidak pernah menahan ingest (A10).
 * - Keputusan penahan 422 SATU sumber: `ingestPolicy` engine/lint/scan, di
 *   atas `resolveEnforcement`/`effectiveEnforcement` engine/lint/structure
 *   (S46). FAIL menahan bila mode efektif cek = "block" (default registri
 *   `blocksIngest`, ditimpa `lint.enforcementOverride` profil templat dan
 *   `doc.x.lintEnforcement`) dan cek berlaku untuk tier dokumen; G1 dan
 *   DATUM-11 menahan di semua tier dan tidak dapat dilepas override.
 * - ATURAN PENGAMAN D-34: dokumen/profil benchmark (penanda `x.benchmark`,
 *   `x.enforcement = "report"`, atau opsi `enforcement: "report"`) menurunkan
 *   SEMUA penahan menjadi penentu status rilis: tetap tercatat FAIL di laporan
 *   lint, rilis FAIL, ingest tidak ditolak.
 */
import type {
  LintIssue,
  LintReport,
  NormDocSnapshot,
  ResolvedTemplate,
  StudioDocV1,
  StudioTier,
  ValidationIssue,
} from "../../contract";
import { StudioNotImplemented } from "../../contract/errors";
import { byConstructionChecks, D34_NOTE, ingestPolicy, isBenchmarkDoc, runLint } from "../../engine/lint/scan";
import { getLintDef } from "../../registry/lint";
import { ingestLog } from "./log";

export { D34_NOTE, isBenchmarkDoc };

export type IngestEnforcement = "reject" | "report";

/** Mode ingest: "report" bila opsi pemanggil atau penanda benchmark D-34. */
export function resolveIngestEnforcement(doc: StudioDocV1, opt?: IngestEnforcement): IngestEnforcement {
  if (opt === "report" || isBenchmarkDoc(doc)) return "report";
  return "reject";
}

export interface GateInput {
  doc: StudioDocV1;
  snapshot: NormDocSnapshot;
  tpl: ResolvedTemplate;
  tier: StudioTier;
  /** Temuan intrinsik ingest (checks.ts). */
  intrinsic: LintIssue[];
  enforcement: IngestEnforcement;
  correlationId: string;
}

export interface GateResult {
  lint: LintReport;
  /** Penahan (mode reject) dalam bentuk ValidationIssue ber-checkId. */
  blocking: ValidationIssue[];
  /** Penahan yang diturunkan D-34 (mode report). */
  downgraded: LintIssue[];
  /** Modul lint yang tidak berjalan (alasan). */
  notRun: string[];
}

function issueKey(i: LintIssue): string {
  return `${i.checkId}\u0000${i.pointer ?? ""}\u0000${i.address ?? ""}\u0000${i.detail ?? ""}`;
}

function runSafely<T>(label: string, fn: () => T, notRun: string[], correlationId: string): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StudioNotImplemented) {
      notRun.push(`${label}: modul belum tersedia (${e.moduleId})`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      notRun.push(`${label}: gagal (${msg})`);
      // A10: lint tidak pernah menahan pembuatan berkas; galat modul dicatat tahan lama.
      ingestLog({
        level: "error",
        message: `${label} gagal; dicatat NOT_RUN`,
        correlationId,
        code: "LINT_MODULE_FAILED",
        stack_trace: e instanceof Error ? e.stack : undefined,
        context: { error: msg },
      });
    }
    return null;
  }
}

export function runGate(i: GateInput): GateResult {
  const notRun: string[] = [];
  const policy = ingestPolicy(i.doc, i.tpl, { benchmark: i.enforcement === "report" });
  const byc =
    runSafely("lint.scan.byConstructionChecks", () => byConstructionChecks(i.snapshot.doc, i.tpl, { benchmark: policy.benchmark }), notRun, i.correlationId) ?? [];
  const report = runSafely("lint.scan.runLint(ingest)", () => runLint({ snapshot: i.snapshot, tpl: i.tpl, tier: i.tier, stage: "ingest" }), notRun, i.correlationId);

  const checks: LintIssue[] = [];
  const seen = new Set<string>();
  for (const c of [...i.intrinsic, ...byc, ...(report?.checks ?? [])]) {
    const k = issueKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    checks.push(c);
  }

  const blocking: ValidationIssue[] = [];
  const downgraded: LintIssue[] = [];
  for (const c of checks) {
    const decision = policy.decide(c, i.tier);
    if (decision === "downgrade") {
      c.detail = c.detail ? `${c.detail} [${D34_NOTE}]` : D34_NOTE;
      downgraded.push(c);
    } else if (decision === "block") {
      blocking.push({
        pointer: c.pointer ?? "",
        keyword: "byConstruction",
        message: `${c.checkId}${c.address ? ` @ ${c.address}` : ""}: ${c.detail ?? getLintDef(c.checkId)?.title ?? "gagal"}`,
        checkId: c.checkId,
      });
    }
  }

  const anyFail = checks.some((c) => c.status === "FAIL");
  const releaseStatus: LintReport["releaseStatus"] = anyFail ? "FAIL" : report ? report.releaseStatus : "NOT_RUN";
  const banners: string[] = [];
  if (report?.banner) banners.push(report.banner);
  else banners.push("Lint tahap ingest; status rilis final ditetapkan lint pasca-render.");
  if (downgraded.length > 0) banners.push(`${D34_NOTE}: ${downgraded.length} temuan.`);
  if (notRun.length > 0) banners.push(`NOT_RUN: ${notRun.join("; ")}`);

  return {
    lint: { tier: report?.tier ?? i.tier, checks, releaseStatus, banner: banners.join(" ") },
    blocking,
    downgraded,
    notRun,
  };
}
