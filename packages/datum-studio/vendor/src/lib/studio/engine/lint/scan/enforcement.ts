/**
 * Keputusan penahan ingest (422) yang seragam untuk modul scan, layanan
 * ingest (S48) dan layanan revisi (S50) — IP-06, D-34, D-70.
 *
 * Mode efektif tiap cek berasal dari satu sumber: `resolveEnforcement` /
 * `effectiveEnforcement` engine/lint/structure (S46), yaitu default registri
 * (`blocksIngest` -> "block") ditimpa profil templat
 * (`lint.enforcementOverride`, semua mode) dan dokumen
 * (`doc.x.lintEnforcement`, hanya block -> release). Hanya mode "block" yang
 * menahan ingest, dan hanya bila cek berlaku untuk tier dokumen.
 *
 * Dua aturan di atas override:
 *  - Cek integritas (G1, DATUM-11) selalu "block" di semua tier: renderer
 *    tidak dapat membangun berkas tanpanya, maka override profil/dokumen tidak
 *    melepasnya.
 *  - ATURAN PENGAMAN D-34: penanda benchmark (`x.benchmark` objek/true,
 *    `x.enforcement = "report"`, atau opsi pemanggil) menurunkan SEMUA penahan
 *    (integritas termasuk) menjadi penentu status rilis: tetap FAIL di laporan
 *    lint, rilis FAIL, ingest tidak ditolak.
 */
import type { LintIssue, ResolvedTemplate, StudioDocV1, StudioTier } from "../../../contract";
import { getLintDef } from "../../../registry/lint";
import { effectiveEnforcement, resolveEnforcement, type EnforcementResolution, type LintEnforcement } from "../structure";

/** Cek integritas yang menahan di semua tier dan tidak dapat dilepas override. */
export const INTEGRITY_CHECKS: ReadonlySet<string> = new Set(["G1", "DATUM-11"]);

export const D34_NOTE = "D-34: penahan by-construction diturunkan menjadi penentu status rilis (dokumen/profil benchmark)";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Penanda benchmark D-34 di dokumen (meta tidak menerima medan tambahan; penanda tinggal di `x`). */
export function isBenchmarkDoc(doc: Pick<StudioDocV1, "x"> | undefined): boolean {
  const x = doc?.x;
  if (!isRecord(x)) return false;
  return x.enforcement === "report" || x.benchmark === true || isRecord(x.benchmark);
}

/** "block" = 422; "downgrade" = penahan diturunkan D-34; "pass" = tidak menahan. */
export type IngestDecision = "block" | "downgrade" | "pass";

export interface IngestPolicy {
  readonly resolution: EnforcementResolution;
  /** Aturan pengaman D-34 aktif. */
  readonly benchmark: boolean;
  /** Mode efektif cek (integritas selalu "block"); undefined = di luar registri. */
  mode(checkId: string): LintEnforcement | undefined;
  /** true bila FAIL cek ini menahan ingest untuk tier (sebelum D-34). */
  blocks(checkId: string, tier: StudioTier): boolean;
  /** Keputusan untuk satu temuan. */
  decide(issue: LintIssue, tier: StudioTier): IngestDecision;
}

export function ingestPolicy(
  doc: Pick<StudioDocV1, "x"> | undefined,
  tpl?: Pick<ResolvedTemplate, "params">,
  opts?: { benchmark?: boolean },
): IngestPolicy {
  const resolution = resolveEnforcement(tpl, doc);
  const benchmark = opts?.benchmark === true || isBenchmarkDoc(doc);
  const mode = (checkId: string): LintEnforcement | undefined =>
    INTEGRITY_CHECKS.has(checkId) ? "block" : effectiveEnforcement(checkId, resolution);
  const blocks = (checkId: string, tier: StudioTier): boolean => {
    const def = getLintDef(checkId);
    if (!def || mode(checkId) !== "block") return false;
    return INTEGRITY_CHECKS.has(checkId) || def.tiers.includes(tier);
  };
  return {
    resolution,
    benchmark,
    mode,
    blocks,
    decide(issue, tier) {
      if (issue.status !== "FAIL" || !blocks(issue.checkId, tier)) return "pass";
      return benchmark ? "downgrade" : "block";
    },
  };
}
