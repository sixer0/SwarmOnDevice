/**
 * Ringkasan hasil I54 untuk pemanggil (FIX-R40-3, review DC-40 #5): SATU pemeta isu dan SATU
 * aturan penekanan EC27, dipakai gerbang langkah 6b (`ingest/by-construction.ts`; R04/R08/R12/R13)
 * dan pemeriksaan draf lokal (`draft/contract-local.ts`; CLI draft-check), agar mode lokal
 * melaporkan isu yang sama dengan R08 (AC-19). Murni.
 *
 * Aturan (register 05 §5.6 langkah 6b; urutan pemanggil I54):
 * - isu CH-01..CH-04 dari SEMUA payload (urutan payload, lalu urutan medan) -> 400 lebih dulu;
 *   `keyword` = `checkId`;
 * - EC27 `CONTRACT_ITEM_KEY_DUPLICATE` hanya bila TIDAK ada isu CH di payload mana pun, dan
 *   hanya yang pertama (respons 422 membawa satu galat).
 */
import type { ValidationIssue } from "../../contract/types/api";
import type { ContractCheckResult, ContractItemKeyDuplicateDetails } from "./validate";

/** EC27 terpilih (pesan baku, `positions` 1-based). */
export interface ContractItemKeyDuplicate {
  code: "CONTRACT_ITEM_KEY_DUPLICATE";
  message: string;
  details: ContractItemKeyDuplicateDetails;
}

export interface ContractCheckSummary {
  issues: ValidationIssue[];
  /** Hanya bila `issues` kosong. */
  duplicate?: ContractItemKeyDuplicate;
}

/** Gabungkan hasil I54 beberapa payload menjadi isu 400 atau satu EC27 (lihat aturan di atas). */
export function summarizeContractChecks(results: Iterable<ContractCheckResult>): ContractCheckSummary {
  const issues: ValidationIssue[] = [];
  let duplicate: ContractItemKeyDuplicate | undefined;
  for (const r of results) {
    for (const x of r.issues) issues.push({ pointer: x.pointer, keyword: x.checkId, message: x.message, checkId: x.checkId });
    if (r.error && !duplicate) {
      const { key, positions } = r.error.details;
      duplicate = { code: r.error.code, message: `Kunci butir "${key}" ganda pada posisi ${positions.join(", ")}`, details: { ...r.error.details } };
    }
  }
  return issues.length > 0 || !duplicate ? { issues } : { issues, duplicate };
}
