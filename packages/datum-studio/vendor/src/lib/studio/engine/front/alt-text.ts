/**
 * Nama dan teks alternatif figur (FIX-H8, D-322; uji Hermes E: objek "Picture 1-6").
 *
 * SATU sumber untuk DOCX (`wp:docPr` `name`, `title`, `descr`) dan HTML (`alt` /
 * `aria-label`), agar pembaca layar dan panel seleksi Word membaca hal yang sama:
 *   - `name` / `title`: "<label> — <caption>" dipendekkan pada batas kata
 *     (`FIGURE_NAME_MAX` karakter, elipsis), mis. "Gambar 3.1 — Konstelasi pada dua catatan…";
 *   - `descr` / `alt`: label + caption utuh + "Sumber: <baris sumber>".
 * Caption kosong -> subjek bermakna dari jenis figur ("Grafik P-01", "Diagram",
 * "Gambar <berkas>", "Lembar simbol HS"), tidak pernah "Picture n".
 * Figur berlembar banyak memberi akhiran "(lembar i/n)" / "(sheet i/n)".
 * Modul murni tanpa I/O; teks diserialkan oleh pemanggil (escape XML/HTML di sana).
 *
 * Lokasi (FIX-HR2, D-332 C4): modul bersama `engine/front/` (dulu
 * `engine/docx/figures/alt-text.ts`), agar renderer HTML tidak mengimpor dari folder
 * mesin DOCX; `engine/docx/figures` tetap mengekspor ulang API yang sama.
 */

export type FigureAltType = "chart" | "diagram" | "image" | "symbolSheet";

export interface FigureAltInput {
  type: FigureAltType;
  /** Label bernomor ("Gambar 3.1"); boleh kosong. */
  label?: string;
  /** Caption polos; boleh kosong. */
  caption?: string;
  /** Baris sumber polos (tanpa label "SUMBER"); boleh kosong. */
  source?: string;
  /** Bahasa dokumen; bawaan ID. */
  language?: string;
  /** Petunjuk jenis: kode chart ("P-01"), jenis diagram, nama berkas gambar, dialek simbol. */
  kindHint?: string;
  /** Lembar ke-`index` (1-based) dari `count`; akhiran hanya bila count > 1. */
  sheet?: { index: number; count: number };
}

export interface FigureAltText {
  name: string;
  title: string;
  descr: string;
}

/** Panjang maksimum `name`/`title` (karakter) sebelum dipendekkan. */
export const FIGURE_NAME_MAX = 80;
/** Panjang maksimum `descr`/`alt` (karakter); caption satu kalimat jauh di bawahnya. */
export const FIGURE_DESCR_MAX = 1000;
/** Pemisah label dan subjek. */
export const FIGURE_NAME_SEPARATOR = " — ";

const WORDS = {
  ID: { chart: "Grafik", diagram: "Diagram", image: "Gambar", symbolSheet: "Lembar simbol", sheet: "lembar", source: "Sumber" },
  EN: { chart: "Chart", diagram: "Diagram", image: "Image", symbolSheet: "Symbol sheet", sheet: "sheet", source: "Source" },
} as const;

/** Spasi dirapatkan (tab/baris baru jadi satu spasi), ujung dipangkas. */
export function normalizeAltText(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Buang label baris sumber di depan ("SUMBER", "Sumber:", "SOURCE") agar tidak terulang setelah "Sumber:". */
export function stripSourceLabel(s: string | undefined): string {
  return (s ?? "").replace(/^\s*(?:SUMBER|Sumber|SOURCE|Source)\b[\s:]*/u, "");
}

/** Pendekkan pada batas kata terakhir sebelum `max` (elipsis termasuk dalam batas). */
export function shortenAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  const head = (sp >= max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—-]+$/u, "");
  return `${head}…`;
}

function fileStem(hint: string): string {
  const base = hint.split(/[\\/]/).pop() ?? hint;
  return base.replace(/\.(png|jpe?g)$/i, "");
}

/** Subjek cadangan bila caption kosong. */
function kindSubject(type: FigureAltType, hint: string, w: (typeof WORDS)[keyof typeof WORDS]): string {
  const h = normalizeAltText(hint);
  if (type === "image") {
    const stem = h ? fileStem(h) : "";
    // Kunci aset bersha256 bukan label bermakna.
    return stem && !/^[0-9a-f]{16,}$/i.test(stem) ? `${w.image} ${stem}` : w.image;
  }
  if (type === "chart") return h && h !== "composite" ? `${w.chart} ${h}` : w.chart;
  if (type === "symbolSheet") return h ? `${w.symbolSheet} ${h}` : w.symbolSheet;
  return w.diagram;
}

export function figureAltText(i: FigureAltInput): FigureAltText {
  const w = i.language === "EN" ? WORDS.EN : WORDS.ID;
  const label = normalizeAltText(i.label);
  const caption = normalizeAltText(i.caption);
  const source = normalizeAltText(i.source);
  const subject = caption || kindSubject(i.type, i.kindHint ?? "", w);
  const suffix = i.sheet && i.sheet.count > 1 ? ` (${w.sheet} ${i.sheet.index}/${i.sheet.count})` : "";

  const shortHead = label ? `${label}${FIGURE_NAME_SEPARATOR}${subject}` : subject;
  const name = shortenAtWord(shortHead, FIGURE_NAME_MAX - suffix.length) + suffix;

  let descr = shortHead + suffix;
  if (source) descr += `${/[.!?…]$/u.test(descr) ? "" : "."} ${w.source}: ${source}`;
  return { name, title: name, descr: shortenAtWord(descr, FIGURE_DESCR_MAX) };
}
