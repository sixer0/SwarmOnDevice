/**
 * Blok `contractRecord` HTML (DC-12; register 05 §3 D-139, §5.7, §6.3, BA-12).
 *
 * Isi blok dibangun compose DC-10 (`services/compose/contract-record.ts`): tabel
 * fakta (label medan | nilai), tabel butir, tabel bukti, tabel rujukan, semuanya
 * `TableBlock` `registerTable` tanpa caption, label dan kepala kolom dari registri
 * C58. Modul ini TIDAK menulis label: setiap teks datang dari blok.
 *
 * Tampilan milik templat (D-139): tiap tabel dirender lewat perender tabel DATUM
 * yang sama (`tableHtml`, garis mendatar, kepala berulang, baris tak terpecah),
 * dipisah paragraf spacer peran `spacer.generic` (padanan DOCX
 * `engine/docx/blocks/contract-record.ts`, yang wajib memisah tabel agar Word tidak
 * menggabungkannya). Gaya inline; CSS struktural tidak berubah, sehingga keluaran
 * dokumen lain tetap sama.
 *
 * Jangkar butir (§5.7): baris badan ke-n tabel butir membawa `data-address`
 * `<alamat record>/<n>` dan `id` = `itemPids[n-1]`. Blok `contractItem` tidak dirender
 * terpisah (perakit `assemble/slots.ts`), jadi setiap alamat muncul tepat sekali.
 */
import type { NormBlock, RenderContext, TableBlock } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { tableHtml } from "../tables";
import { el, isObj } from "./common";
import { attr, escapeHtml } from "./escape";

/** Kelas penanda struktur (tanpa aturan CSS; gaya dari perender tabel + peran templat). */
export const CONTRACT_RECORD_CLASSES = {
  record: "st-contract-record",
  part: "st-contract-part",
  spacer: "st-spacer",
} as const;

/** Urutan bagian tetap (register 05 §5.1): fakta, butir, bukti, rujukan. */
export const CONTRACT_RECORD_PARTS = ["facts", "items", "evidence", "refs"] as const;
export type ContractRecordPart = (typeof CONTRACT_RECORD_PARTS)[number];

/** Bentuk isi blok yang dibaca perakit (struktural; sumber tipe = compose DC-10). */
export interface ContractRecordContent {
  type: "contractRecord";
  kind?: string;
  facts: TableBlock;
  items?: TableBlock;
  itemPids?: string[];
  evidence?: TableBlock;
  refs?: TableBlock;
}

function isTable(v: unknown): v is TableBlock {
  return isObj(v) && typeof v.type === "string" && Array.isArray(v.rows);
}

/**
 * Validasi isi blok. Isi rusak = galat by-construction (compose menjamin bentuk);
 * dicatat ke log render (sink tahan lama layanan render) sebelum dilempar.
 */
export function contractRecordContent(block: NormBlock, ctx: RenderContext, module: string): ContractRecordContent {
  const c = block.content;
  const problem = !isObj(c)
    ? "isi bukan objek"
    : c.type !== "contractRecord"
      ? `type isi "${String(c.type)}" bukan contractRecord`
      : !isTable(c.facts)
        ? "facts bukan TableBlock"
        : (["items", "evidence", "refs"] as const).find((k) => c[k] !== undefined && !isTable(c[k]))
          ? "items/evidence/refs bukan TableBlock"
          : c.itemPids !== undefined && !(Array.isArray(c.itemPids) && c.itemPids.every((p) => typeof p === "string"))
            ? "itemPids bukan larik string"
            : undefined;
  if (problem) {
    const message = `${module}: contractRecord ${block.address ?? block.blockId}: ${problem}`;
    ctx.log({ level: "error", message, code: "BY_CONSTRUCTION_FAILED", address: block.address ?? undefined });
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, { blockId: block.blockId, address: block.address });
  }
  return c as unknown as ContractRecordContent;
}

/** Bagian yang ada, urutan tetap. */
export function contractRecordParts(c: ContractRecordContent): Array<{ part: ContractRecordPart; table: TableBlock }> {
  const out: Array<{ part: ContractRecordPart; table: TableBlock }> = [];
  for (const part of CONTRACT_RECORD_PARTS) {
    const t = c[part];
    if (t) out.push({ part, table: t });
  }
  return out;
}

/** Sisipkan jangkar butir pada baris badan ke-n tabel butir (tabel butir tanpa tabel bersarang). */
function anchorItemRows(html: string, recordAddress: string | null, pids: readonly string[] | undefined): string {
  let n = 0;
  return html.replace(/<tr class="st-row st-row-body"/g, (m) => {
    n += 1;
    const pid = pids?.[n - 1];
    return `${m}${recordAddress ? attr("data-address", `${recordAddress}/${n}`) : ""}${pid ? `${attr("id", pid)}${attr("data-pid", pid)}` : ""}`;
  });
}

export function renderContractRecord(block: NormBlock, ctx: RenderContext): string {
  const c = contractRecordContent(block, ctx, "engine/html/blocks");
  const C = CONTRACT_RECORD_CLASSES;
  const spacer = el(ctx, "p", { classes: [C.spacer], role: "spacer.generic", attrs: [["aria-hidden", "true"]] }, "&nbsp;");
  const parts = contractRecordParts(c).map(({ part, table }) => {
    let html = tableHtml(table, ctx, { depth: 0 });
    if (part === "items") html = anchorItemRows(html, block.address, c.itemPids);
    return `<div class="${C.part}" data-part="${part}">${html}</div>`;
  });
  const attrs =
    attr("data-address", block.address ?? undefined) +
    attr("data-block-id", block.blockId) +
    attr("data-block-type", "contractRecord") +
    (c.kind ? attr("data-contract-kind", c.kind) : "");
  return `<div class="${escapeHtml(C.record)}"${attrs}>${parts.join(spacer)}</div>`;
}
