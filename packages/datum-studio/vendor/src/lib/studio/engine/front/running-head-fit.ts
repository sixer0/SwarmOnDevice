/**
 * G-FIX (verification/23 §4, G-06 / D-593): pas teks kiri kepala halaman ke lebar yang
 * tersedia, supaya kepala halaman tetap satu baris dan klasifikasi rata kanan tidak turun
 * ke baris kedua. Satu sumber untuk perakit DOCX (`docx/package/header-footer.ts`) dan,
 * bila kelak berstruktur sama, renderer HTML.
 *
 * Teks disusun dari segmen yang dipisah " · ". Segmen tanpa `shrinkOrder` (entitas, label
 * bab) tidak pernah dipotong. Segmen berurutan `shrinkOrder` menaik dipendekkan dengan
 * elipsis (pengukuran `textfit`, tanpa kerning = sedikit konservatif); segmen yang tidak
 * bisa menyisakan `MIN_KEPT_GLYPHS` glif dibuang beserta pemisahnya, lalu segmen
 * berikutnya dipendekkan. Teks yang sudah muat dikembalikan persis apa adanya, sehingga
 * keluaran kepala yang sudah muat tetap byte-identik.
 *
 * Pemotongan jatuh di batas kata terakhir yang masih muat (bukan di tengah kata); tanda
 * pemisah dan spasi di ujung dibuang sebelum elipsis. Bila tidak ada satu kata utuh (>=
 * `MIN_KEPT_GLYPHS` glif) yang muat, dipakai potongan per-karakter `ellipsize`.
 */
import { ELLIPSIS, ellipsize, measureFont, type FitFont } from "../chart/core/textfit";

export const RUNNING_HEAD_SEPARATOR = " · ";

/** Sisa glif minimum sebelum elipsis; kurang dari ini segmen dibuang (potongan 1-2 huruf tidak bermakna). */
const MIN_KEPT_GLYPHS = 3;

/** Tanda pemisah/pembuka dan spasi yang tidak boleh menjadi ujung potongan sebelum elipsis. */
const TRAILING_SEPARATORS = /[\s,;:.\-–—·/|&(\[]+$/u;

/**
 * Pendekkan `text` ke `avail` mm: potong di batas kata terakhir yang muat. Mulai dari
 * potongan per-karakter terpanjang (`ellipsize`); bila ia berakhir di tengah kata, mundur
 * ke spasi terakhir di dalamnya. Tanpa batas kata yang menyisakan >= `MIN_KEPT_GLYPHS`
 * glif, potongan per-karakter dikembalikan.
 */
function shortenAtWord(text: string, avail: number, font: FitFont): string {
  const charCut = ellipsize(text, avail, font).text;
  const glyphs = [...text];
  let kept = [...charCut].slice(0, -ELLIPSIS.length);
  if (!(glyphs[kept.length] === undefined || /\s/u.test(glyphs[kept.length]))) {
    let i = kept.length - 1;
    while (i >= 0 && !/\s/u.test(kept[i])) i--;
    if (i < 0) return charCut;
    kept = kept.slice(0, i);
  }
  const wordCut = kept.join("").replace(TRAILING_SEPARATORS, "");
  return [...wordCut].length >= MIN_KEPT_GLYPHS ? wordCut + ELLIPSIS : charCut;
}

export interface RunningHeadSegment {
  text: string;
  /** Urutan pemendekan (kecil = dipendekkan lebih dulu); tanpa nilai = tidak pernah dipotong. */
  shrinkOrder?: number;
}

/** Gabungkan segmen tidak kosong dengan " · " dan pas ke `maxWidthMm` (lihat kepala modul). */
export function fitRunningHeadText(segments: readonly RunningHeadSegment[], maxWidthMm: number, font: FitFont): string {
  const segs = segments.filter((s) => s.text.length > 0).map((s) => ({ ...s }));
  const joined = () => segs.map((s) => s.text).join(RUNNING_HEAD_SEPARATOR);
  if (measureFont(joined(), font) <= maxWidthMm + 1e-9) return joined();

  const order = segs.filter((s) => s.shrinkOrder !== undefined).sort((a, b) => (a.shrinkOrder as number) - (b.shrinkOrder as number));
  for (const seg of order) {
    const total = measureFont(joined(), font);
    if (total <= maxWidthMm + 1e-9) break;
    // Lebar aditif (jumlah glif + renggang): ruang segmen = anggaran - lebar sisanya.
    const avail = maxWidthMm - (total - measureFont(seg.text, font));
    const cut = shortenAtWord(seg.text, avail, font);
    if ([...cut].length - ELLIPSIS.length >= MIN_KEPT_GLYPHS) {
      seg.text = cut;
      break;
    }
    segs.splice(segs.indexOf(seg), 1);
  }
  return joined();
}
