/**
 * Run DOCX dan md-lite (S16; I05 `runsXml`, `parseMdLite`).
 *
 * - `runs[]` ditulis APA ADANYA: teks tidak diubah, properti run di atas `base`.
 *   Tab/LF di dalam `t` ditulis sebagai `w:tab`/`w:br` (representasi, bukan
 *   perubahan teks).
 * - md-lite = semantik `DatumDocx._inline()` (datum_docx.py:548, KS-03):
 *   `**tebal**`, `` `mono` ``, `*miring*`, URL/DOI. Penanda md dibuang (itulah
 *   sintaks md-lite); selain itu setiap karakter dipertahankan. Beda yang
 *   disengaja dari acuan: tanda baca di ujung URL (`.,;)`) yang dibuang Python
 *   (`tok.rstrip`) ditulis sebagai run biasa sesudah URL, sehingga teks utuh.
 *   URL ditulis sebagai run mono bergaris bawah (Run tidak memodelkan
 *   hyperlink; relasi eksternal bukan bagian kontrak blok).
 */
import type { Inline, Run, RunProps } from "../../../contract";
import { mergeRun, rPrXml, runPropsOf, type FaceMap } from "./props";
import { el, textEl } from "./xml";

/** Pola token inline Garis A (datum_docx.py INLINE_RE), dipindah apa adanya. */
const INLINE_RE =
  /(\*\*.+?\*\*|`[^`]+`|\*[^*\n]+(?<!\*)\*(?!\*)|https?:\/\/[^\s|)]+|doi\.org\/[^\s|)<>,;]+|iso\.org\/[^\s|)<>,;]+|(?<![\d./])10\.\d{4}\/[^\s|)<>,;]+)/;
const URL_START_RE = /^(https?:\/\/|doi\.org\/|iso\.org\/)/;
const DOI_RE = /^10\.\d{4}\//;
const TRAILING_PUNCT_RE = /[.,;)]+$/;

export interface MdLiteRoles {
  mono: RunProps;
  bold: RunProps;
  italic: RunProps;
}

/** md-lite -> Run[]; token biasa = `{ t }` tanpa properti (memakai `base` penulis). */
export function parseMdLite(text: string, roles: MdLiteRoles): Run[] {
  const out: Run[] = [];
  for (const tok of text.split(INLINE_RE)) {
    if (!tok) continue;
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      out.push({ ...roles.bold, t: tok.slice(2, -2) });
    } else if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      out.push({ ...roles.mono, t: tok.slice(1, -1) });
    } else if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) {
      out.push({ ...roles.italic, t: tok.slice(1, -1) });
    } else if (URL_START_RE.test(tok) || DOI_RE.test(tok)) {
      const tail = TRAILING_PUNCT_RE.exec(tok)?.[0] ?? "";
      const url = tail ? tok.slice(0, -tail.length) : tok;
      if (url) out.push({ ...roles.mono, u: "single", t: url });
      if (tail) out.push({ t: tail });
    } else {
      out.push({ t: tok });
    }
  }
  return out;
}

/** Peran md-lite turunan dari run dasar: mono = wajah mono, ukuran dasar - 0,8 pt (datum_docx.py:563). */
export function mdLiteRolesFor(base: RunProps): MdLiteRoles {
  const mono: RunProps = { faceRole: "mono" };
  if (base.szHalfPt !== undefined) mono.szHalfPt = Math.max(2, Math.round(base.szHalfPt - 1.6));
  return { mono, bold: { b: true }, italic: { i: true } };
}

/** Isi run dari teks: `\t` -> `w:tab`, `\n` -> `w:br`, sisanya `w:t`. */
function textContent(t: string): string {
  if (t === "") return "<w:t/>";
  return t
    .split(/(\t|\r?\n)/)
    .filter((piece) => piece !== "")
    .map((piece) => (piece === "\t" ? el("w:tab") : piece === "\n" || piece === "\r\n" ? el("w:br") : textEl(piece)))
    .join("");
}

/**
 * Satu run. `tail` = isi tambahan di dalam run yang sama (mis. `w:tab` sesudah
 * penanda daftar, pola BM.docx K-30/K-35).
 */
export function runXmlWith(run: Run, base: RunProps, faces: FaceMap, used: Set<string>, tail = ""): string {
  const rPr = rPrXml(mergeRun(base, runPropsOf(run)), faces, used);
  if ("field" in run) {
    const instr = run.field === "PAGE" ? " PAGE " : " NUMPAGES ";
    return `<w:fldSimple w:instr="${instr}"><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple>${tail ? `<w:r>${rPr}${tail}</w:r>` : ""}`;
  }
  if ("tab" in run) return `<w:r>${rPr}${el("w:tab")}${tail}</w:r>`;
  if ("br" in run) return `<w:r>${rPr}${el("w:br")}${tail}</w:r>`;
  return `<w:r>${rPr}${textContent(run.t)}${tail}</w:r>`;
}

export function runsXmlWith(runs: readonly Run[], base: RunProps, faces: FaceMap, used: Set<string>): string {
  return runs.map((r) => runXmlWith(r, base, faces, used)).join("");
}

/**
 * Inline -> Run[]. `md` = true: `text` diurai md-lite (prosa); false: `text`
 * menjadi satu run verbatim (judul, label, baris kode).
 */
export function inlineRuns(inline: Inline, base: RunProps, md: boolean): Run[] {
  if ("runs" in inline && Array.isArray(inline.runs)) return inline.runs;
  if ("text" in inline && typeof inline.text === "string") {
    return md ? parseMdLite(inline.text, mdLiteRolesFor(base)) : [{ t: inline.text }];
  }
  throw new TypeError("Inline wajib memuat `text` (string) atau `runs` (larik)");
}

/** Teks polos Inline (untuk log/pesan). */
export function inlinePlain(inline: Inline | undefined): string {
  if (!inline) return "";
  if ("text" in inline && typeof inline.text === "string") return inline.text;
  if ("runs" in inline && Array.isArray(inline.runs)) return inline.runs.map((r) => ("t" in r ? r.t : "")).join("");
  return "";
}
