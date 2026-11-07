/**
 * Predikat reproduksi verbatim turunan benchmark, SATU sumber (IP-31, F-042,
 * D-79, D-91). Dipakai renderer HTML (`engine/html/tables/reproduction.ts`)
 * dan DOCX (`engine/docx/figures/derivation.ts`, menyusul INT-B).
 *
 * Ekstraksi S93 (`benchmark/manual000/doc.json`, D-44) menyalin turunan BM apa
 * adanya (judul, baris uraian/nilai, penutup sebagai `Inline.runs`, C1/C8)
 * TANPA `result()`. Bentuk itu dirender verbatim HANYA bila:
 * 1. dokumen bertanda benchmark: `doc.x.benchmark === true` atau objek; dan
 * 2. turunan verbatim murni: tanpa `result`/`verdict`, setiap nilai baris
 *    Inline (bukan `registerKey`), `title` dan `closing` berteks.
 *
 * KEPERCAYAAN PENANDA (F-042): predikat ini hanya membaca dokumen. Penanda
 * `x.benchmark` sah hanya bila masuk lewat jalur tepercaya: ingest
 * (`services/ingest`) membuangnya dari dokumen pemanggil selain ADMINISTRATOR
 * atau harness server (`trustedHarness`), sehingga snapshot tersimpan dari
 * pemanggil lain tidak pernah membawanya; harness/CLI (render_cli) membaca
 * berkas lokal dan tepercaya menurut definisi.
 */
import type { DerivationBlock, DerivationLine, Inline, StudioDocV1 } from "../../contract";
import { inlineText } from "./derivation";

/** Kunci penanda benchmark di `doc.x` (D-34 ingest, reproduksi verbatim). */
export const BENCHMARK_MARKER_KEY = "benchmark";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** true bila dokumen membawa penanda benchmark `x.benchmark` (true atau objek). */
export function hasBenchmarkMarker(doc: Pick<StudioDocV1, "x"> | null | undefined): boolean {
  const x = doc?.x;
  if (!isRecord(x)) return false;
  const m = x[BENCHMARK_MARKER_KEY];
  return m === true || isRecord(m);
}

function isInline(v: unknown): v is Inline {
  return isRecord(v) && (Array.isArray(v.runs) || typeof v.text === "string");
}

function hasText(v: unknown): boolean {
  return isInline(v) && inlineText(v).trim().length > 0;
}

function isVerbatimLine(ln: unknown): ln is DerivationLine {
  if (!isRecord(ln) || !isInline(ln.label)) return false;
  return ln.value === undefined || (isInline(ln.value) && !("registerKey" in (ln.value as object)));
}

/** true bila turunan berbentuk reproduksi verbatim murni (tanpa aritmetika yang dapat diuji). */
export function isVerbatimDerivation(d: DerivationBlock): boolean {
  return (
    d.result === undefined &&
    d.verdict === undefined &&
    Array.isArray(d.lines) &&
    d.lines.every(isVerbatimLine) &&
    hasText(d.title) &&
    hasText(d.closing)
  );
}

/**
 * Gerbang reproduksi verbatim: dokumen bertanda benchmark DAN turunan verbatim
 * murni. Selain itu renderer wajib memakai `buildDerivationBlock` (turunan
 * tanpa `result()` ditolak BY_CONSTRUCTION_FAILED).
 */
export function isVerbatimReproduction(doc: Pick<StudioDocV1, "x"> | null | undefined, block: DerivationBlock): boolean {
  return hasBenchmarkMarker(doc) && isVerbatimDerivation(block);
}
