/**
 * Potongan OOXML figur (S19): run teks, paragraf, dan gambar `wp:inline`.
 * Serialisasi rPr/pPr memakai helper paket inti (S14, `../package/xml`) agar
 * urutan anak elemen sama di seluruh dokumen.
 *
 * Bentuk `wp:inline` mengikuti BM (research/07 §7: 52 penempatan, semuanya
 * inline di badan): `wp:extent` = `a:ext` dalam EMU (mm x 36000, dibulatkan),
 * `wp:docPr` + `pic:cNvPr`, `a:stretch/a:fillRect`, `a:prstGeom rect`, tanpa
 * `distT/B/L/R` dan tanpa `wp:effectExtent`. Namespace `wp`, `a`, `pic`
 * dideklarasikan pada `wp:inline` sehingga potongan tidak bergantung pada
 * deklarasi akar dokumen (prefiks `r` disediakan akar `w:document`).
 */
import type { Inline, ParaFormat, ParamMap, Run, RunProps } from "../../../contract";
import { attrs, escapeXml, hfRunsXml, pPrXml, rPrXml, stripMdLite } from "../package/xml";

export const EMU_PER_MM = 36000;

export const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";

/**
 * Basis id `wp:docPr` figur: `DOCPR_ID_BASE + ordinal * 16 + indeks lembar`.
 * Unik per blok dan deterministik; perakit S20 boleh menomori ulang berurutan.
 */
export const DOCPR_ID_BASE = 100000;

export function mmToEmu(mm: number): number {
  return Math.round(mm * EMU_PER_MM);
}

function textEl(t: string): string {
  const preserve = /^\s|\s$|\s{2}/.test(t);
  return `<w:t${preserve ? ' xml:space="preserve"' : ""}>${escapeXml(t)}</w:t>`;
}

/** Satu run teks; string kosong -> "". */
export function textRun(t: string, props: RunProps, params: ParamMap): string {
  if (t.length === 0) return "";
  return `<w:r>${rPrXml(props, params)}${textEl(t)}</w:r>`;
}

/** Inline (md-lite dipolos atau runs apa adanya) dengan RunProps dasar. */
export function inlineRunsXml(i: Inline, base: RunProps, params: ParamMap): string {
  if ("text" in i) return textRun(stripMdLite(i.text), base, params);
  return hfRunsXml(i.runs as readonly Run[], base, params);
}

export function paragraphXml(format: ParaFormat | undefined, runsXml: string): string {
  return `<w:p>${pPrXml(format)}${runsXml}</w:p>`;
}

export interface InlineDrawing {
  relId: string;
  docPrId: number;
  /** `wp:docPr/@name`: nama objek bermakna (FIX-H8, mis. "Gambar 3.1 — <caption>"). */
  docPrName: string;
  /** Teks alternatif `wp:docPr/@descr` (label + caption + sumber). */
  descr?: string;
  /** `wp:docPr/@title` (judul teks alternatif). */
  title?: string;
  /** `pic:cNvPr/@name` (nama berkas). */
  fileName: string;
  widthMm: number;
  heightMm: number;
}

export function inlineDrawingXml(d: InlineDrawing): string {
  const cx = mmToEmu(d.widthMm);
  const cy = mmToEmu(d.heightMm);
  return (
    `<w:drawing><wp:inline xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr${attrs({ id: d.docPrId, name: d.docPrName, descr: d.descr || undefined, title: d.title || undefined })}/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr${attrs({ id: 0, name: d.fileName })}/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${escapeXml(d.relId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

/** Paragraf gambar: satu run tanpa rPr berisi `w:drawing` (RS01, K-32). */
export function drawingParagraphXml(format: ParaFormat, d: InlineDrawing): string {
  return paragraphXml(format, `<w:r>${inlineDrawingXml(d)}</w:r>`);
}
