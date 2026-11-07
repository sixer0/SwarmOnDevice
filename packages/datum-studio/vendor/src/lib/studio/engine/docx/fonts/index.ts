/**
 * Modul engine/docx/fonts (I04, 01_specs.md §8.2), diisi S15.
 *
 * Penanaman fon DOCX tanpa Word COM: skema odttf terobfuskasi (port RL
 * scripts/embed_fonts.py). Modul ini menyusun rencana (wajah, slot, GUID,
 * partName, relId) dan mengobfuskasi byte; penulisan `word/fontTable.xml`
 * (`w:embed*` + `w:fontKey`), `word/_rels/fontTable.xml.rels`, bagian
 * `word/fonts/fontN.odttf`, dan Default tipe isi
 * `application/vnd.openxmlformats-officedocument.obfuscatedFont` dikerjakan
 * paket S14 (`engine/docx/package/fonts.ts`) dari rencana ini.
 */
import type { EmbeddedFontPlan, ResolvedTemplate } from "../../../contract";
import { obfuscateFont as obfuscate } from "./obfuscate";
import { planEmbeddedFontsDetailed, type PlanOptions } from "./plan";

/** Tipe isi bagian odttf (Default `Extension="odttf"` di [Content_Types].xml). */
export const ODTTF_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.obfuscatedFont";
/** Tipe relasi fontTable.xml.rels -> fonts/fontN.odttf. */
export const FONT_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";

/** Obfuscation odttf (XOR 32 byte awal dengan kunci GUID terbalik), tanpa Word COM. */
export function obfuscateFont(ttf: Uint8Array, guid: string): Uint8Array {
  return obfuscate(ttf, guid);
}

/**
 * Rencana penanaman untuk keluarga yang dipakai dokumen (`facesUsed` = nama
 * `w:rFonts`), dikonfigurasi R-08 `render.docx.embedFonts` dan R-04
 * `render.docx.embedTrueTypeFonts`. Deterministik. Opsi lanjutan dan daftar
 * slot yang dilewati: `planEmbeddedFontsWith` / `planEmbeddedFontsDetailed`.
 */
export function planEmbeddedFonts(tpl: ResolvedTemplate, facesUsed: ReadonlySet<string>): EmbeddedFontPlan {
  return planEmbeddedFontsDetailed(tpl, facesUsed).plan;
}

/** planEmbeddedFonts dengan opsi (kebijakan bold, sumber fon pengganti, nilai R-08 pengganti). */
export function planEmbeddedFontsWith(
  tpl: ResolvedTemplate,
  facesUsed: ReadonlySet<string>,
  opts: PlanOptions,
): EmbeddedFontPlan {
  return planEmbeddedFontsDetailed(tpl, facesUsed, opts).plan;
}

export { deobfuscateFont, deriveFontGuid, guidKeyBytes, OBFUSCATED_PREFIX_BYTES } from "./obfuscate";
export {
  BOLD_FACE_POLICIES,
  FACE_ROLES,
  FONT_SLOTS,
  PARAM_EMBED_FONTS,
  PARAM_EMBED_TRUETYPE,
  parseEmbedFamilies,
  pickFace,
  planEmbeddedFontsDetailed,
} from "./plan";
export type { BoldFacePolicy, EmbedFamilyConfig, FaceRole, FontPlanDetail, FontSlot, PlanOptions, PlannedFace } from "./plan";
export { fontSourcesFromManifest, fontSourcesFromTemplate, loadFontCatalog, loadFontFace, normalizeFamily } from "./catalog";
export type { FontFace, FontSource } from "./catalog";
export { readSfntFaceInfo } from "./sfnt";
export type { SfntFaceInfo } from "./sfnt";
export {
  findRelabelAlias,
  findRelabelFace,
  isRelabelKey,
  RELABEL_ALIAS_FACES,
  RELABEL_ASSET_DIR,
  RELABEL_FACES,
  relabelAliasCacheDir,
  relabelAliasSource,
  relabelItalic,
  relabelSource,
  relabelWeight,
} from "./relabel";
export type { RelabelAliasFace, RelabelFace, RelabelSlot } from "./relabel";
export { renameFontFamily } from "./rename";
