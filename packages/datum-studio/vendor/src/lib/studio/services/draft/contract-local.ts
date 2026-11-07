/**
 * Pemeriksaan kontrak lokal draf (register 05 §5.6 langkah 6b, §11.3 mode lokal; DC-23 per D-375):
 * setiap payload `contractRecord` di blok diperiksa I54 `checkContractRecord` (`services/contracts`,
 * satu sumber aturan dengan gerbang R08), menggantikan cek `items[].key` lokal CLI DC-22
 * (`TODO(DC-07)`). Murni: tanpa DB.
 *
 * Urutan pemanggil I54 = gerbang R08 (`summarizeContractChecks`, satu pemeta + satu aturan EC27,
 * FIX-R40-3): `issues` (400, checkId CH-01..CH-04) dari semua payload blok lebih dulu; bila kosong,
 * SATU galat 422 EC27 `CONTRACT_ITEM_KEY_DUPLICATE` (yang pertama) dengan `positions` BERBASIS 1
 * (register §13.1, NV-10).
 *
 * Jenis kontrak: mode lokal tidak mengetahui `contractKind` templat dokumen (butuh DB). Tahap 1
 * hanya mendaftarkan satu jenis (C58 `agentWorkReport`, E44), yang setnya identik dengan enum skema
 * tahap 1; bila jenis kedua didaftarkan, pemilihan jenis lokal harus ditinjau ulang.
 */
import { CONTRACT_KINDS, type ContractKind } from "../../contract/enums";
import type { ValidationIssue } from "../../contract/types/api";
import type { ContractRecordPayloadV2 } from "../../contract/types/v2/contract";
import { checkContractRecord, summarizeContractChecks } from "../contracts";

/** Jenis kontrak yang dipakai pemeriksaan lokal (satu-satunya jenis tahap 1). */
export const LOCAL_CONTRACT_KIND: ContractKind = CONTRACT_KINDS[0];

export type DraftContractIssue = ValidationIssue & { details?: Record<string, unknown> };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Payload `contractRecord` di blok beserta pointernya (slot v2: `/payload`; doc v2: `/sections/<slot>`). */
function contractPayloads(value: Record<string, unknown>): Array<{ pointer: string; payload: Record<string, unknown> }> {
  const out: Array<{ pointer: string; payload: Record<string, unknown> }> = [];
  if (value.$schema === "studio.slot/v2" && isRecord(value.payload) && value.payload.type === "contractRecord") {
    out.push({ pointer: "/payload", payload: value.payload });
  }
  if (value.$schema === "studio.doc/v2" && isRecord(value.sections)) {
    for (const [slot, p] of Object.entries(value.sections)) {
      if (isRecord(p) && p.type === "contractRecord") out.push({ pointer: `/sections/${slot.replace(/~/g, "~0").replace(/\//g, "~1")}`, payload: p });
    }
  }
  return out;
}

/**
 * Isu I54 untuk semua payload `contractRecord` di satu blok (urutan payload, lalu urutan medan).
 * Isu CH-xx: `keyword` = `checkId`. Tanpa isu CH di payload mana pun: satu EC27, `keyword`
 * `CONTRACT_ITEM_KEY_DUPLICATE`, `details = { key, positions }` (1-based).
 */
export function draftContractIssues(value: Record<string, unknown>, kind: ContractKind = LOCAL_CONTRACT_KIND): DraftContractIssue[] {
  const s = summarizeContractChecks(contractPayloads(value).map(({ pointer, payload }) => checkContractRecord(payload as unknown as ContractRecordPayloadV2, kind, { pointer })));
  if (!s.duplicate) return s.issues;
  const { pointer, key, positions } = s.duplicate.details;
  return [{ pointer, keyword: s.duplicate.code, message: s.duplicate.message, details: { key, positions } }];
}
