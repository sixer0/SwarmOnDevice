/**
 * Penegakan lint per profil/dokumen tanpa mengubah registri (D-34, F-018).
 *
 * Registri (`registry/lint.ts`) menetapkan default: `blocksIngest=true` ->
 * "block" (422 saat ingest + penentu status rilis), selain itu "release"
 * (FAIL menentukan status rilis), kecuali batas "lapor" -> "report".
 *
 * Override:
 *  1. Profil templat: `tpl.params["lint.enforcementOverride"]` =
 *     `{ "<checkId>": "block" | "release" | "report" | "off" }`. Templat
 *     dikendalikan admin (kelas K), maka semua mode diterima.
 *  2. Dokumen: `doc.x.lintEnforcement` dengan bentuk sama, TETAPI hanya
 *     boleh menurunkan "block" -> "release" (aturan pengaman D-34: entri
 *     blocksIngest yang terpicu dokumen benchmark menjadi penentu status
 *     rilis, tidak menolak ingest). Permintaan dokumen lain diabaikan dan
 *     dilaporkan lewat `rejected`. Sejak D-98 (F-047) medan ini hanya
 *     dihormati dari pemanggil tepercaya: ingest membuangnya untuk pemanggil
 *     lain (`ENFORCEMENT_OVERRIDE_STRIPPED`), sehingga dokumen tersimpan
 *     hanya membawanya bila di-ingest ADMINISTRATOR/harness.
 *  3. Profil yang melepas cek penolak = templat TERBATAS
 *     (`releasedBlockingChecks`, D-98).
 */
import type { LintIssue, ParamValue, ResolvedTemplate, StudioDocV1 } from "../../../contract";
import { LINT_REGISTRY, type LintDef } from "../../../registry/lint";

export const LINT_ENFORCEMENT_MODES = ["block", "release", "report", "off"] as const;
export type LintEnforcement = (typeof LINT_ENFORCEMENT_MODES)[number];

/** Kunci parameter profil templat (kandidat delta kontrak; lihat catatan S46). */
export const ENFORCEMENT_PARAM_KEY = "lint.enforcementOverride";
/** Kunci medan dokumen (`StudioDocV1.x`). */
export const ENFORCEMENT_DOC_KEY = "lintEnforcement";

export type EnforcementMap = Readonly<Record<string, LintEnforcement>>;

export interface EnforcementResolution {
  /** Mode efektif per checkId (hanya yang berbeda dari default registri). */
  overrides: EnforcementMap;
  /** Permintaan override yang ditolak (id tak dikenal, mode tak sah, dokumen menaikkan/menonaktifkan). */
  rejected: Array<{ source: "profile" | "document"; checkId: string; requested: string; reason: string }>;
}

const DEF_BY_ID: ReadonlyMap<string, LintDef> = new Map(LINT_REGISTRY.map((d) => [d.id, d]));

function isMode(v: unknown): v is LintEnforcement {
  return typeof v === "string" && (LINT_ENFORCEMENT_MODES as readonly string[]).includes(v);
}

/** Mode bawaan registri. */
export function defaultEnforcement(def: LintDef): LintEnforcement {
  if (def.blocksIngest) return "block";
  if (def.limit.trim().toLowerCase() === "lapor") return "report";
  return "release";
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Selesaikan override profil + dokumen. Tidak melempar: masukan rusak
 * dilaporkan di `rejected`.
 */
export function resolveEnforcement(
  tpl: Pick<ResolvedTemplate, "params"> | undefined,
  doc?: Pick<StudioDocV1, "x">,
): EnforcementResolution {
  const out: Record<string, LintEnforcement> = {};
  const rejected: EnforcementResolution["rejected"] = [];

  const profile = asRecord(tpl?.params?.[ENFORCEMENT_PARAM_KEY] as ParamValue | undefined);
  if (tpl?.params?.[ENFORCEMENT_PARAM_KEY] !== undefined && tpl.params[ENFORCEMENT_PARAM_KEY] !== null && !profile) {
    rejected.push({ source: "profile", checkId: "*", requested: String(tpl.params[ENFORCEMENT_PARAM_KEY]), reason: "bukan objek {checkId: mode}" });
  }
  for (const [id, mode] of Object.entries(profile ?? {})) {
    const def = DEF_BY_ID.get(id);
    if (!def) {
      rejected.push({ source: "profile", checkId: id, requested: String(mode), reason: "checkId tidak ada di registri lint" });
      continue;
    }
    if (!isMode(mode)) {
      rejected.push({ source: "profile", checkId: id, requested: String(mode), reason: `mode harus salah satu ${LINT_ENFORCEMENT_MODES.join("|")}` });
      continue;
    }
    if (mode !== defaultEnforcement(def)) out[id] = mode;
  }

  const docMap = asRecord(asRecord(doc?.x)?.[ENFORCEMENT_DOC_KEY]);
  for (const [id, mode] of Object.entries(docMap ?? {})) {
    const def = DEF_BY_ID.get(id);
    if (!def) {
      rejected.push({ source: "document", checkId: id, requested: String(mode), reason: "checkId tidak ada di registri lint" });
      continue;
    }
    const current = out[id] ?? defaultEnforcement(def);
    if (mode === "release" && current === "block") {
      out[id] = "release";
      continue;
    }
    if (mode === current) continue;
    rejected.push({
      source: "document",
      checkId: id,
      requested: String(mode),
      reason: "dokumen hanya boleh menurunkan block -> release (aturan pengaman D-34); mode lain lewat profil templat",
    });
  }
  return { overrides: out, rejected };
}

/**
 * F-047 / D-98: cek penolak (registri `blocksIngest`) yang DILEPAS profil
 * templat (`lint.enforcementOverride` = release|report|off). Daftar tidak
 * kosong = templat TERBATAS (hanya pemanggil tepercaya; lihat
 * `services/templates/access.ts`). Dihitung dari parameter efektif, bukan
 * flag tersimpan. Urut alfabet.
 */
export function releasedBlockingChecks(tpl: Pick<ResolvedTemplate, "params"> | undefined): string[] {
  const { overrides } = resolveEnforcement(tpl);
  return Object.entries(overrides)
    .filter(([id, mode]) => DEF_BY_ID.get(id)?.blocksIngest === true && mode !== "block")
    .map(([id]) => id)
    .sort();
}

/** Mode efektif satu cek. */
export function effectiveEnforcement(checkId: string, res: EnforcementResolution): LintEnforcement | undefined {
  const def = DEF_BY_ID.get(checkId);
  if (!def) return undefined;
  return res.overrides[checkId] ?? defaultEnforcement(def);
}

/** true = FAIL cek ini menolak ingest (422) untuk profil/dokumen ini. */
export function isIngestBlocking(
  checkId: string,
  tpl: Pick<ResolvedTemplate, "params"> | undefined,
  doc?: Pick<StudioDocV1, "x">,
): boolean {
  return effectiveEnforcement(checkId, resolveEnforcement(tpl, doc)) === "block";
}

/**
 * Terapkan mode ke daftar temuan: "report" mengubah FAIL -> REPORT,
 * "off" mengganti semua temuan cek menjadi satu NOT_RUN. "block"/"release"
 * tidak mengubah status (perbedaannya hanya di ingest).
 */
export function applyEnforcement(issues: readonly LintIssue[], res: EnforcementResolution): LintIssue[] {
  const out: LintIssue[] = [];
  const offDone = new Set<string>();
  for (const i of issues) {
    const mode = effectiveEnforcement(i.checkId, res);
    if (mode === "off") {
      if (offDone.has(i.checkId)) continue;
      offDone.add(i.checkId);
      out.push({ checkId: i.checkId, status: "NOT_RUN", detail: "dinonaktifkan oleh lint.enforcementOverride profil templat" });
      continue;
    }
    if (mode === "report" && i.status === "FAIL") {
      const def = DEF_BY_ID.get(i.checkId);
      const why = def && defaultEnforcement(def) === "report" ? "batas registri: lapor" : "diturunkan profil: report";
      out.push({ ...i, status: "REPORT", detail: i.detail ? `${i.detail} (${why})` : why });
      continue;
    }
    out.push(i);
  }
  return out;
}

/**
 * Aturan pengaman D-34: dari temuan lint dokumen benchmark, kembalikan peta
 * `{checkId: "release"}` untuk setiap entri `blocksIngest` yang FAIL. Peta
 * ini ditaruh di `lint.enforcementOverride` profil templat benchmark (S95)
 * atau `doc.x.lintEnforcement`, dan dicatat di register temuan.
 */
export function safetyOverridesFrom(issues: readonly LintIssue[]): Record<string, "release"> {
  const out: Record<string, "release"> = {};
  for (const i of issues) {
    if (i.status !== "FAIL") continue;
    const def = DEF_BY_ID.get(i.checkId);
    if (def?.blocksIngest) out[i.checkId] = "release";
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, "release" as const]));
}
