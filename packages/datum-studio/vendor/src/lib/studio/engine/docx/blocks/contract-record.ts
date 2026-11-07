/**
 * Blok `contractRecord` DOCX (DC-13; register 05 §3 D-139, §5.7, §6.3, BA-13).
 * Padanan perakit HTML DC-12 (`engine/html/blocks/contract-record.ts`).
 *
 * Isi blok dibangun compose DC-10: tabel fakta (label medan | nilai), tabel butir,
 * tabel bukti, tabel rujukan, semuanya `TableBlock` `registerTable` tanpa caption,
 * label dan kepala kolom dari registri C58. Modul ini TIDAK menulis label.
 *
 * Tampilan milik templat (D-139): setiap tabel lewat perender keluarga tabel DATUM
 * (`renderTableXml`: garis mendatar, kepala `tblHeader`, baris `cantSplit`, lebar dari
 * pemecah kolom), dipisah paragraf spacer peran `spacer.generic` (dua `w:tbl` yang
 * bersebelahan digabung Word menjadi satu tabel). Urutan bagian sama dengan HTML,
 * sehingga teks sel HTML = DOCX untuk blok yang sama.
 *
 * Blok `contractItem` (`F:<slotKey>/<n>`) tidak dirender terpisah (perakit
 * `assemble/index.ts`): butir sudah menjadi baris ke-n tabel butir.
 */
import type { DocxFragment, NormBlock, RenderContext, TableBlock } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { renderTableXml } from "../tables/render";
import { BlockEnv } from "./env";

const MODULE = "engine/docx/blocks";

/** Urutan bagian tetap (register 05 §5.1), sama dengan HTML. */
export const CONTRACT_RECORD_PARTS = ["facts", "items", "evidence", "refs"] as const;

interface ContractRecordContent {
  type: "contractRecord";
  facts: TableBlock;
  items?: TableBlock;
  evidence?: TableBlock;
  refs?: TableBlock;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTable(v: unknown): v is TableBlock {
  return isObj(v) && typeof v.type === "string" && Array.isArray(v.rows);
}

function contentOf(block: NormBlock, ctx: RenderContext): ContractRecordContent {
  const c = block.content;
  const problem = !isObj(c)
    ? "isi bukan objek"
    : c.type !== "contractRecord"
      ? `type isi "${String(c.type)}" bukan contractRecord`
      : !isTable(c.facts)
        ? "facts bukan TableBlock"
        : (["items", "evidence", "refs"] as const).find((k) => c[k] !== undefined && !isTable(c[k]))
          ? "items/evidence/refs bukan TableBlock"
          : undefined;
  if (problem) {
    const message = `${MODULE}: contractRecord ${block.address ?? block.blockId}: ${problem}`;
    ctx.log({ level: "error", message, code: "BY_CONSTRUCTION_FAILED", address: block.address ?? undefined });
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, { blockId: block.blockId, address: block.address });
  }
  return c as unknown as ContractRecordContent;
}

export function renderContractRecord(block: NormBlock, ctx: RenderContext): DocxFragment {
  const c = contentOf(block, ctx);
  const env = new BlockEnv(block, ctx);
  const spacer = env.para(env.role("spacer.generic").para ?? {}, "");
  const faces = new Set<string>();
  const parts: string[] = [];
  for (const part of CONTRACT_RECORD_PARTS) {
    const t = c[part];
    if (!t) continue;
    // Tanpa `artifactLabel`: tabel isi slot bukan artefak bernomor (compose tanpa caption).
    const frag = renderTableXml(t, ctx, { address: block.address });
    for (const f of frag.facesUsed ?? []) faces.add(f);
    parts.push(frag.xml);
  }
  for (const f of env.used) faces.add(f);
  return { xml: parts.join(spacer), facesUsed: [...faces].sort() };
}
