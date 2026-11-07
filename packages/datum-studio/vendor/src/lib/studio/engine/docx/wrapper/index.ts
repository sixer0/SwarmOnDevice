/**
 * Modul engine/docx/wrapper (I07, 01_specs.md §8.2), diisi S18.
 *
 * `docxWrapper`: renderer DOCX halaman pembungkus dengan format langsung
 * (klaster research/07): sampul rata kiri (pita segel, logo sekali, baris
 * alamat + garis rambut, Datum Rule 166, kicker, judul, standfirst, baris
 * cakupan, blok kendali, kolofon NIB + cap terbit, string punggung), lembar
 * kendali, daftar isi (statis T010 atau medan TOC), pembatas bagian, blok
 * tanda tangan, dan pembuka lampiran. Isi `NormBlock.content` per kunci
 * didokumentasikan di ./pages.ts.
 *
 * Ekspor pendukung untuk perakit S20 / HTML S22:
 * - `wrapperMediaRelId`, `WRAPPER_DOCPR_ID_BASE`: konvensi media sama dengan
 *   figur S19 (`fig-<sha256 32>.<ext>`, relasi `rIdFig<sha256 32>`);
 * - `controlSheetIncludesSignature`: bila true, perakit tidak menempatkan
 *   blok `signatureBlock` terpisah (tanda tangan ikut lembar kendali);
 * - `datumRuleFragment`, `datumRulePng`: citra Datum Rule untuk penempatan lain.
 * Paragraf pemegang sectPr (K-12) tidak ditulis di sini (milik S20).
 *
 * Modul khusus server (node:crypto, node:fs, node:path).
 */
import type { DocxBlockRenderer } from "../../../contract";
import { renderAppendixOpener, renderBackCover, renderControlSheet, renderCover, renderPartDivider, renderSignatureBlock, renderToc } from "./pages";

export type DocxWrapperKey = "cover" | "controlSheet" | "toc" | "partDivider" | "signatureBlock" | "appendix" | "backCover";

export const docxWrapper: Partial<Record<DocxWrapperKey, DocxBlockRenderer>> = {
  cover: renderCover,
  controlSheet: renderControlSheet,
  toc: renderToc,
  partDivider: renderPartDivider,
  signatureBlock: renderSignatureBlock,
  appendix: renderAppendixOpener,
  // C12 / CV-19: blok sampul belakang (unit direncanakan perakit bila backCoverPlaced + ada unit sampul).
  backCover: renderBackCover,
};

export {
  autoColophon,
  autoControlBlock,
  autoControlSheetItems,
  autoCoverItems,
  autoPartBody,
  backCoverPlaced,
  controlSheetIncludesSignature,
  datumRuleFragment,
  deriveTocEntries,
} from "./pages";
export { WrapperBuilder, frontItemsXml, issueStampText, sealBandTexts, spineText, spineXml, type WrapperUnit } from "./render";
export { benchmarkRole, roleFormat, type WrapperRole, type WrapperRoleFormat } from "./formats";
export {
  DATUM_RULE_DPI,
  DEFAULT_LOGO_REL_PATH,
  WRAPPER_DOCPR_ID_BASE,
  datumRulePng,
  encodePngRgba,
  mediaName as wrapperMediaName,
  mediaRelId as wrapperMediaRelId,
} from "./media";
