/**
 * I57 `contractRecordTextPlain`, I58 `contractItemTextPlain` (register 05 §5.7; DC-07).
 * Teks polos baris M17 `F:record` (`contractRecord`) dan `F:record/<n>` (`contractItem`)
 * untuk FTS (`tsv`, C41/C42). Murni, deterministik: urutan medan tetap, dipisah satu
 * spasi, medan kosong dilewati. Prasyarat: I54 tanpa isu (reportedAt sah).
 */
import type { ContractItemV2, ContractRecordPayloadV2, ContractRefV2 } from "../../contract/types/v2/contract";
import { plainText } from "../ingest/util";
import { reportedAtToUtc } from "./dates";

function join(parts: ReadonlyArray<string | number | undefined | null>): string {
  return parts
    .filter((x): x is string | number => x !== undefined && x !== null && x !== "")
    .map(String)
    .join(" ");
}

/** `rel documentId|docNumber#pid@revisionNo`; `#pid` / `@revisionNo` hanya bila diisi. */
function refText(r: ContractRefV2): string {
  const target = r.documentId ?? r.docNumber ?? "";
  return join([r.rel, `${target}${r.pid !== undefined ? `#${r.pid}` : ""}${r.revisionNo !== undefined ? `@${r.revisionNo}` : ""}`]);
}

/** I57 — `status verdict owner initiator taskRef reportedAt(UTC) due from->to cardIds… refs… bukti…`. */
export function contractRecordTextPlain(payload: ContractRecordPayloadV2): string {
  const phase = payload.phase ? (payload.phase.from !== undefined ? `${payload.phase.from}->${payload.phase.to}` : payload.phase.to) : undefined;
  return join([
    payload.status,
    payload.verdict,
    payload.owner,
    payload.initiator,
    payload.taskRef,
    reportedAtToUtc(payload.reportedAt).toISOString(),
    payload.due,
    phase,
    ...(payload.cardIds ?? []),
    ...(payload.refs ?? []).map(refText),
    ...(payload.evidence ?? []).map((e) => join([e.kind, e.ref, e.sha256])),
  ]);
}

/** I58 — `key status <teks title> owner phase due dependsOn…`. */
export function contractItemTextPlain(item: ContractItemV2): string {
  return join([item.key, item.status, plainText(item.title), item.owner, item.phase, item.due, ...(item.dependsOn ?? [])]);
}
