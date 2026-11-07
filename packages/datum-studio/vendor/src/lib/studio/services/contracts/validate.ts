/**
 * I54 `checkContractRecord` (register 05 §5.6 langkah 6b, §15; DC-07).
 *
 * Validasi semantik murni payload `contractRecord` terhadap entri jenis C58
 * (`registry/contracts.ts`, baca saja):
 * - `issues` (400 `SCHEMA_INVALID`, checkId CH-01..CH-04): status/vonis/status
 *   butir/rel/jenis bukti di luar set jenis (CONTRACT_ENUM), pola C34/C35/C36/C38,
 *   `documentId`/`pid` rujukan (CONTRACT_PATTERN), tanggal kalender C37/`isoDate`
 *   (CONTRACT_DATE, termasuk NV-05 `2026-02-30` yang lolos pola), target rujukan
 *   dan `line`/`exitCode` pada jenis bukti yang salah (CONTRACT_REF_TARGET).
 *   Pemeriksaan ini sengaja tumpang tindih dengan skema (langkah 2) agar layanan
 *   aman dipanggil pada data yang belum lewat ajv (draf, impor); urutan isu = urutan medan.
 * - `error` (422 EC27 `CONTRACT_ITEM_KEY_DUPLICATE`): `items[].key` ganda; `positions`
 *   1-based (contoh register §13.1, NV-10).
 * Pemanggil: `issues` tidak kosong -> 400 lebih dulu (langkah 2 mendahului 6b); baru `error`.
 * DISPLAY_FIELD (DF-72) tetap tugas skema/pemeta `classifySchemaV2Errors`.
 */
import { PID_PATTERN, CARD_ID_PATTERN, CONTRACT_ACTOR_PATTERN, CONTRACT_KEY_PATTERN, CONTRACT_SHA_PREFIX_PATTERN } from "../../contract/env";
import type { ContractKind, SchemaV2CheckId } from "../../contract/enums";
import type { ContractRecordPayloadV2 } from "../../contract/types/v2/contract";
import { getContractKindDef } from "../../registry/contracts";
import { isContractDate, isContractReportedAt } from "./dates";

/** Pola `ContractRefV2.documentId` (§5.3; cuid). */
export const CONTRACT_REF_DOCUMENT_ID_PATTERN = "^[a-z0-9]{20,40}$";

const CARD_ID_RE = new RegExp(CARD_ID_PATTERN);
const KEY_RE = new RegExp(CONTRACT_KEY_PATTERN);
const ACTOR_RE = new RegExp(CONTRACT_ACTOR_PATTERN);
const SHA_RE = new RegExp(CONTRACT_SHA_PREFIX_PATTERN);
const PID_RE = new RegExp(PID_PATTERN);
const DOCUMENT_ID_RE = new RegExp(CONTRACT_REF_DOCUMENT_ID_PATTERN);

export interface ContractCheckIssue {
  pointer: string;
  checkId: SchemaV2CheckId;
  message: string;
}

export interface ContractItemKeyDuplicateDetails {
  pointer: string;
  key: string;
  /** 1-based, urutan `items`. */
  positions: number[];
}

export interface ContractCheckResult {
  issues: ContractCheckIssue[];
  error?: { code: "CONTRACT_ITEM_KEY_DUPLICATE"; details: ContractItemKeyDuplicateDetails };
}

export interface ContractCheckOptions {
  /** Pointer payload di badan kiriman; bawaan `/payload` (studio.slot/v2). */
  pointer?: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Rec, k: string): boolean => o[k] !== undefined;

/** Pemeriksa I54. `kind` wajib terdaftar di C58 (jenis tak terdaftar = galat pemrograman). */
export function checkContractRecord(
  payload: ContractRecordPayloadV2,
  kind: ContractKind,
  opts: ContractCheckOptions = {},
): ContractCheckResult {
  const def = getContractKindDef(kind);
  if (!def) throw new Error(`Jenis kontrak tidak terdaftar di C58: ${String(kind)}`);
  const base = opts.pointer ?? "/payload";
  const issues: ContractCheckIssue[] = [];
  const add = (path: string, checkId: SchemaV2CheckId, message: string) => issues.push({ pointer: `${base}${path}`, checkId, message });

  const statuses = new Set<string>(def.statuses.map((s) => s.code));
  const itemStatuses = new Set<string>(def.itemStatuses.map((s) => s.code));
  const verdicts = new Set<string>(def.verdicts.map((s) => s.code));
  const rels = new Set<string>(def.refRels);
  const evidenceKinds = new Set<string>(def.evidenceKinds);

  const p = payload as unknown as Rec;
  const enumAt = (v: unknown, set: Set<string>, path: string, what: string) => {
    if (typeof v !== "string" || !set.has(v)) add(path, "CONTRACT_ENUM", `${what} di luar set jenis ${kind}: ${JSON.stringify(v)}`);
  };
  const patternAt = (v: unknown, re: RegExp, path: string, what: string) => {
    if (typeof v !== "string" || !re.test(v)) add(path, "CONTRACT_PATTERN", `${what} tidak cocok pola ${re.source}`);
  };
  const dateAt = (v: unknown, path: string) => {
    if (!isContractDate(v)) add(path, "CONTRACT_DATE", `Tanggal harus YYYY-MM-DD yang ada di kalender: ${JSON.stringify(v)}`);
  };

  // Kepala catatan (CF-02..CF-10).
  enumAt(p.status, statuses, "/status", "status");
  if (has(p, "verdict")) enumAt(p.verdict, verdicts, "/verdict", "verdict");
  if (has(p, "owner")) patternAt(p.owner, ACTOR_RE, "/owner", "owner");
  if (has(p, "initiator")) patternAt(p.initiator, ACTOR_RE, "/initiator", "initiator");
  if (has(p, "taskRef")) patternAt(p.taskRef, KEY_RE, "/taskRef", "taskRef");
  if (!isContractReportedAt(p.reportedAt)) {
    add("/reportedAt", "CONTRACT_DATE", `reportedAt harus tanggal/waktu ber-zona C37 yang ada di kalender: ${JSON.stringify(p.reportedAt)}`);
  }
  if (has(p, "due")) dateAt(p.due, "/due");
  if (Array.isArray(p.cardIds)) p.cardIds.forEach((c, i) => patternAt(c, CARD_ID_RE, `/cardIds/${i}`, "cardId"));

  // Rujukan (CF-11): tepat satu target (CH-04), pola, rel.
  if (Array.isArray(p.refs)) {
    p.refs.forEach((r, i) => {
      if (!isRec(r)) return;
      const at = `/refs/${i}`;
      if (has(r, "documentId") === has(r, "docNumber")) {
        add(at, "CONTRACT_REF_TARGET", "Rujukan wajib memuat tepat satu dari documentId atau docNumber");
      }
      if (has(r, "documentId")) patternAt(r.documentId, DOCUMENT_ID_RE, `${at}/documentId`, "documentId");
      if (has(r, "pid")) patternAt(r.pid, PID_RE, `${at}/pid`, "pid");
      enumAt(r.rel, rels, `${at}/rel`, "rel");
    });
  }

  // Bukti (CF-12): `ref` tidak pernah dibuka/di-resolve (CA-11).
  if (Array.isArray(p.evidence)) {
    p.evidence.forEach((e, i) => {
      if (!isRec(e)) return;
      const at = `/evidence/${i}`;
      enumAt(e.kind, evidenceKinds, `${at}/kind`, "kind bukti");
      // Pointer di medan pelanggar, selaras pemeta skema `classifySchemaV2Errors` (DC-05).
      if (has(e, "line") && e.kind !== "file") add(`${at}/line`, "CONTRACT_REF_TARGET", "line hanya untuk kind file");
      if (has(e, "exitCode") && e.kind !== "command") add(`${at}/exitCode`, "CONTRACT_REF_TARGET", "exitCode hanya untuk kind command");
      if (has(e, "sha256")) patternAt(e.sha256, SHA_RE, `${at}/sha256`, "sha256");
      if (has(e, "item")) patternAt(e.item, KEY_RE, `${at}/item`, "item");
    });
  }

  // Butir (CF-13): pola kunci, status, owner, tenggat, dependensi; kunci unik (EC27).
  const seen = new Map<string, number[]>();
  if (Array.isArray(p.items)) {
    p.items.forEach((it, i) => {
      if (!isRec(it)) return;
      const at = `/items/${i}`;
      patternAt(it.key, KEY_RE, `${at}/key`, "key");
      enumAt(it.status, itemStatuses, `${at}/status`, "status butir");
      if (has(it, "owner")) patternAt(it.owner, ACTOR_RE, `${at}/owner`, "owner");
      if (has(it, "due")) dateAt(it.due, `${at}/due`);
      // dependsOn boleh menunjuk kunci di luar payload (contoh §5.8: `DC-03` -> `DC-02`); hanya pola C35.
      if (Array.isArray(it.dependsOn)) it.dependsOn.forEach((d, j) => patternAt(d, KEY_RE, `${at}/dependsOn/${j}`, "dependsOn"));
      if (typeof it.key === "string") {
        const list = seen.get(it.key);
        if (list) list.push(i + 1);
        else seen.set(it.key, [i + 1]);
      }
    });
  }

  for (const [key, positions] of seen) {
    if (positions.length < 2) continue;
    return {
      issues,
      error: { code: "CONTRACT_ITEM_KEY_DUPLICATE", details: { pointer: `${base}/items/${positions[1] - 1}/key`, key, positions } },
    };
  }
  return { issues };
}
