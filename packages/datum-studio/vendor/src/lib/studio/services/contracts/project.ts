/**
 * I56 `projectContractRows` (register 05 §7.1 M19-M21, §7.2 MX09, §7.6; DC-07).
 *
 * Proyeksi murni payload `contractRecord` -> data baris untuk ditulis DC-09 di dalam
 * transaksi commit v2: `record` (M19), `items` (M20, n butir), `refs` (M21, m rujukan),
 * `mirror` (kolom cermin MX09 `StudioDocument`). Tanpa DB, tanpa jam: masukan sama ->
 * keluaran sama. `recordId` M20/M21 dan `id`/`createdAt` diisi penulis (cuid/now).
 * Prasyarat: I54 tanpa isu/galat; `resolvedRefs` dari I55; `itemPids` = pid baris
 * `F:record/<n>` (urutan `items`, KD-34).
 */
import { CARD_ID_PATTERN } from "../../contract/env";
import type { ContractKind } from "../../contract/enums";
import type { ContractRecordPayloadV2 } from "../../contract/types/v2/contract";
import { plainText } from "../ingest/util";
import { contractDateToUtc, reportedAtToUtc } from "./dates";
import type { ResolvedContractRef } from "./refs";

const CARD_ID_RE = new RegExp(CARD_ID_PATTERN);

export interface ContractProjectionContext {
  documentId: string;
  revisionNo: number;
  revisionId: string;
  docSectionId: string;
  kind: ContractKind;
  /** pid per butir, urutan `items` (panjang wajib = jumlah butir). */
  itemPids: readonly string[];
  resolvedRefs: readonly ResolvedContractRef[];
}

/** M19 `StudioContractRecord` tanpa `id`/`createdAt`. */
export interface ContractRecordRow {
  revisionId: string;
  docSectionId: string;
  documentId: string;
  revisionNo: number;
  contractKind: string;
  status: string;
  verdict: string | null;
  owner: string | null;
  initiator: string | null;
  taskRef: string | null;
  /** UTC. */
  reportedAt: Date;
  /** Tengah malam UTC (`@db.Date`). */
  dueOn: Date | null;
  phaseFrom: string | null;
  phaseTo: string | null;
  cardIds: string[];
  itemCount: number;
}

/** M20 `StudioContractItem` tanpa `id`/`recordId`. */
export interface ContractItemRow {
  documentId: string;
  revisionNo: number;
  itemKey: string;
  /** 1-based. */
  position: number;
  pid: string;
  status: string;
  owner: string | null;
  phase: string | null;
  dueOn: Date | null;
  dependsOn: string[];
  titlePlain: string;
}

/** M21 `StudioDocRef` tanpa `id`/`recordId`. */
export interface ContractRefRow {
  fromDocumentId: string;
  revisionNo: number;
  position: number;
  rel: string;
  targetDocumentId: string;
  targetPid: string | null;
  targetRevisionNo: number | null;
}

/** MX09 — cermin revisi terbaru di `StudioDocument`. */
export interface ContractMirrorColumns {
  contractKind: string;
  contractStatus: string;
  contractOwner: string | null;
  contractTaskRef: string | null;
  contractDueOn: Date | null;
  /** Gabungan terurut unik `cardIds` ∪ `items[].key` yang cocok C34. */
  contractCardIds: string[];
}

export interface ContractProjection {
  record: ContractRecordRow;
  items: ContractItemRow[];
  refs: ContractRefRow[];
  mirror: ContractMirrorColumns;
}

/** Urut kode unit (bukan locale) agar deterministik lintas mesin. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function projectContractRows(payload: ContractRecordPayloadV2, ctx: ContractProjectionContext): ContractProjection {
  const items = payload.items ?? [];
  if (ctx.itemPids.length !== items.length) {
    throw new Error(`itemPids (${ctx.itemPids.length}) tidak sama dengan jumlah butir (${items.length})`);
  }
  const refsIn = payload.refs ?? [];
  if (ctx.resolvedRefs.length !== refsIn.length) {
    throw new Error(`resolvedRefs (${ctx.resolvedRefs.length}) tidak sama dengan jumlah refs (${refsIn.length})`);
  }

  const cardIds = [...(payload.cardIds ?? [])];
  const dueOn = payload.due !== undefined ? contractDateToUtc(payload.due) : null;

  const record: ContractRecordRow = {
    revisionId: ctx.revisionId,
    docSectionId: ctx.docSectionId,
    documentId: ctx.documentId,
    revisionNo: ctx.revisionNo,
    contractKind: ctx.kind,
    status: payload.status,
    verdict: payload.verdict ?? null,
    owner: payload.owner ?? null,
    initiator: payload.initiator ?? null,
    taskRef: payload.taskRef ?? null,
    reportedAt: reportedAtToUtc(payload.reportedAt),
    dueOn,
    phaseFrom: payload.phase?.from ?? null,
    phaseTo: payload.phase?.to ?? null,
    cardIds,
    itemCount: items.length,
  };

  const itemRows: ContractItemRow[] = items.map((it, i) => ({
    documentId: ctx.documentId,
    revisionNo: ctx.revisionNo,
    itemKey: it.key,
    position: i + 1,
    pid: ctx.itemPids[i],
    status: it.status,
    owner: it.owner ?? null,
    phase: it.phase ?? null,
    dueOn: it.due !== undefined ? contractDateToUtc(it.due) : null,
    dependsOn: [...(it.dependsOn ?? [])],
    titlePlain: plainText(it.title),
  }));

  const refRows: ContractRefRow[] = [...ctx.resolvedRefs]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      fromDocumentId: ctx.documentId,
      revisionNo: ctx.revisionNo,
      position: r.position,
      rel: r.rel,
      targetDocumentId: r.targetDocumentId,
      targetPid: r.targetPid,
      targetRevisionNo: r.targetRevisionNo,
    }));

  const mirrorCards = new Set<string>(cardIds);
  for (const it of items) if (CARD_ID_RE.test(it.key)) mirrorCards.add(it.key);

  const mirror: ContractMirrorColumns = {
    contractKind: ctx.kind,
    contractStatus: payload.status,
    contractOwner: payload.owner ?? null,
    contractTaskRef: payload.taskRef ?? null,
    contractDueOn: dueOn ? new Date(dueOn.getTime()) : null,
    contractCardIds: [...mirrorCards].sort(byCodeUnit),
  };

  return { record, items: itemRows, refs: refRows, mirror };
}
