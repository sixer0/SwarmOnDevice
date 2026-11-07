/**
 * Payload slot `contractRecord` -> unit interior norm/v2 (DC-10; register 05 §3 CV-14,
 * §5.7, §6.1-§6.4, BA-10). MURNI dan deterministik.
 *
 * Bentuk keluaran (dibaca perakit HTML DC-12 dan DOCX DC-13):
 * - Blok `F:<slotKey>` bertipe `contractRecord` (`ContractRecordBlock`): tabel fakta
 *   (label medan | nilai), tabel butir, tabel bukti, tabel rujukan. Tabel tanpa caption
 *   (bukan artefak bernomor) bertipe `registerTable`.
 * - Blok `F:<slotKey>/<n>` bertipe `contractItem` per butir (n 1-based, urutan `items`):
 *   proyeksi alamat/pid/teks butir (§5.7). Perakit TIDAK merendernya terpisah; baris
 *   ke-n tabel butir memakai `itemPids[n-1]` sebagai jangkar.
 *
 * Label medan, label status/vonis, dan kepala kolom berasal dari registri jenis C58
 * (`labels`, `statuses`, `itemStatuses`, `verdicts`); agen tidak pernah mengirim label
 * (D-139). Nilai data agen ditulis sebagai run harfiah (bukan md-lite) agar path,
 * perintah, dan id tidak diurai sebagai penekanan; judul butir (InlineV2) dipetakan
 * apa adanya. Kolom yang kosong di semua baris dibuang (urutan kolom registri tetap).
 */
import type {
  Cell,
  ColumnSpec,
  ContractEvidenceV2,
  ContractItemStatus,
  ContractItemV2,
  ContractKind,
  ContractKindDefV2,
  ContractRecordPayloadV2,
  ContractRefV2,
  Inline,
  Row,
  TableBlock,
} from "../../contract";
import { CONTRACT_KIND_DEFS, getContractKindDef } from "../../registry/contracts";
import { isContractReportedAt, reportedAtToUtc } from "../contracts/dates";
import { contractItemTextPlain, contractRecordTextPlain } from "../contracts/text";
import { composeFail } from "./errors";
import { mapInline, mapRuns, type InlineCtx } from "./inline";

/** Isi internal blok `F:<slotKey>` (`type: "contractRecord"`). */
export interface ContractRecordBlock {
  type: "contractRecord";
  blockId: string;
  kind: ContractKind;
  /** Tabel dua kolom: label medan C58 | nilai. */
  facts: TableBlock;
  /** Kepala = `labels.itemColumns`; baris ke-n = butir ke-n. */
  items?: TableBlock;
  /** Pid butir ke-n (sama dengan blok `F:<slotKey>/<n>`), jangkar baris tabel butir. */
  itemPids?: string[];
  /** Kepala = `labels.evidenceColumns`. */
  evidence?: TableBlock;
  /** Kepala = `labels.refColumns`. */
  refs?: TableBlock;
}

/** Isi internal blok `F:<slotKey>/<n>` (`type: "contractItem"`). */
export interface ContractItemBlock {
  type: "contractItem";
  blockId: string;
  key: string;
  status: ContractItemStatus;
  statusLabel: string;
  title: Inline;
  owner?: string;
  phase?: string;
  due?: string;
  dependsOn?: string[];
}

export interface ContractRecordProjection {
  record: { content: ContractRecordBlock; textPlain: string };
  items: Array<{ content: ContractItemBlock; textPlain: string }>;
}

/**
 * Jenis kontrak dokumen: `explicit` (kolom templat MX08, bila pemanggil memberikannya),
 * selain itu entri C58 yang `templateSlug`-nya = slug templat dokumen.
 */
export function resolveContractKind(templateSlug: string, explicit?: string): ContractKindDefV2 {
  const def = explicit !== undefined ? getContractKindDef(explicit) : CONTRACT_KIND_DEFS.find((d) => d.templateSlug === templateSlug);
  if (!def) {
    composeFail(
      "BY_CONSTRUCTION_FAILED",
      explicit !== undefined
        ? `Jenis kontrak "${explicit}" tidak terdaftar; slot contractRecord hanya untuk templat ber-contractKind terdaftar`
        : `Templat "${templateSlug}" tidak terhubung ke jenis kontrak terdaftar; slot contractRecord hanya untuk templat ber-contractKind`,
      { checkId: "CONTRACT_KIND", templateSlug, contractKind: explicit ?? null },
    );
  }
  return def;
}

type CellValue = { kind: "literal"; text: string; mono?: boolean } | { kind: "inline"; inline: Inline } | undefined;

const lit = (v: string | number | undefined, mono = false): CellValue =>
  v === undefined || v === "" ? undefined : { kind: "literal", text: String(v), mono };

function cellOf(v: CellValue, ctx: InlineCtx): Cell {
  if (v === undefined) return { text: "" };
  if (v.kind === "inline") return "runs" in v.inline ? { runs: v.inline.runs } : { text: v.inline.text };
  return { runs: mapRuns([v.mono ? { t: v.text, code: true } : { t: v.text }], ctx) };
}

/**
 * Tabel berkepala dari kolom registri; kolom yang kosong di semua baris dibuang
 * (kolom pertama selalu dipertahankan sebagai identitas baris).
 */
function headedTable(head: readonly string[], roles: ReadonlyArray<ColumnSpec["role"]>, rows: CellValue[][], ctx: InlineCtx): TableBlock {
  const keep = head.map((_, c) => c === 0 || rows.some((r) => r[c] !== undefined));
  const pick = <T>(xs: readonly T[]): T[] => xs.filter((_, c) => keep[c]);
  return {
    type: "registerTable",
    columns: pick(roles).map((role) => (role ? { role } : {})),
    rows: [
      { kind: "header", repeatHeader: true, cells: pick(head).map((t) => ({ text: t })) },
      ...rows.map((r): Row => ({ cells: pick(r).map((v) => cellOf(v, ctx)) })),
    ],
  };
}

/** `YYYY-MM-DD` (tanggal saja) atau `YYYY-MM-DD HH:MM[:SS] UTC` (C37 dinormalkan ke UTC, §5.1 CF-07). */
export function reportedAtDisplay(v: string): string {
  if (!isContractReportedAt(v)) {
    composeFail("BY_CONSTRUCTION_FAILED", `reportedAt "${v}" tidak sah; jalankan validasi kontrak sebelum compose`, { checkId: "CONTRACT_REPORTED_AT", reportedAt: v });
  }
  if (!v.includes("T")) return v;
  const iso = reportedAtToUtc(v).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const ss = iso.slice(17, 19);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}${ss !== "00" ? `:${ss}` : ""} UTC`;
}

function labelOf<T extends string>(list: ReadonlyArray<{ code: T; label: string }>, code: T): string {
  return list.find((x) => x.code === code)?.label ?? code;
}

function factsTable(p: ContractRecordPayloadV2, def: ContractKindDefV2, ctx: InlineCtx): TableBlock {
  const L = def.labels.fields;
  const phase = p.phase ? (p.phase.from !== undefined ? `${p.phase.from} → ${p.phase.to}` : p.phase.to) : undefined;
  const facts: Array<[string, CellValue]> = [
    ["status", lit(labelOf(def.statuses, p.status))],
    ["verdict", p.verdict !== undefined ? lit(labelOf(def.verdicts, p.verdict)) : undefined],
    ["owner", lit(p.owner, true)],
    ["initiator", lit(p.initiator, true)],
    ["taskRef", lit(p.taskRef, true)],
    ["reportedAt", lit(reportedAtDisplay(p.reportedAt))],
    ["due", lit(p.due)],
    ["phase", lit(phase)],
    ["cardIds", p.cardIds && p.cardIds.length > 0 ? lit(p.cardIds.join(", "), true) : undefined],
  ];
  return {
    type: "registerTable",
    columns: [{ role: "text" }, { role: "text" }],
    rows: facts
      .filter(([, v]) => v !== undefined)
      .map(([field, v]): Row => ({ cells: [{ text: L[field] ?? field }, cellOf(v, ctx)] })),
  };
}

const ITEM_ROLES: ReadonlyArray<ColumnSpec["role"]> = ["id", "text", "text", "id", "text", "text", "id"];
const EVIDENCE_ROLES: ReadonlyArray<ColumnSpec["role"]> = ["text", "id", "id", "numeral", "numeral", "numeral", "id", "text"];
const REF_ROLES: ReadonlyArray<ColumnSpec["role"]> = ["text", "id", "id", "numeral"];

function itemCells(it: ContractItemV2, def: ContractKindDefV2, ctx: InlineCtx): CellValue[] {
  return [
    lit(it.key, true),
    { kind: "inline", inline: mapInline(it.title, ctx) },
    lit(labelOf(def.itemStatuses, it.status)),
    lit(it.owner, true),
    lit(it.phase),
    lit(it.due),
    it.dependsOn && it.dependsOn.length > 0 ? lit(it.dependsOn.join(", "), true) : undefined,
  ];
}

function evidenceCells(e: ContractEvidenceV2, ctx: InlineCtx): CellValue[] {
  return [
    lit(e.kind),
    lit(e.ref, true),
    lit(e.sha256, true),
    lit(e.bytes),
    lit(e.line),
    lit(e.exitCode),
    lit(e.item, true),
    e.note !== undefined ? { kind: "inline", inline: mapInline(e.note, ctx) } : undefined,
  ];
}

function refCells(r: ContractRefV2): CellValue[] {
  return [lit(r.rel), lit(r.documentId ?? r.docNumber, true), lit(r.pid, true), lit(r.revisionNo)];
}

/**
 * Proyeksikan payload `contractRecord` ke isi blok record + blok butir.
 * `recordPid` = pid blok `F:<slotKey>`; `itemPids[n-1]` = pid blok `F:<slotKey>/<n>`.
 */
export function projectContractRecord(
  payload: ContractRecordPayloadV2,
  def: ContractKindDefV2,
  pids: { record: string; items: readonly string[] },
  ctx: InlineCtx,
): ContractRecordProjection {
  const items = payload.items ?? [];
  const content: ContractRecordBlock = { type: "contractRecord", blockId: pids.record, kind: def.kind, facts: factsTable(payload, def, ctx) };
  if (items.length > 0) {
    content.items = headedTable(def.labels.itemColumns, ITEM_ROLES, items.map((it) => itemCells(it, def, ctx)), ctx);
    content.itemPids = [...pids.items];
  }
  if (payload.evidence && payload.evidence.length > 0) {
    content.evidence = headedTable(def.labels.evidenceColumns, EVIDENCE_ROLES, payload.evidence.map((e) => evidenceCells(e, ctx)), ctx);
  }
  if (payload.refs && payload.refs.length > 0) {
    content.refs = headedTable(def.labels.refColumns, REF_ROLES, payload.refs.map(refCells), ctx);
  }
  return {
    record: { content, textPlain: contractRecordTextPlain(payload) },
    items: items.map((it, i) => {
      const c: ContractItemBlock = {
        type: "contractItem",
        blockId: pids.items[i],
        key: it.key,
        status: it.status,
        statusLabel: labelOf(def.itemStatuses, it.status),
        title: mapInline(it.title, ctx),
      };
      if (it.owner !== undefined) c.owner = it.owner;
      if (it.phase !== undefined) c.phase = it.phase;
      if (it.due !== undefined) c.due = it.due;
      if (it.dependsOn !== undefined && it.dependsOn.length > 0) c.dependsOn = [...it.dependsOn];
      return { content: c, textPlain: contractItemTextPlain(it) };
    }),
  };
}
