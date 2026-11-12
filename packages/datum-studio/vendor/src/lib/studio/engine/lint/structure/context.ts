/**
 * Konteks bersama cek struktur: snapshot, templat, tier, hasil penjelajahan,
 * akses parameter bertipe, dan pengumpul temuan per cek.
 */
import type {
  AdaptReportV1,
  AnyNormSnapshot,
  CompletenessReportV2,
  LintIssue,
  NormDocSnapshotV2,
  ParamMap,
  ParamValue,
  RegisterEntry,
  ResolvedTemplate,
  StudioDocV1,
  StudioTier,
} from "../../../contract";
import { isNormSnapshotV2 } from "../../../contract";
import { addressFor, walkDoc, type DocWalk } from "./walk";

/** Plafon temuan FAIL/REPORT per cek; sisanya diringkas satu temuan. */
export const MAX_FINDINGS_PER_CHECK = 100;

export interface StructCtx {
  /** Snapshot apa adanya (`studio.norm/v1` atau `studio.norm/v2`). */
  snap: AnyNormSnapshot;
  /** Snapshot v2 (kerangka slot + konten v2 tergabung); undefined untuk v1. */
  v2?: NormDocSnapshotV2;
  /** Laporan kelengkapan layanan (I48) bila pemanggil memilikinya; mengungguli penilaian ulang dari snapshot. */
  completeness?: CompletenessReportV2;
  /** Laporan adaptor v1 -> v2 (LD-03/LD-04) dari pemanggil; bila absen dibaca dari snapshot. */
  adaptReport?: AdaptReportV1;
  /** Bentuk internal mesin (v1: dokumen; v2: hasil compose `snapshot.doc`). */
  doc: StudioDocV1;
  tpl: ResolvedTemplate;
  tier: StudioTier;
  params: ParamMap;
  walk: DocWalk;
  /** Register snapshot (ternormalisasi ingest) atau register dokumen. */
  register: Readonly<Record<string, RegisterEntry>>;
}

/** Masukan tambahan konteks (SR-18): data kelengkapan/adaptor dari pemanggil. */
export interface StructCtxExtras {
  completeness?: CompletenessReportV2;
  adaptReport?: AdaptReportV1;
}

export function makeCtx(snap: AnyNormSnapshot, tpl: ResolvedTemplate, tier: StudioTier, extras: StructCtxExtras = {}): StructCtx {
  const doc = snap.doc;
  const register = snap.register && Object.keys(snap.register).length > 0 ? snap.register : (doc.register ?? {});
  return {
    snap,
    ...(isNormSnapshotV2(snap) ? { v2: snap } : {}),
    ...(extras.completeness ? { completeness: extras.completeness } : {}),
    ...(extras.adaptReport ? { adaptReport: extras.adaptReport } : {}),
    doc,
    tpl,
    tier,
    params: tpl.params ?? {},
    walk: walkDoc(snap),
    register,
  };
}

// ── Parameter ─────────────────────────────────────────────────────────────

export function pBool(ctx: StructCtx, key: string, dflt: boolean): boolean {
  const v = ctx.params[key];
  return typeof v === "boolean" ? v : dflt;
}

/**
 * Parameter kelas T per tier (P5-46, P5-47, P5-68: `derive` auditByTier /
 * serahByTier). Nilai terselesaikan templat diturunkan dari `artifact.tier`
 * templat, maka hanya dipakai bila tier itu sama dengan tier lint; selain itu
 * aturan turunannya dihitung untuk tier lint.
 */
export function pTierBool(ctx: StructCtx, key: string, derive: (tier: StudioTier) => boolean): boolean {
  const v = ctx.params[key];
  if (typeof v === "boolean" && ctx.params["artifact.tier"] === ctx.tier) return v;
  return derive(ctx.tier);
}

export function pNum(ctx: StructCtx, key: string, dflt: number): number {
  const v = ctx.params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

export function pStrList(ctx: StructCtx, key: string): string[] | undefined {
  const v = ctx.params[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

export function pRaw(ctx: StructCtx, key: string): ParamValue | undefined {
  return ctx.params[key];
}

// ── Temuan ────────────────────────────────────────────────────────────────

export interface Finding {
  pointer?: string;
  address?: string;
  detail: string;
  status?: "FAIL" | "REPORT";
}

/** Hasil satu cek: daftar temuan (kosong = PASS) atau NOT_RUN beralasan. */
export type CheckOutcome =
  | { kind: "findings"; findings: Finding[]; passDetail: string }
  | { kind: "notRun"; reason: string };

export function findings(list: Finding[], passDetail: string): CheckOutcome {
  return { kind: "findings", findings: list, passDetail };
}

export function notRun(reason: string): CheckOutcome {
  return { kind: "notRun", reason };
}

export function toIssues(ctx: StructCtx, checkId: string, out: CheckOutcome): LintIssue[] {
  if (out.kind === "notRun") return [{ checkId, status: "NOT_RUN", detail: out.reason }];
  if (out.findings.length === 0) return [{ checkId, status: "PASS", detail: out.passDetail }];
  const issues: LintIssue[] = [];
  for (const f of out.findings.slice(0, MAX_FINDINGS_PER_CHECK)) {
    const address = f.address ?? (f.pointer ? addressFor(ctx.walk, f.pointer) : undefined);
    issues.push({
      checkId,
      status: f.status ?? "FAIL",
      detail: f.detail,
      ...(address ? { address } : {}),
      ...(f.pointer ? { pointer: f.pointer } : {}),
    });
  }
  const rest = out.findings.length - MAX_FINDINGS_PER_CHECK;
  if (rest > 0) {
    const anyFail = out.findings.slice(MAX_FINDINGS_PER_CHECK).some((f) => (f.status ?? "FAIL") === "FAIL");
    // Swarm patch (1.2.6 row 49, T-14): the summary row keeps the cap (E-16, 100 itemised) and carries the full
    // ordered list of this check's findings with the chapter key of each, so studio_document_status `findings`
    // (register N-033) can page all of them and filter per chapter.
    // FX-7 (M2 S6): the stored list is bounded (LINT_FINDINGS_STORED_MAX entries, details cut to
    // LINT_FINDING_DETAIL_MAX chars); past the bound the row says how many were found and how many were not stored.
    const notStored = Math.max(0, out.findings.length - LINT_FINDINGS_STORED_MAX);
    const summary: LintIssue & { findingsAll: FullFinding[]; findingsTotal?: number; findingsNotStored?: number } = {
      checkId,
      status: anyFail ? "FAIL" : "REPORT",
      detail: `${rest} temuan lain tidak dirinci (plafon ${MAX_FINDINGS_PER_CHECK} per cek)`,
      findingsAll: out.findings.slice(0, LINT_FINDINGS_STORED_MAX).map((f) => fullFinding(ctx, f)),
      ...(notStored > 0 ? { findingsTotal: out.findings.length, findingsNotStored: notStored } : {}),
    };
    issues.push(summary);
  }
  return issues;
}

/**
 * Swarm 1.2.6 (FX-7, M2 S6): bound of the finding list stored on a check's summary row (every revision's lint
 * record carries it): at most this many entries, the rest only counted (`findingsTotal`, `findingsNotStored`).
 */
export const LINT_FINDINGS_STORED_MAX = 2000;
/** FX-7 (M2 S6): a stored finding detail is cut to this many characters (the findings page prints 300). */
export const LINT_FINDING_DETAIL_MAX = 300;

/** Swarm patch (1.2.6 row 49, T-14): one entry of the full finding list kept on the summary row. */
export interface FullFinding {
  status: "FAIL" | "REPORT";
  detail: string;
  address?: string;
  pointer?: string;
  /** Key of the chapter or appendix unit holding the pointer (`ch.key` or its number), when there is one. */
  chapter?: string;
}

function fullFinding(ctx: StructCtx, f: Finding): FullFinding {
  const address = f.address ?? (f.pointer ? addressFor(ctx.walk, f.pointer) : undefined);
  let chapter: string | undefined;
  if (f.pointer) {
    let best = -1;
    for (const u of ctx.walk.units) {
      if ((f.pointer === u.pointer || f.pointer.startsWith(`${u.pointer}/`)) && u.pointer.length > best) {
        best = u.pointer.length;
        chapter = u.key;
      }
    }
  }
  return {
    status: f.status ?? "FAIL",
    detail: f.detail.length > LINT_FINDING_DETAIL_MAX ? `${f.detail.slice(0, LINT_FINDING_DETAIL_MAX - 1)}…` : f.detail,
    ...(address ? { address } : {}),
    ...(f.pointer ? { pointer: f.pointer } : {}),
    ...(chapter !== undefined ? { chapter } : {}),
  };
}
