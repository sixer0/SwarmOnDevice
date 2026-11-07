/**
 * Kepercayaan penanda benchmark (IP-31, F-042, D-91).
 *
 * Penanda `doc.x.benchmark` (dan padanan D-34 `doc.x.enforcement`) memberi
 * dua efek pelonggaran: (1) penahan by-construction ingest diturunkan menjadi
 * status rilis (D-34), (2) turunan tanpa `result()` dirender verbatim
 * (`engine/bind` `isVerbatimReproduction`). Efek itu HANYA dihormati untuk:
 *  - pemanggil sesi ADMINISTRATOR (`caller.kind === "ADMIN_SESSION"`), atau
 *  - konteks harness/CLI server tanpa sesi HTTP: `opts.trustedHarness === true`.
 *    Flag ini hanya dapat diset kode server yang memanggil `ingestDocument`
 *    langsung; route API membentuk opsi sebagai literal (`{ dryRun }`) dan
 *    tidak pernah menyalinnya dari body/header.
 * Dokumen pemanggil lain (USER_SESSION, GOOGLE_SESSION, INTERNAL_AGENT)
 * DIBUANG penandanya sebelum validasi skema dan dicatat
 * `BENCHMARK_MARKER_STRIPPED` (log tahan lama + temuan REPORT di hasil lint).
 * Opsi `enforcement: "report"` dari konteks tidak tepercaya juga diabaikan.
 *
 * D-98 (F-047, INT-P): override penegakan dokumen `doc.x.lintEnforcement`
 * (D-70, penurunan block -> release) juga hanya dihormati dari konteks
 * tepercaya yang sama; pemanggil lain: dibuang sebelum skema, log
 * `ENFORCEMENT_OVERRIDE_STRIPPED` + temuan REPORT. Predikat kepercayaan satu
 * sumber: `isTrustedCaller` (services/templates/access, juga gerbang templat
 * terbatas).
 */
import type { LintIssue } from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { BENCHMARK_MARKER_KEY } from "../../engine/bind";
import { ENFORCEMENT_DOC_KEY } from "../../engine/lint/structure/enforcement";
import { isTrustedCaller } from "../templates/access";

/** Kode log/temuan saat penanda benchmark dibuang dari pemanggil tidak tepercaya. */
export const BENCHMARK_MARKER_STRIPPED = "BENCHMARK_MARKER_STRIPPED";

/** Kode log/temuan saat `doc.x.lintEnforcement` dibuang dari pemanggil tidak tepercaya (D-98). */
export const ENFORCEMENT_OVERRIDE_STRIPPED = "ENFORCEMENT_OVERRIDE_STRIPPED";

/** Kunci `doc.x` override penegakan dokumen (D-70). */
export const ENFORCEMENT_OVERRIDE_KEYS: readonly string[] = [ENFORCEMENT_DOC_KEY];

/** Kunci `doc.x` yang membawa efek benchmark/D-34 (lihat `isBenchmarkDoc` engine/lint/scan). */
export const BENCHMARK_MARKER_KEYS: readonly string[] = [BENCHMARK_MARKER_KEY, "enforcement"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** true bila konteks boleh memakai penanda benchmark (ADMIN atau harness server). */
export function isBenchmarkTrusted(caller: Pick<StudioCaller, "kind"> | null | undefined, opts: { trustedHarness?: boolean }): boolean {
  return isTrustedCaller(caller, opts);
}

export interface StripResult<T> {
  doc: T;
  /** Pointer (relatif badan permintaan) penanda yang dibuang; kosong = tidak ada. */
  stripped: string[];
}

/**
 * Salinan dangkal dokumen tanpa kunci penanda di `x` (objek asli tidak
 * dimutasi). `x` yang menjadi kosong dihapus. Masukan bukan objek dikembalikan
 * apa adanya (skema yang menolaknya).
 */
export function stripBenchmarkMarkers<T>(doc: T, pointerPrefix = "/document"): StripResult<T> {
  return stripXKeys(doc, BENCHMARK_MARKER_KEYS, pointerPrefix);
}

/** Salinan dokumen tanpa `x.lintEnforcement` (D-98); semantik sama dengan `stripBenchmarkMarkers`. */
export function stripEnforcementOverride<T>(doc: T, pointerPrefix = "/document"): StripResult<T> {
  return stripXKeys(doc, ENFORCEMENT_OVERRIDE_KEYS, pointerPrefix);
}

function stripXKeys<T>(doc: T, keys: readonly string[], pointerPrefix: string): StripResult<T> {
  if (!isRecord(doc) || !isRecord(doc.x)) return { doc, stripped: [] };
  const x = doc.x;
  const hit = keys.filter((k) => Object.prototype.hasOwnProperty.call(x, k));
  if (hit.length === 0) return { doc, stripped: [] };
  const nextX: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) if (!hit.includes(k)) nextX[k] = v;
  const next: Record<string, unknown> = { ...doc };
  if (Object.keys(nextX).length > 0) next.x = nextX;
  else delete next.x;
  return { doc: next as T, stripped: hit.map((k) => `${pointerPrefix}/x/${k}`) };
}

/**
 * D-134 R-01 (SR-55 M5, FIX-S): SATU fungsi untuk konten yang akan ditulis
 * (kiriman, atau konten TERSIMPAN yang digabung/disunting): kepercayaan mengikuti
 * PENULIS. Pemanggil tepercaya (ADMIN/harness) -> apa adanya; selain itu penanda
 * benchmark (`x.benchmark`, `x.enforcement`) dan `x.lintEnforcement` dibuang.
 * Dipakai kiriman bab/slot/dokumen (SR-13), sunting pid/struktur v2 (SR-14), dan
 * PATCH alamat v1. Pencatatan log milik pemanggil (`stripped` kosong = tanpa log).
 */
export function stripTrustMarkersForWriter<T>(
  doc: T,
  caller: Pick<StudioCaller, "kind"> | null | undefined,
  pointerPrefix: string,
  opts: { trustedHarness?: boolean } = {},
): StripResult<T> & { benchmarkStripped: string[]; enforcementStripped: string[] } {
  if (isTrustedCaller(caller, opts)) return { doc, stripped: [], benchmarkStripped: [], enforcementStripped: [] };
  const a = stripBenchmarkMarkers(doc, pointerPrefix);
  const b = stripEnforcementOverride(a.doc, pointerPrefix);
  return { doc: b.doc, stripped: [...a.stripped, ...b.stripped], benchmarkStripped: a.stripped, enforcementStripped: b.stripped };
}

/** Temuan REPORT (bukan penahan) untuk hasil lint ingest. */
export function strippedNotice(stripped: readonly string[], caller: Pick<StudioCaller, "kind">): LintIssue {
  return {
    checkId: BENCHMARK_MARKER_STRIPPED,
    status: "REPORT",
    detail: `Penanda benchmark dibuang (${stripped.join(", ")}): hanya dihormati untuk ADMINISTRATOR atau harness server; pemanggil ${caller.kind} diperlakukan sebagai dokumen biasa (F-042)`,
    pointer: stripped[0],
  };
}

/** Temuan REPORT (bukan penahan) saat override penegakan dokumen dibuang (D-98). */
export function enforcementStrippedNotice(stripped: readonly string[], caller: Pick<StudioCaller, "kind">): LintIssue {
  return {
    checkId: ENFORCEMENT_OVERRIDE_STRIPPED,
    status: "REPORT",
    detail: `Override penegakan dokumen dibuang (${stripped.join(", ")}): doc.x.lintEnforcement hanya dihormati untuk ADMINISTRATOR atau harness server; pemanggil ${caller.kind} memakai penegakan profil templat (F-047, D-98)`,
    pointer: stripped[0],
  };
}
