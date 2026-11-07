/**
 * IMPL-W4 butir 4 (D-547): fon tertanam untuk rasterisasi SVG -> PNG (DOCX).
 *
 * Akar label kategori terpotong (Gambar 6.1 r5/r5b, PNG identik byte): SVG chart meminta "IBM Plex Sans Condensed"
 * dan "IBM Plex Mono", tetapi halaman Chromium rasterisasi hanya melihat fon sistem (Condensed -> Plex Sans yang lebih
 * lebar, Mono -> serif bawaan; terukur lewat hash PNG). Geometri dan lint chart diukur dengan metrik Plex Condensed.
 *
 * Siklus perbaikan 1 (review 15):
 * - F4: SATU sumber wajah = `engine/html/base/fonts.ts` (`fontFaceCssDetailed`: aset templat bila ada, manifest S13,
 *   verifikasi sha256, alias Cond/Condensed). Tidak ada daftar berkas kedua.
 * - F6: keluarga milik templat (peran `type.face.*`) tanpa berkas -> `FILE_MISSING_ON_DISK` dilempar (keras, tidak pernah
 *   kembali diam-diam ke fon sistem); kegagalan tidak di-cache.
 * - F7: aset Plex subset Latin tanpa ≤ ≥ →; wajah glif simbol templat (DejaVu Sans, `unicode-range` simbol) didaftarkan
 *   SESUDAH wajah Plex dengan nama keluarga Plex yang sama dan deskriptor berat/gaya yang sama, sehingga karakter simbol
 *   di teks Plex dicetak DejaVu (komposit), bukan cadangan bawaan Chromium.
 * SVG tidak berubah (manifest SVG bersih tetap).
 */
import type { ResolvedTemplate } from "../../contract";
import { cssString, fontFaceCssDetailed, roleFamily } from "../html/base/fonts";

/** Templat minimal: peran fon bawaan katalog + manifest aset S13 (dipakai bila pemanggil tidak memberi templat). */
const MIN_TPL = { params: {}, assets: {} } as unknown as ResolvedTemplate;
/** Nama keluarga yang boleh diteruskan ke pembangun `@font-face` (bukan teks bebas SVG). */
const SAFE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Keluarga fon yang dirujuk SVG (atribut `font-family` dan properti gaya `font-family:`), nama asli, unik. */
export function svgFontFamilies(svg: string): string[] {
  const out = new Set<string>();
  const add = (list: string) => {
    for (const f of list.split(",")) {
      const name = f.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ").trim();
      if (name !== "") out.add(name);
    }
  };
  for (const m of svg.matchAll(/font-family="([^"]{1,200})"/g)) add(m[1].replace(/&quot;/g, '"'));
  for (const m of svg.matchAll(/font-family:\s*([^;"}]{1,200})/g)) add(m[1]);
  return [...out];
}

export interface RasterFonts {
  /** Aturan `@font-face` (kosong bila tidak ada keluarga templat yang dirujuk). */
  css: string;
  /** Keluarga yang ditanam (nama seperti di SVG), untuk cek muat sesudah tata letak. */
  families: string[];
}

const RULE_RE = /@font-face\{[^}]*\}/g;
const familyOf = (rule: string) => /font-family:("(?:[^"\\]|\\.)*")/.exec(rule)?.[1] ?? "";
const descriptors = (rule: string) => `${/font-weight:\d+/.exec(rule)?.[0] ?? "font-weight:400"};${/font-style:\w+/.exec(rule)?.[0] ?? "font-style:normal"}`;

/**
 * `@font-face` data: untuk keluarga templat yang dirujuk SVG (nama keluarga = nama di SVG) + wajah simbol komposit (F7).
 * `tpl` = templat dokumen bila ada (aset fon templat menang), selain itu peran bawaan + manifest S13.
 */
export function rasterFontCss(svg: string, tpl: ResolvedTemplate = MIN_TPL): RasterFonts {
  const symbol = roleFamily(tpl, "symbolGlyph");
  let symbolCache: string[] | null = null;
  const symbolRules = () => (symbolCache ??= (fontFaceCssDetailed(tpl, new Set([`${symbol}|regular`])).css.match(RULE_RE) ?? []).filter((r) => r.includes("unicode-range")));
  const rules: string[] = [];
  const families: string[] = [];
  for (const name of svgFontFamilies(svg)) {
    if (!SAFE_FAMILY.test(name) || name.toLowerCase() === symbol.toLowerCase()) continue;
    const got = fontFaceCssDetailed(tpl, new Set([name]));
    const own = got.css.match(RULE_RE) ?? [];
    if (own.length === 0) continue;
    const css = cssString(name);
    const renamed = own.map((r) => r.replace(familyOf(r), css));
    rules.push(...renamed);
    // F7: simbol sesudah wajah Plex (dipertimbangkan lebih dulu untuk rentang simbol), deskriptor yang sama.
    for (const sr of symbolRules()) for (const d of new Set(renamed.map(descriptors))) rules.push(sr.replace(familyOf(sr), css).replace(/font-weight:\d+;font-style:\w+/, d));
    families.push(name);
  }
  return { css: rules.join(""), families };
}
