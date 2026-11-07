/**
 * C22 / CV-19 (opt-in nilai enum `sampul belakang` di `device.spine.placements`, register research/38 §2, §4.1):
 * unit sampul belakang HTML, padanan perencana DOCX `planUnitsV2` (c3) (engine D, `docx/assemble/units.ts`).
 *
 * Syarat sama dengan DOCX: snapshot v2, lingkup DOCUMENT (scope absen atau DOCUMENT), predikat penempatan
 * `backCoverPlaced` (sumber bersama DOCX), dan rencana memuat unit `cover` yang bukan placeholder (tanpa sampul,
 * mis. NOTA, tanpa halaman belakang). Unit terakhir `F:backCover` jenis `cover` tanpa slot (konteks dokumen),
 * kepala/kaki `inherit` = mode seksi pembungkus templat seperti sampul depan (tanpa nomor lembar/register), berisi
 * satu blok `backCover` (`{ mode: "auto" }`) yang dirender `htmlBlocks.backCover`.
 * Syarat tidak terpenuhi = `ctx` yang sama dikembalikan (keluaran tidak berubah).
 */
import type { NormBlock, RenderContext } from "../../../contract";
import type { NormBlockV2, NormDocSnapshotV2, NormUnitV2 } from "../../../contract/types/v2/norm";
import { backCoverPlaced } from "../../docx/wrapper/pages";
import { snapshotV2 } from "./slots";

const BACK_COVER_KEY = "F:backCover";
/** Kunci slot sintetis blok (= DOCX `syntheticBlock(key, "backCover", "backCover", ...)`: alamat `F:backCover`). */
const BACK_COVER_SLOT = "backCover";

export function withBackCover(ctx: RenderContext): RenderContext {
  const v2 = snapshotV2(ctx);
  if (!v2) return ctx;
  const documentScope = !ctx.scope || ctx.scope.kind === "DOCUMENT";
  if (!documentScope || !backCoverPlaced(ctx.tpl?.params ?? {})) return ctx;
  const units = v2.units as NormUnitV2[];
  if (!units.some((u) => u.kind === "cover" && u.placeholder !== true)) return ctx;
  const taken = new Set(units.map((u) => u.key));
  let key = BACK_COVER_KEY;
  for (let i = 2; taken.has(key); i += 1) key = `${BACK_COVER_KEY}#${i}`;
  // Tanpa slot: `unitViews` memberi konteks dokumen (DOCX: params dokumen), tanpa atribut slot.
  const unit: NormUnitV2 = { kind: "cover", key, slotKey: "", sectionType: "backCover", setup: { header: { mode: "inherit" }, footer: { mode: "inherit" } } };
  const blockId = `${BACK_COVER_SLOT}:backCover:auto:0`;
  const block: NormBlockV2 = {
    blockId,
    pid: blockId,
    slotKey: "",
    address: `F:${BACK_COVER_SLOT}`,
    ordinal: -1,
    unitKey: key,
    type: "backCover",
    content: { mode: "auto" },
    textPlain: "",
    contentSha256: "",
  };
  const snapshot: NormDocSnapshotV2 = { ...v2, units: [...units, unit], blocks: [...(v2.blocks as NormBlock[] as NormBlockV2[]), block] };
  return { ...ctx, snapshot: snapshot as unknown as RenderContext["snapshot"] };
}
