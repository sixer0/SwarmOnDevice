/**
 * Primitif XML WordprocessingML untuk blok teks (S16).
 *
 * Sejak INT-W (IP-38, D-110) modul ini hanya pengikat tipis ke satu sumber
 * `../package/xml`, aturan ketat blok: karakter tak sah XML 1.0 (kontrol C0
 * selain tab/LF/CR, surrogate tunggal, nonkarakter FFFE/FFFF) dibuang, lalu
 * `& < > " '` di-escape (`escapeXmlStrict`). Nama ekspor lama tetap.
 */
import { paragraphFromInnerXml, STRICT_TEXT, textXml } from "../package/xml";

export { el, escapeXmlStrict as escapeXml, int, stripInvalidXmlChars } from "../package/xml";

/** `<w:t>` dengan `xml:space="preserve"` hanya bila spasi tepi/ganda perlu dipertahankan. */
export function textEl(text: string): string {
  return textXml(text, STRICT_TEXT);
}

/** Paragraf dari isi `pPr` (tanpa pembungkus) dan isi run; keduanya kosong = `<w:p/>`. */
export function paragraph(pPrInner: string, content: string): string {
  return paragraphFromInnerXml(pPrInner, content);
}
