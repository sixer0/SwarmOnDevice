/**
 * Nomor dokumen dari sekuens HQ untuk dokumen yang dibuat lewat kiriman v2
 * (register 03 §7.2 `docNumber`; KT-05 c, KD-04).
 *
 * Kunci `pg_advisory_xact_lock(hashtext('studio-docno:' || typeCode || ':' || year))`
 * lalu max(urut)+1, sama dengan jalur ingest (`services/ingest/repository.ts`);
 * pola dan pemformat dipakai ulang dari sana. Urutan kunci tetap:
 * `studio-mdoc` -> `studio-docno` -> `studio-doc` (register §9.1 butir 2).
 */
import type { ParamMap } from "../../contract";
// Swarm patch (row 109, Prisma cut): store transaction; the advisory lock is the store's single
// write queue (one BEGIN IMMEDIATE job at a time, spec §10), so no lock statement is needed.
import { docNumbersContaining, type StudioTx } from "../_swarm-store";
import { docNumberPattern, formatDocNumber } from "../ingest/repository";

/** Prefiks kunci sekuens nomor (KD-04; sama dengan ingest). */
export const STUDIO_LOCK_DOCNO_PREFIX = "studio-docno:";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Urut terbesar di antara nomor berpola sama (tahun + jenis); -1 bila tidak ada. */
export function maxSequence(numbers: readonly string[], pattern: string, typeCode: string, issueDate: string): number {
  const year = issueDate.slice(0, 4);
  const re = new RegExp(
    "^" +
      pattern
        .split(/(\{urut\}|\{kodeJenis\}|\{bulanRomawi\}|\{tahun\})/)
        .map((t) =>
          t === "{urut}" ? "(\\d+)" : t === "{kodeJenis}" ? escapeRe(typeCode) : t === "{bulanRomawi}" ? "[^/]+" : t === "{tahun}" ? escapeRe(year) : escapeRe(t),
        )
        .join("") +
      "$",
  );
  let max = -1;
  for (const n of numbers) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Ambil nomor berikutnya di dalam transaksi (memegang kunci sekuens sampai commit). */
export async function nextDocNumber(tx: StudioTx, params: ParamMap, typeCode: string, issueDate: string): Promise<string> {
  const pattern = docNumberPattern(params);
  const year = issueDate.slice(0, 4);
  const numbers = docNumbersContaining(tx, typeCode, year);
  const next = maxSequence(numbers, pattern, typeCode, issueDate) + 1;
  return formatDocNumber(pattern, Math.max(next, 1), typeCode, issueDate);
}
