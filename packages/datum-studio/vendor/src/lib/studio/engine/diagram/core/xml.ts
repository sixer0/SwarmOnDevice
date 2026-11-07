/**
 * Keamanan teks XML untuk SVG diagram dan simbol (IP-39b, S84 #3/#4).
 *
 * - Karakter yang tidak sah di XML 1.0 (C0 selain TAB/LF/CR, U+FFFE, U+FFFF,
 *   dan surrogate tunggal yang tidak berpasangan) dibuang dari setiap teks
 *   sebelum di-escape. Pola sama dengan `engine/docx/package/xml.ts`
 *   (`INVALID_XML_CHARS`): dibuang, tidak diganti.
 * - Isi komentar tidak boleh memuat "--" dan tidak boleh berakhir "-"
 *   (XML 1.0 §2.5). `xmlCommentText` menyisipkan spasi di antara tanda hubung
 *   beruntun sehingga "---" menjadi "- - -", lalu menambah spasi bila berakhir "-".
 * Modul daun: tanpa impor, murni, deterministik.
 */

/** Karakter tidak sah XML 1.0 (Char production) dalam string UTF-16. */
export const XML_INVALID_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Buang karakter yang tidak sah di XML 1.0. */
export function stripXmlInvalid(s: string): string {
  return s.replace(XML_INVALID_CHARS, "");
}

/** Escape isi teks/atribut XML (`& < > "`) setelah membuang karakter tidak sah. */
export function xmlEscapeText(s: string, quote = true): string {
  const t = stripXmlInvalid(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return quote ? t.replace(/"/g, "&quot;") : t;
}

/**
 * Teks aman untuk isi komentar `<!-- ... -->`: karakter tidak sah dibuang,
 * tidak ada "--" (berapa pun panjang deret tanda hubung), tidak berakhir "-".
 */
export function xmlCommentText(s: string): string {
  let t = stripXmlInvalid(s).replace(/-(?=-)/g, "- ");
  if (t.endsWith("-")) t += " ";
  return t;
}
