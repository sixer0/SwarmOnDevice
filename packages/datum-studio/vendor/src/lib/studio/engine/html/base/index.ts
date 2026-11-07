/**
 * Modul engine/html/base (I10, 01_specs.md §8.2; baris S21).
 *
 * HTML dasar paged-media untuk artefak HTML dan pratinjau UI (D-11/D-15:
 * BUKAN sumber PDF dokumen; PDF dokumen = DOCX -> soffice). Tanda tangan
 * `htmlShell`, `tokenCss`, `fontFaceCss` persis kontrak; ekspor lain aditif.
 *
 * - `tokenCss`: properti khusus dari token terselesaikan S11 (warna, grid,
 *   garis, skala tipe), `@page` A4 + margin grid (atas 26 / bawah turunan
 *   D-33), moda rel A/B, kosakata kelas dasar (acuan RL + S22/S24).
 * - `fontFaceCss`: `@font-face` base64 (`data:font/ttf`) dari aset S13 / aset
 *   templat, hanya wajah yang diminta.
 * - `htmlShell`: dokumen lengkap; running head dan blok register "LEMBAR n
 *   DARI N" (cetak: kotak margin `@page` + `counter(page)`/`counter(pages)`;
 *   layar/berhalaman: penghitung CSS `st-sheet`). Tanpa skrip, tanpa URL.
 *
 * Modul murni (masukan -> string); galat dilempar sebagai `StudioEngineError`
 * dan dicatat pemanggil (S24 `ctx.log`, S51 log job persisten).
 */
import type { DocMeta, ResolvedTemplate } from "../../../contract";
import { buildTokenCss } from "./css";
import { fontFaceCssDetailed } from "./fonts";
import { buildHtmlShell } from "./shell";

export function htmlShell(i: {
  tpl: ResolvedTemplate;
  meta: DocMeta;
  bodyHtml: string;
  fontsCss: string;
  previewLabel?: boolean;
}): string {
  return buildHtmlShell(i);
}

export function tokenCss(tpl: ResolvedTemplate): string {
  return buildTokenCss(tpl);
}

export function fontFaceCss(tpl: ResolvedTemplate, faces: ReadonlySet<string>): string {
  return fontFaceCssDetailed(tpl, faces).css;
}

export { fontStack, pageRulesCss, TYPE_ELEMENTS, tokenVars, typeSpec, type TypeElement, type TypeSpec } from "./css";
export {
  cssString,
  FACE_ROLES,
  FONT_SLOTS,
  fontFaceCssDetailed,
  parseFaces,
  roleFamily,
  shellFaces,
  type FaceRequest,
  type FaceRole,
  type FontFaceResult,
  type FontSlot,
} from "./fonts";
export {
  classificationLabel,
  esc,
  pageSheet,
  registerHtml,
  runningHeadHtml,
  runningHeadText,
  type ChapterRef,
  type PageSheetInput,
  type RunningHeadText,
} from "./markup";
export { pageGeometry, registerDate, type PageGeometry } from "./params";
export {
  assertFontsCss,
  countRailCitations,
  countSheets,
  htmlToText,
  pageFurnitureCss,
  scanUnits,
  SHELL_MARGIN_BOXES,
  type HtmlShellInput,
  type ShellUnit,
} from "./shell";
