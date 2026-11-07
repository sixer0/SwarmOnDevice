/**
 * Modul engine/lint/structure (I36, 01_specs.md §8.2), diisi S46.
 *
 * `lintStructure` menjalankan 48 entri registri lint bermodul "structure":
 * grup D (D01-D21: audit angka terhadap register, turunan dihitung ulang,
 * logo sekali, section wajib per tier, labels_verified, Admiralty sekali, ...),
 * lint rilis struktur v2 (SR-18, LD-01..LD-03: SLOT_CONTENT_MISSING,
 * CONTENT_CHAPTER_GAP, SCHEMA_V1_ADAPTED; ./checks-slots) dan penegasan 24
 * butir grup A bermode HQ "S" (by-construction) pada snapshot ternormalisasi
 * `studio.norm/v1` maupun `studio.norm/v2`. LD-04 INLINE_FORMAT_STRIPPED
 * (registri: modul scan) ikut dilaporkan dari sini karena sumber datanya
 * laporan adaptor v1 yang sama. Hanya cek yang berlaku untuk `tier` (LintDef.tiers)
 * yang dijalankan; NOTA melepas lint (Tabel 3.1 P3-08).
 *
 * Bentuk hasil (dikonsumsi runner engine/lint/scan S44 dan layanan render S51):
 * setiap cek berlaku menghasilkan minimal satu LintIssue — PASS (detail
 * ringkasan), FAIL/REPORT per temuan (address §4.1 + pointer JSON ke
 * `snapshot.doc`), atau NOT_RUN beralasan (parameter menonaktifkan, data
 * prasyarat tidak ada). Ditambah temuan REPORT `STRUCT-XREF` untuk rujukan
 * prosa basi (§4.2 butir 4).
 *
 * Penegakan (D-34): mode per cek dari registri dapat ditimpa per profil
 * templat (`lint.enforcementOverride`) atau, hanya untuk penurunan block ->
 * release, per dokumen (`doc.x.lintEnforcement`); lihat ./enforcement.
 * Fungsi ini tidak pernah melempar karena data dokumen: cek yang gagal
 * dijalankan dilaporkan NOT_RUN dengan alasannya.
 */
import type { AdaptReportV1, AnyNormSnapshot, CompletenessReportV2, LintIssue, ResolvedTemplate, StudioTier } from "../../../contract";
import { LINT_REGISTRY, type LintDef } from "../../../registry/lint";
import { STRUCTURE_A_CHECKS } from "./checks-a";
import { STALE_XREF_CHECK_ID, STRUCTURE_D_CHECKS, staleXrefs } from "./checks-d";
import { INLINE_FORMAT_STRIPPED_ID, STRUCTURE_SLOT_CHECKS, inlineFormatStripped } from "./checks-slots";
import { makeCtx, toIssues, type CheckOutcome, type StructCtx } from "./context";
import { applyEnforcement, resolveEnforcement, safetyOverridesFrom } from "./enforcement";

export {
  ENFORCEMENT_DOC_KEY,
  ENFORCEMENT_PARAM_KEY,
  LINT_ENFORCEMENT_MODES,
  applyEnforcement,
  defaultEnforcement,
  effectiveEnforcement,
  isIngestBlocking,
  resolveEnforcement,
  safetyOverridesFrom,
  type EnforcementMap,
  type EnforcementResolution,
  type LintEnforcement,
} from "./enforcement";
export { STALE_XREF_CHECK_ID } from "./checks-d";
export {
  ADAPT_REPORT_X_KEY,
  CONTENT_CHAPTER_GAP_ID,
  INLINE_FORMAT_STRIPPED_ID,
  SCHEMA_V1_ADAPTED_ID,
  SLOT_CONTENT_MISSING_ID,
  assessSlots,
  chapterProgress,
  type LintSlotStatus,
  type SlotAssessment,
} from "./checks-slots";

/** CheckId temuan override penegakan yang ditolak (di luar registri, selalu REPORT). */
export const ENFORCEMENT_CHECK_ID = "STRUCT-ENFORCEMENT";
export { MAX_FINDINGS_PER_CHECK } from "./context";

/** Registri cek struktur (48 = 24 grup A "S" + 21 grup D + 3 lint rilis struktur v2 LD-01..LD-03). */
export const STRUCTURE_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  ...STRUCTURE_A_CHECKS,
  ...STRUCTURE_D_CHECKS,
  ...STRUCTURE_SLOT_CHECKS,
};

/** Entri registri bermodul "structure" (urutan registri). */
export const STRUCTURE_LINT_DEFS: readonly LintDef[] = LINT_REGISTRY.filter((d) => d.module === "structure");

/** Id registri bermodul structure yang belum punya implementasi (harus kosong). */
export function structureCoverageGaps(): string[] {
  return STRUCTURE_LINT_DEFS.map((d) => d.id).filter((id) => !STRUCTURE_CHECKS[id]);
}

export interface LintStructureOptions {
  /** Jalankan juga cek yang tidak berlaku untuk tier (diagnostik, harness benchmark). */
  includeOutOfTier?: boolean;
  /** Abaikan override profil/dokumen (laporan mentah registri, untuk aturan pengaman D-34). */
  ignoreEnforcement?: boolean;
  /** Batasi ke id tertentu. */
  only?: readonly string[];
  /** Laporan kelengkapan layanan (I48); bila ada, LD-01/LD-02 memakainya, bukan penilaian ulang snapshot. */
  completeness?: CompletenessReportV2;
  /** Laporan adaptor v1 (LD-03/LD-04); bila absen dibaca dari `snapshot.source.x` / `snapshot.doc.x`. */
  adaptReport?: AdaptReportV1;
}

function runOne(ctx: StructCtx, def: LintDef): LintIssue[] {
  if (def.notRunReason) return [{ checkId: def.id, status: "NOT_RUN", detail: def.notRunReason }];
  const fn = STRUCTURE_CHECKS[def.id];
  if (!fn) return [{ checkId: def.id, status: "NOT_RUN", detail: "cek struktur belum diimplementasi" }];
  try {
    return toIssues(ctx, def.id, fn(ctx));
  } catch (e) {
    return [{ checkId: def.id, status: "NOT_RUN", detail: `cek gagal dijalankan: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

/** Varian berpilihan dari `lintStructure`. */
export function lintStructureWith(
  s: AnyNormSnapshot,
  tpl: ResolvedTemplate,
  tier: StudioTier,
  opts: LintStructureOptions = {},
): LintIssue[] {
  const ctx = makeCtx(s, tpl, tier, { completeness: opts.completeness, adaptReport: opts.adaptReport });
  const only = opts.only ? new Set(opts.only) : undefined;
  const out: LintIssue[] = [];
  for (const def of STRUCTURE_LINT_DEFS) {
    if (only && !only.has(def.id)) continue;
    if (!opts.includeOutOfTier && !def.tiers.includes(tier)) continue;
    out.push(...runOne(ctx, def));
  }
  if (!only || only.has(STALE_XREF_CHECK_ID)) {
    try {
      out.push(...toIssues(ctx, STALE_XREF_CHECK_ID, staleXrefs(ctx)).filter((i) => i.status !== "PASS"));
    } catch (e) {
      out.push({ checkId: STALE_XREF_CHECK_ID, status: "NOT_RUN", detail: `cek gagal dijalankan: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // LD-04 (registri: modul scan, semua tier) dari laporan adaptor yang sama dengan LD-03.
  if (!only || only.has(INLINE_FORMAT_STRIPPED_ID)) {
    try {
      out.push(...toIssues(ctx, INLINE_FORMAT_STRIPPED_ID, inlineFormatStripped(ctx)));
    } catch (e) {
      out.push({ checkId: INLINE_FORMAT_STRIPPED_ID, status: "NOT_RUN", detail: `cek gagal dijalankan: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (opts.ignoreEnforcement) return out;
  const res = resolveEnforcement(tpl, s.doc);
  const applied = applyEnforcement(out, res);
  for (const r of res.rejected) {
    applied.push({
      checkId: ENFORCEMENT_CHECK_ID,
      status: "REPORT",
      ...(r.source === "document" ? { pointer: "/x/lintEnforcement" } : {}),
      detail: `override penegakan ${r.source} untuk ${r.checkId} ditolak (${r.requested}): ${r.reason}`,
    });
  }
  return applied;
}

/** D01-D21 + LD-01..LD-04 + penegasan grup S by-construction (I36). */
export function lintStructure(s: AnyNormSnapshot, tpl: ResolvedTemplate, tier: StudioTier): LintIssue[] {
  return lintStructureWith(s, tpl, tier);
}

/**
 * Aturan pengaman D-34 untuk dokumen benchmark: jalankan lint struktur
 * mentah (semua tier, tanpa override) dan kembalikan `{checkId: "release"}`
 * untuk setiap entri `blocksIngest` yang terpicu. Hasilnya dipasang di
 * `lint.enforcementOverride` profil templat benchmark dan dicatat di register.
 */
export function benchmarkSafetyOverrides(s: AnyNormSnapshot, tpl: ResolvedTemplate): Record<string, "release"> {
  const raw = lintStructureWith(s, tpl, s.doc.meta.tier, { includeOutOfTier: true, ignoreEnforcement: true });
  return safetyOverridesFrom(raw);
}
