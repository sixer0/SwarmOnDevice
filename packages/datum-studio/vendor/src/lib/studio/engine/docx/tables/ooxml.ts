/**
 * Serialisasi OOXML keluarga tabel (S17), sejak IP-15 (D-51) diikat ke satu
 * sumber `../package/xml` (S14) dengan ragam `BODY_FLAVOR`: tanpa `w:szCs`,
 * spasi run 0 dilewati, border `none` dinormalisasi (pola BM badan). Modul ini
 * tidak lagi memuat logika serialisasi sendiri; keluaran identik dengan
 * salinan lokal S17 sebelumnya.
 */
import type { BorderSpec, Borders, ParaFormat, ParamMap, Run, RunProps } from "../../../contract";
import {
  BODY_FLAVOR,
  borderXml as pkgBorderXml,
  contentParagraphXml,
  contentRunsXml,
  pPrXml as pkgPPrXml,
  rPrXml as pkgRPrXml,
  sideBordersXml as pkgSideBordersXml,
} from "../package/xml";

export {
  attrs,
  contentRunXml as runXml,
  DEFAULT_FACES as FALLBACK_FACES,
  escapeXml,
  facesInXml,
  resolveFace,
  runOwnProps,
  shadingXml,
} from "../package/xml";

export function rPrXml(props: RunProps, params: ParamMap): string {
  return pkgRPrXml(props, params, undefined, BODY_FLAVOR);
}

export function borderXml(tag: string, b: BorderSpec | undefined): string {
  return pkgBorderXml(tag, b, BODY_FLAVOR);
}

export function sideBordersXml(b: Omit<Borders, "insideH" | "insideV"> | undefined): string {
  return pkgSideBordersXml(b, BODY_FLAVOR);
}

export function pPrXml(f: ParaFormat | undefined): string {
  return pkgPPrXml(f, undefined, BODY_FLAVOR);
}

export function runsXml(runs: readonly Run[], base: RunProps, params: ParamMap): string {
  return contentRunsXml(runs, base, params, BODY_FLAVOR);
}

/** Paragraf lengkap; `runs` kosong + pPr kosong = `<w:p/>` (KT-19). */
export function paragraphXml(format: ParaFormat | undefined, runsInner: string): string {
  return contentParagraphXml(format, runsInner, BODY_FLAVOR);
}
