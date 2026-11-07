/**
 * Irama vertikal dikunci ke garis dasar (C19 / GF-21; R-74 `render.rhythm.snapToBaseline`,
 * DT-10b manual ID:2680-2685, EN:2748-2753: "Spasi badan, jarak judul, baris tabel, dan tinggi
 * gambar adalah kelipatan 13,5 pt"). Opt-in: false/absen = tidak ada yang diubah (byte sekarang).
 *
 * Aturan sederhana dan aman, hanya pada nilai yang memang ditulis mesin:
 * - tinggi baris `exact`/`atLeast` dibulatkan KE ATAS ke kelipatan garis dasar (tidak pernah
 *   memotong glif); baris `auto` dibiarkan;
 * - jarak sebelum/sesudah dibulatkan ke kelipatan terdekat dengan MINIMUM satu garis dasar (`snapSpacingTw`):
 *   jarak bukan nol tidak pernah menjadi 0 (review C34 #5, D-650: aturan "terdekat" murni membuat jarak < 6,75 pt
 *   hilang, kepala section menempel ke badan); 0 tetap 0; nilai absen = gaya Normal, yang di kedua profil DATUM
 *   bernilai 0, tidak ditulis;
 * - blok yang ujungnya diganjal ke kisi (paragraf gambar, apparatus ber-leading exact) mempertahankan jarak
 *   sesudah yang ditulis dan menambah sisa sampai garis dasar berikutnya (tidak dibulatkan dulu), jadi jarak
 *   sesudah tidak pernah lebih kecil dari yang ditulis dan blok tetap berakhir pada kisi (GF-21);
 * - tinggi gambar tidak diskalakan (lebar 128/166 mm tetap, GF-10/GF-11);
 * - tinggi baris tabel: `w:trHeight atLeast` = perkiraan tinggi isi baris (margin sel + jarak +
 *   jumlah baris teks terbungkus x tinggi baris, `rowWrappedTw`) dibulatkan ke atas;
 * - caption, KUNCI dan SUMBER mempertahankan leading-nya (GF-21 (a), `snapApparatusPara`).
 * Badan (9,5/13,5 pt, GF-06) tidak disentuh: barisnya sudah 270 tw.
 */
import type { ParaFormat, ParamValue } from "../../../contract";
import { PARAMS_BY_KEY } from "../../../params";
import { measure, type TextFace } from "../../chart/core/textfit";

/** R-74 (C19 / GF-21). */
export const PARAM_SNAP_TO_BASELINE = "render.rhythm.snapToBaseline";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Garis dasar (twip) bila R-74 true, selain itu undefined. Nilai dari `type.baselinePt`
 * (SR-05, turunan leading badan; DATUM 13,5 pt = 270 tw), cadangan bawaan registri.
 */
export function baselineSnapTw(param: (key: string) => ParamValue | undefined): number | undefined {
  if (param(PARAM_SNAP_TO_BASELINE) !== true) return undefined;
  const v = param("type.baselinePt");
  const pt = isNum(v) ? v : PARAMS_BY_KEY.get("type.baselinePt")?.default;
  return isNum(pt) ? Math.round(pt * 20) : undefined;
}

/** Kelipatan garis dasar terkecil >= v (paling sedikit satu garis dasar). */
export function snapUpTw(v: number, base: number): number {
  return Math.max(base, Math.ceil(v / base) * base);
}

/** Kelipatan garis dasar terdekat (setengah ke atas); 0 tetap 0. */
export function snapNearTw(v: number, base: number): number {
  return Math.round(v / base) * base;
}

/**
 * Jarak paragraf pada kisi: kelipatan terdekat dengan minimum satu garis dasar; 0 (atau negatif) apa adanya.
 * Dipilih "terdekat, minimum satu" alih-alih "selalu ke atas": hanya celah kecil (< 1 garis dasar) yang membesar;
 * jarak yang lebih besar bergeser paling banyak setengah garis dasar (ke atas selalu bisa menambah hampir satu
 * garis dasar penuh, mis. 280 -> 540, yang membuka lubang di halaman).
 */
export function snapSpacingTw(v: number, base: number): number {
  return v > 0 ? Math.max(base, snapNearTw(v, base)) : v;
}

/** Jarak sesudah `after` ditambah sisa sehingga blok setinggi `total` (sudah termasuk `after`) berakhir pada kisi. */
function padToGrid(after: number, total: number, base: number): number {
  return after + (snapUpTw(total, base) - total);
}

/** Jarak sebelum/sesudah ke kisi (`snapSpacingTw`) dan tinggi baris exact/atLeast ke atas; medan absen tetap absen. */
export function snapParaToBaseline(para: ParaFormat, base: number): ParaFormat {
  const out: ParaFormat = { ...para };
  if (out.spacingBeforeTw !== undefined) out.spacingBeforeTw = snapSpacingTw(out.spacingBeforeTw, base);
  if (out.spacingAfterTw !== undefined) out.spacingAfterTw = snapSpacingTw(out.spacingAfterTw, base);
  if (out.lineTw !== undefined && (out.lineRule === "exact" || out.lineRule === "atLeast")) out.lineTw = snapUpTw(out.lineTw, base);
  return out;
}

/**
 * GF-21 (a): paragraf apparatus (caption tabel/figur, KUNCI, SUMBER) MEMPERTAHANKAN leading-nya sendiri. Tabel 8.2
 * menetapkan caption "7,6 / 11 pt" (ID:2635), dan DT-10b (ID:2683-2685) menyebut jarak badan, jarak judul, baris
 * tabel dan tinggi gambar, bukan leading caption. Untuk tinggi baris `exact`: tinggi baris tetap, jarak sebelum ke
 * kisi (`snapSpacingTw`: caption 120 -> 270, bukan 0), lalu jarak sesudah YANG DITULIS ditambah sisa sehingga blok
 * satu baris (sebelum + baris + sesudah) berakhir pada garis dasar (caption 48 -> 50: caption tetap dekat dengan
 * tabelnya; membulatkan 48 ke satu garis dasar dulu akan menjauhkan caption dari tabel lebih dari dari teks di atasnya). Caption yang membungkus ke beberapa baris berakhir lebih awal dari kisi (selisih (n-1) x
 * (garis dasar - baris)); jumlah baris tidak diketahui di sini. Tinggi baris selain `exact` = aturan
 * `snapParaToBaseline` (tinggi sebenarnya tidak diketahui).
 */
export function snapApparatusPara(para: ParaFormat, base: number): ParaFormat {
  if (para.lineTw === undefined || para.lineRule !== "exact") return snapParaToBaseline(para, base);
  const out: ParaFormat = { ...para };
  if (out.spacingBeforeTw !== undefined) out.spacingBeforeTw = snapSpacingTw(out.spacingBeforeTw, base);
  const after = out.spacingAfterTw ?? 0;
  out.spacingAfterTw = padToGrid(after, (out.spacingBeforeTw ?? 0) + para.lineTw + after, base);
  return out;
}

/**
 * Paragraf gambar: jarak sebelum dan tinggi baris seperti paragraf lain (`snapParaToBaseline`), lalu jarak sesudah
 * yang ditulis ditambah sisa sehingga tinggi gambar + jarak sebelum + jarak sesudah berakhir pada garis dasar
 * (paragraf Datum Rule: gambar 137 tw, sesudah 80 -> 133).
 */
export function snapDrawingPara(para: ParaFormat, heightTw: number, base: number): ParaFormat {
  const out = snapParaToBaseline(para, base);
  const before = out.spacingBeforeTw ?? 0;
  const after = para.spacingAfterTw ?? 0;
  return { ...out, spacingAfterTw: padToGrid(after, Math.round(heightTw) + before + after, base) };
}

function attr(xml: string, name: string): number | undefined {
  const m = new RegExp(`\\b${name}="(-?\\d+)"`).exec(xml);
  return m ? Number(m[1]) : undefined;
}

/**
 * Perkiraan tinggi satu baris teks sebuah baris tabel (twip) dari XML sel yang baru ditulis:
 * maksimum atas sel `w:tc` (margin atas + bawah `w:tcMar` + jarak sebelum/sesudah + tinggi
 * baris paragraf pertama; baris `auto` dihitung satu garis dasar).
 */
export function rowSingleLineTw(tcsXml: string, base: number): number {
  let best = 0;
  for (const tc of tcsXml.split("<w:tc>").slice(1)) {
    const tcPr = /^<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(tc)?.[1] ?? "";
    const mar = /<w:tcMar>([\s\S]*?)<\/w:tcMar>/.exec(tcPr)?.[1] ?? "";
    const top = attr(/<w:top [^>]*>/.exec(mar)?.[0] ?? "", "w:w") ?? 0;
    const bottom = attr(/<w:bottom [^>]*>/.exec(mar)?.[0] ?? "", "w:w") ?? 0;
    const pPr = /<w:p>(?:<w:pPr>([\s\S]*?)<\/w:pPr>)?/.exec(tc)?.[1] ?? "";
    const sp = /<w:spacing [^>]*>/.exec(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ""))?.[0] ?? "";
    const rule = /w:lineRule="(\w+)"/.exec(sp)?.[1];
    const line = attr(sp, "w:line");
    const lineTw = line !== undefined && (rule === "exact" || rule === "atLeast") ? line : base;
    best = Math.max(best, top + bottom + (attr(sp, "w:before") ?? 0) + lineTw + (attr(sp, "w:after") ?? 0));
  }
  return best;
}

// ── GF-21 (b): tinggi baris tabel dari jumlah baris teks terbungkus ─────────────────────────────

/**
 * Kelonggaran ukur: sebuah baris dianggap muat bila lebarnya <= lebar teks sel x 1,03. Tabel lebar glif `textfit`
 * mengabaikan kerning (lebar terukur sedikit di atas lebar nyata), jadi kelonggaran ini menjaga perkiraan agar
 * tidak MELEBIHI jumlah baris sebenarnya.
 */
const WRAP_SLACK = 1.03;
const MM_PER_TW = 25.4 / 1440;
/** Titik putus sesudah tanda ini (kata majemuk; sama dengan `textfit.words`), selain spasi. */
const BREAK_AFTER = new Set(["-", "/", "\u2013", "\u2014"]);

interface RunFont {
  pt: number;
  face: TextFace;
  bold: boolean;
  caps: boolean;
  trackMm: number;
}

function xmlText(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function onOff(rPr: string, tag: string): boolean {
  const m = new RegExp(`<w:${tag}(?: w:val="([^"]*)")?\s*/>`).exec(rPr);
  return m !== null && m[1] !== "0" && m[1] !== "false";
}

/** Gaya ukur run dari `w:rPr`; tanpa `w:sz` = undefined (run tidak diukur, lebarnya 0: perkiraan tetap batas bawah). */
function runFontOf(rPr: string): RunFont | undefined {
  const sz = attr(/<w:sz [^>]*>/.exec(rPr)?.[0] ?? "", "w:val");
  if (sz === undefined || sz <= 0) return undefined;
  const ascii = /<w:rFonts [^>]*\bw:ascii="([^"]*)"/.exec(rPr)?.[1] ?? "";
  const spacingTw = attr(/<w:spacing [^>]*>/.exec(rPr)?.[0] ?? "", "w:val") ?? 0;
  return { pt: sz / 2, face: /mono/i.test(ascii) ? "data" : "struct", bold: onOff(rPr, "b"), caps: onOff(rPr, "caps"), trackMm: (spacingTw / 20) * (25.4 / 72) };
}

/**
 * Jumlah baris paragraf sel pada lebar teks `widthTw`: pemenuhan rakus (greedy, = jumlah baris minimum) di titik
 * putus spasi dan sesudah tanda kata majemuk; `w:br` = baris baru; kata yang lebih lebar dari baris menempati satu
 * baris (tanpa potong huruf). Lebar glif `textfit`: IBM Plex Mono = 0,6 em (tepat); selain itu tabel lebar IBM Plex
 * Sans Condensed, yang untuk IBM Plex Serif/Sans adalah BATAS BAWAH (Serif rata-rata ~17 % lebih lebar, per glif
 * >= 0,96x; diukur dari berkas fon render-env). Jadi perkiraan tidak pernah melebihi jumlah baris nyata: baris
 * Serif yang hanya sedikit membungkus bisa terlewat (tetap seperti sebelum GF-21 (b)), tetapi baris tidak pernah
 * diberi tinggi kosong tambahan.
 */
function paraLines(pXml: string, widthTw: number): number {
  const limit = widthTw * MM_PER_TW * WRAP_SLACK;
  let lines = 1;
  let lineW = 0;
  let lineHasWord = false;
  let pendingSpace = 0;
  let wordW = 0;
  const endWord = () => {
    if (wordW === 0) return;
    if (!lineHasWord) lineW = wordW;
    else if (lineW + pendingSpace + wordW <= limit + 1e-9) lineW += pendingSpace + wordW;
    else {
      lines += 1;
      lineW = wordW;
    }
    lineHasWord = true;
    pendingSpace = 0;
    wordW = 0;
  };
  for (const run of pXml.match(/<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>/g) ?? []) {
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? "";
    const font = runFontOf(rPr);
    const body = run.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "");
    for (const m of body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g)) {
      if (m[0].startsWith("<w:br")) {
        endWord();
        lines += 1;
        lineW = 0;
        lineHasWord = false;
        pendingSpace = 0;
        continue;
      }
      const text = m[0].startsWith("<w:tab") ? " " : xmlText(m[1] ?? "");
      for (const ch of text) {
        const w = font ? measure(ch, font.pt, font.face, font) : 0;
        if (ch === " " || ch === "\u00a0" || ch === "\t") {
          endWord();
          if (lineHasWord) pendingSpace += w;
        } else {
          wordW += w;
          if (BREAK_AFTER.has(ch)) endWord();
        }
      }
    }
  }
  endWord();
  return lines;
}

function paraSpacing(pXml: string, base: number): { before: number; after: number; lineTw: number } {
  const pPr = /^<w:p(?: [^>]*)?>(?:<w:pPr>([\s\S]*?)<\/w:pPr>)?/.exec(pXml)?.[1] ?? "";
  const sp = /<w:spacing [^>]*>/.exec(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ""))?.[0] ?? "";
  const rule = /w:lineRule="(\w+)"/.exec(sp)?.[1];
  const line = attr(sp, "w:line");
  return { before: attr(sp, "w:before") ?? 0, after: attr(sp, "w:after") ?? 0, lineTw: line !== undefined && (rule === "exact" || rule === "atLeast") ? line : base };
}

/**
 * GF-21 (b): perkiraan tinggi isi sebuah baris tabel (twip) dari XML sel yang baru ditulis: maksimum atas sel `w:tc`
 * (margin atas + bawah `w:tcMar` + jumlah per paragraf (jarak sebelum + baris terbungkus x tinggi baris + jarak
 * sesudah)). Lebar teks sel = `w:tcW` (dxa) - margin kiri - margin kanan. Sel tanpa `w:tcW` dxa atau dengan tabel
 * bersarang memakai perkiraan satu baris lama (`rowSingleLineTw`). Untuk sel satu paragraf satu baris hasilnya sama
 * dengan perkiraan satu baris. Batas bawah (lihat `paraLines`): baris yang terlewat tumbuh sendiri seperti sebelumnya.
 */
export function rowWrappedTw(tcsXml: string, base: number): number {
  let best = 0;
  for (const tc of tcsXml.split("<w:tc>").slice(1)) {
    const tcPr = /^<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(tc)?.[1] ?? "";
    const tcW = /<w:tcW [^>]*>/.exec(tcPr)?.[0] ?? "";
    const mar = /<w:tcMar>([\s\S]*?)<\/w:tcMar>/.exec(tcPr)?.[1] ?? "";
    const side = (s: string) => attr(new RegExp(`<w:${s} [^>]*>`).exec(mar)?.[0] ?? "", "w:w") ?? 0;
    const width = attr(tcW, "w:w");
    const body = tc.replace(/^<w:tcPr>[\s\S]*?<\/w:tcPr>/, "");
    if (width === undefined || !/w:type="dxa"/.test(tcW) || body.includes("<w:tbl>")) {
      best = Math.max(best, rowSingleLineTw(`<w:tc>${tc}`, base));
      continue;
    }
    const textW = Math.max(1, width - side("left") - side("right"));
    let h = side("top") + side("bottom");
    for (const p of body.match(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g) ?? []) {
      const s = paraSpacing(p, base);
      h += s.before + paraLines(p, textW) * s.lineTw + s.after;
    }
    best = Math.max(best, h);
  }
  return best;
}
