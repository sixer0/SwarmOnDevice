/**
 * engine/browser (I14, 01_specs.md §8.2) — diisi S25.
 *
 * Satu-satunya pemakai Chromium di aplikasi. Semua operasi lewat runtime.ts:
 * instans tunggal + semafor 1, context baru per operasi dengan JavaScript mati,
 * jaringan diblokir (offline + rute abort), konten hanya lewat `setContent`
 * (tanpa goto/file://, research/03 §4.4), batas waktu per operasi (C07).
 *
 * Fungsi:
 * - `rasterizeSvg`  SVG -> PNG 300 dpi pada ukuran mm (pHYs 11811 px/m ditanam).
 * - `measureLayout` metrik tata letak untuk lint R (S45): halaman, luapan,
 *                   lebar baris dan karakter per baris, ukuran fon terhitung,
 *                   warna per halaman/figur, gambar, tabel.
 * - `previewHtml`   pratinjau HTML sebagai PNG per halaman.
 *
 * Modul ini khusus server (playwright-core, node:fs). `serverExternalPackages`
 * di next.config.ts milik S69.
 */
import type { BrowserHandle, LayoutMetrics, ResolvedTemplate } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { getStudioEnv, RASTER_TIMEOUT_MAX_MS, RASTER_TIMEOUT_PER_LABEL_MS, STUDIO_CHROMIUM_TIMEOUT_MS } from "../../contract/env";
import {
  DOC_SIZE_SCRIPT,
  FONTS_READY_SCRIPT,
  measureExpression,
  PAGE_RECTS_SCRIPT,
} from "./measure";
import { readPngSize, withPngDpi } from "./png";
import { rasterFontCss } from "./raster-fonts";
import {
  ensureBrowser,
  shutdownBrowser,
  StudioBrowserError,
  withSandboxedPage,
} from "./runtime";

export { browserQueueLimits, browserQueueState, setBrowserLogSink, StudioBrowserError } from "./runtime";
export type { BrowserFailureReason, BrowserLogSink } from "./runtime";
export { readPngSize, withPngDpi } from "./png";

const MODULE = "engine/browser";

/** px CSS per mm (96 dpi). */
const PX_PER_MM = 96 / 25.4;
/** Batas masukan lokal modul (bukan kontrak). */
export const BROWSER_MAX_SVG_BYTES = 20 * 1024 * 1024;
export const BROWSER_MAX_HTML_BYTES = 64 * 1024 * 1024;
/** Sisi maksimum bitmap (batas tekstur Chromium aman). */
export const BROWSER_MAX_BITMAP_PX = 16000;
/**
 * D-259: jeda sebelum tangkapan pertama (ms), tangkapan maksimum sampai stabil, dan
 * jeda antar tangkapan. Tangkapan yang diambil segera sesudah `load` mengunci varian
 * antialias glif yang berbeda antar jalan (bimodal, terukur pada lembar simbol dan
 * komposit); sesudah jeda ini 15 figur Manual 000 x5 x3 proses identik 225/225 (diagnosis coder_execution_fixfig).
 */
export const RASTER_FIRST_SHOT_DELAY_MS = 500;
export const RASTER_SETTLE_MAX_SHOTS = 12;
export const RASTER_SETTLE_INTERVAL_MS = 150;
export const BROWSER_MAX_MEASURE_ELEMENTS = 50000;
export const BROWSER_DEFAULT_PREVIEW_MAX_PAGES = 50;
export const BROWSER_MAX_PREVIEW_PAGES = 400;

/** Elemen metrik (kontrak) + medan tambahan S25. Semua tambahan opsional. */
export type LayoutElement = LayoutMetrics["elements"][number];

/**
 * Jenis elemen `kind`:
 * - `page`      kotak `.page`/`[data-page]`; `overflow` = ada isi melewati lembar; `colors` = warna terlihat (DATUM-14)
 * - `document`  dokumen alir tanpa halaman; `colors` seluruh dokumen
 * - `overflow`  elemen terburuk per halaman+label+sumbu yang melewati lembar (DATUM-37); `axis`, `overflowMm`
 * - `clip`      isi melebihi kotaknya sendiri (scrollWidth > clientWidth); `overflowMm`
 * - `text`      blok teks: `measureMm`, `lineCount`, `charCount`, `charsPerLine` (DATUM-15), `maxLineWidthMm`, `fontSizePt`
 * - `figure`    svg tingkat atas: tinggi (DATUM-33), `colors` per figur (DATUM-25)
 * - `svgText`   teks SVG dengan `fontSizePt` terhitung setelah skala (DATUM-28)
 * - `image`     img: `naturalWidthPx`/`naturalHeightPx` (pxGuard DATUM-39)
 * - `table`     kotak tabel; `overflow` bila melewati induknya
 */
export type MeasuredKind = "page" | "document" | "overflow" | "clip" | "text" | "figure" | "svgText" | "image" | "table";

export interface MeasuredElement extends LayoutElement {
  kind: MeasuredKind;
  tag?: string;
  label?: string;
  axis?: "bottom" | "right";
  overflowMm?: number;
  /** Hex #RRGGBB, urut. */
  colors?: string[];
  measureMm?: number;
  lineCount?: number;
  charCount?: number;
  charsPerLine?: number;
  maxLineWidthMm?: number;
  naturalWidthPx?: number;
  naturalHeightPx?: number;
  /** Swarm row 206: `document` element of a flow layout: documentElement.clientWidth, innerWidth (px CSS) and the sheet. */
  layoutWidthPx?: number;
  viewportPx?: number;
  sheetWidthMm?: number;
}

export interface MeasuredLayout extends LayoutMetrics {
  elements: MeasuredElement[];
  /** true bila markup memakai `.page`/`[data-page]`. */
  paged: boolean;
  /** Sumber `pageCount`: hitungan elemen halaman, atau halaman cetak PDF Chromium (dokumen alir). */
  pageCountSource: "elements" | "print" | "none";
  /** true bila elemen dipotong pada `maxElements`. */
  truncated: boolean;
  /** Request jaringan dari konten yang di-abort. */
  blockedRequests: number;
  viewportWidthPx: number;
  media: "screen" | "print";
}

export interface MeasureOptions {
  /** Lembar acuan luapan; default A4 210 x 297 mm. */
  pageWidthMm?: number;
  pageHeightMm?: number;
  /** Lebar viewport px CSS; default lebar lembar. */
  viewportWidthPx?: number;
  /** Media CSS; default "screen". */
  media?: "screen" | "print";
  /** Dokumen alir: hitung halaman cetak lewat PDF Chromium (default true). */
  countPrintPages?: boolean;
  maxElements?: number;
  timeoutMs?: number;
}

export interface PreviewOptions {
  pageWidthMm?: number;
  pageHeightMm?: number;
  /** 72..300; default 96. */
  dpi?: number;
  maxPages?: number;
  media?: "screen" | "print";
  timeoutMs?: number;
}

export interface HtmlPreview {
  /** Total halaman (elemen `.page` atau irisan setinggi lembar). */
  pageCount: number;
  /** PNG per halaman, maksimum `maxPages`. */
  pages: Uint8Array[];
  truncated: boolean;
  dpi: number;
  paged: boolean;
  blockedRequests: number;
}

function fail(op: string, message: string): never {
  throw new StudioBrowserError("INPUT_INVALID", op, message);
}

function assertMm(op: string, name: string, v: unknown, max = 2000): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) fail(op, `${name} must be a finite number in (0, ${max}] mm`);
  return v;
}

function assertSize(op: string, s: unknown, max: number): string {
  if (typeof s !== "string") fail(op, "content must be a string");
  if (Buffer.byteLength(s, "utf8") > max) fail(op, `content exceeds ${max} bytes`);
  return s;
}

/** Ubah panjang SVG/CSS ke px CSS; null bila tidak terbaca (mis. persen). */
function lengthToPx(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?)\s*(px|mm|cm|in|pt|pc)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "px").toLowerCase()) {
    case "mm":
      return n * PX_PER_MM;
    case "cm":
      return n * PX_PER_MM * 10;
    case "in":
      return n * 96;
    case "pt":
      return (n * 96) / 72;
    case "pc":
      return n * 16;
    default:
      return n;
  }
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * Normalisasi SVG untuk disisipkan inline: buang BOM, prolog XML, DOCTYPE dan
 * komentar awal; wajib berawal `<svg`. Bila root tanpa viewBox, tambahkan
 * viewBox dari width/height (satuan pengguna = px CSS) agar skala ke ukuran
 * target vektor penuh, bukan terpotong.
 */
export function prepareSvgForRaster(svg: string, widthMm: number, heightMm: number): string {
  const op = "rasterizeSvg";
  let s = svg.replace(/^\uFEFF/, "").trimStart();
  for (;;) {
    const before = s;
    s = s.replace(/^<\?xml[\s\S]*?\?>\s*/i, "").replace(/^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*/i, "").replace(/^<!--[\s\S]*?-->\s*/, "");
    if (s === before) break;
  }
  if (!/^<svg[\s>]/i.test(s)) fail(op, "input must be an SVG document with an <svg> root");
  const end = s.indexOf(">");
  if (end < 0) fail(op, "unterminated <svg> root tag");
  const rootTag = s.slice(0, end + 1);
  if (attr(rootTag, "viewBox") !== undefined) return s;
  const w = lengthToPx(attr(rootTag, "width")) ?? widthMm * PX_PER_MM;
  const h = lengthToPx(attr(rootTag, "height")) ?? heightMm * PX_PER_MM;
  const insertAt = rootTag.endsWith("/>") ? end - 1 : end;
  return `${s.slice(0, insertAt)} viewBox="0 0 ${+w.toFixed(4)} ${+h.toFixed(4)}"${s.slice(insertAt)}`;
}

/** Pegangan instans tunggal (meluncurkan bila belum). */
export async function getBrowser(): Promise<BrowserHandle> {
  const browser = await ensureBrowser();
  return { engine: "chromium", version: browser.version(), executablePath: getStudioEnv().chromiumPath };
}

/**
 * Rasterisasi SVG ke PNG pada ukuran mm dan dpi (300), aturan ukuran identik
 * dengan adaptor acuan paritas `scripts/parity/reference/fig/raster.py` (S65,
 * IP-27, F-038) agar gerbang ukuran PNG CA/DG/SY membandingkan piksel yang sama:
 *
 *   css    = mm x 96 / 25,4                 (px CSS, tanpa pembulatan)
 *            ukuran root SVG (width/height absolut: mm, cm, in, pt, pc, px,
 *            tanpa satuan = px) dipakai bila selisihnya dengan argumen
 *            <= 0,05 mm, seperti acuan yang membaca atribut root; argumen
 *            mm dari pembangun bisa belum dibulatkan (233,36249999 lawan
 *            atribut "233.362mm" -> 2756 lawan 2753 px)
 *   skala  = dpi / 96                       (device scale factor 3,125)
 *   viewport = ceil(css) per sisi, minimal 1
 *   klip   = { x:0, y:0, width: cssW, height: cssH } (pecahan, skala device)
 *   PNG    = keluaran Chromium untuk klip itu
 *
 * Chromium memotong klip pecahan sebelum diskalakan, sehingga PNG bisa 2-3 px
 * di bawah round(mm / 25,4 x dpi) (128 mm -> 1509, bukan 1512). Ukuran ini
 * mengikuti acuan, bukan rumus; pemeriksaan pasca-render hanya menolak hasil
 * yang menyimpang lebih dari satu px CSS. Body tanpa margin/padding, latar
 * #FFFFFF, svg `display:block` langsung di body (sama dengan acuan); lebar dan
 * tinggi svg diset ke px CSS geometri di atas. pHYs 300 dpi tetap ditanam.
 */
export async function rasterizeSvg(svg: string, i: { widthMm: number; heightMm: number; dpi: 300; tpl?: ResolvedTemplate }): Promise<Uint8Array> {
  const op = "rasterizeSvg";
  assertSize(op, svg, BROWSER_MAX_SVG_BYTES);
  const widthMm = assertMm(op, "widthMm", i?.widthMm);
  const heightMm = assertMm(op, "heightMm", i?.heightMm);
  if (i.dpi !== 300) fail(op, "dpi must be 300");
  const inline = prepareSvgForRaster(svg, widthMm, heightMm);
  const geo = rasterGeometry(widthMm, heightMm, i.dpi, svgRootCssSize(inline));
  if (geo.approxPxW > BROWSER_MAX_BITMAP_PX || geo.approxPxH > BROWSER_MAX_BITMAP_PX) {
    fail(op, `bitmap ${geo.approxPxW}x${geo.approxPxH} px outside 1..${BROWSER_MAX_BITMAP_PX}`);
  }
  // IMPL-W4 butir 4: keluarga templat yang dirujuk SVG ditanam (fon pengukuran chart), bukan fon sistem host.
  const fonts = rasterFontCss(inline, i.tpl);
  let fontMissing: string[] = [];
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    fonts.css +
    `html,body{margin:0;padding:0;background:#FFFFFF}` +
    `svg{display:block}` +
    `body>svg{width:${geo.cssW}px;height:${geo.cssH}px}` +
    `</style></head><body>${inline}</body></html>`;

  // Swarm 1.2.6 M-04 (N-045, N-046): a figure with many labels may take longer than one page op in the bridge
  // (cold fonts, text shaping); the limit grows per <text> element up to RASTER_TIMEOUT_MAX_MS.
  const labels = inline.match(/<text[\s>/]/gi)?.length ?? 0;
  const timeoutMs = Math.min(RASTER_TIMEOUT_MAX_MS, STUDIO_CHROMIUM_TIMEOUT_MS + labels * RASTER_TIMEOUT_PER_LABEL_MS);
  const png = await withSandboxedPage(op, { viewport: geo.viewport, deviceScaleFactor: geo.scale, timeoutMs }, async ({ page }) => {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(FONTS_READY_SCRIPT);
    if (fonts.families.length > 0) {
      // Review 15 F2: hanya wajah yang BENAR-BENAR membentuk glif diperiksa: keluarga pertama terhitung pada teks
      // bertubuh tak kosong, per berat/gaya, dimuat dengan contoh teksnya. Teks kosong, keluarga cadangan di daftar,
      // dan aturan gaya tak terpakai tidak memicu penolakan.
      fontMissing = await page.evaluate(async (fams: string[]) => {
        const norm = (s: string) => s.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
        const embedded = new Set(fams.map(norm));
        const want = new Map<string, string>();
        for (const el of Array.from(document.querySelectorAll("text, tspan"))) {
          const t = (el.textContent ?? "").trim();
          if (t === "") continue;
          const cs = getComputedStyle(el);
          const first = cs.fontFamily.split(",")[0] ?? "";
          if (!embedded.has(norm(first))) continue;
          const font = `${cs.fontStyle} ${cs.fontWeight} 12px "${norm(first)}"`;
          if (!want.has(font)) want.set(font, t.slice(0, 64));
        }
        const bad: string[] = [];
        for (const [font, sample] of want) {
          // Berkas fon rusak -> load() menolak (NetworkError): itu juga "tidak termuat", bukan galat browser.
          const faces = await document.fonts.load(font, sample).catch(() => [] as FontFace[]);
          if (!faces.some((f) => f.status === "loaded")) bad.push(font);
        }
        return bad;
      }, fonts.families);
      if (fontMissing.length > 0) return Buffer.alloc(0);
    }
    const shot = () =>
      page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: geo.cssW, height: geo.cssH },
        animations: "disabled",
        caret: "hide",
        scale: "device",
        omitBackground: false,
      });
    // D-259: jeda sebelum tangkapan pertama (tangkapan dini mengunci varian antialias glif),
    // lalu tangkap ulang sampai dua tangkapan berurutan identik byte: SVG sama -> PNG sama.
    await page.waitForTimeout(RASTER_FIRST_SHOT_DELAY_MS);
    let prev = await shot();
    for (let k = 1; k < RASTER_SETTLE_MAX_SHOTS; k++) {
      await page.waitForTimeout(RASTER_SETTLE_INTERVAL_MS);
      const next = await shot();
      if (Buffer.compare(next, prev) === 0) return next;
      prev = next;
    }
    throw new StudioBrowserError("RENDER_FAILED", op, `raster did not settle after ${RASTER_SETTLE_MAX_SHOTS} captures (non-deterministic bitmap)`);
  });
  // Review 15 F3: penolakan karena isi/aset = deterministik -> 422 BY_CONSTRUCTION_FAILED (bukan 503 sementara).
  if (fontMissing.length > 0) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `rasterizeSvg: fon tertanam tidak termuat untuk teks yang dicetak: ${fontMissing.join(", ")}`, { fonts: fontMissing });
  const size = readPngSize(png);
  // Toleransi satu px CSS (= skala + 1 px device) terhadap ukuran matematis.
  const tol = Math.ceil(geo.scale) + 1;
  if (!size || Math.abs(size.widthPx - geo.approxPxW) > tol || Math.abs(size.heightPx - geo.approxPxH) > tol) {
    throw new StudioBrowserError(
      "RENDER_FAILED",
      op,
      `unexpected bitmap size ${size ? `${size.widthPx}x${size.heightPx}` : "n/a"}, expected about ${geo.approxPxW}x${geo.approxPxH}`,
    );
  }
  return withPngDpi(new Uint8Array(png.buffer, png.byteOffset, png.byteLength), i.dpi);
}

/** Selisih maksimum (mm) agar ukuran root SVG menggantikan argumen. */
const ROOT_SIZE_TOLERANCE_MM = 0.05;

/** Ukuran root SVG dalam px CSS bila width DAN height absolut terbaca; selain itu null. */
export function svgRootCssSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const w = lengthToPx(attr(root, "width"));
  const h = lengthToPx(attr(root, "height"));
  return w !== null && h !== null && w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** Geometri raster (lihat `rasterizeSvg`); diekspor untuk diagnosis/uji. */
export function rasterGeometry(
  widthMm: number,
  heightMm: number,
  dpi: number,
  root: { width: number; height: number } | null = null,
): { cssW: number; cssH: number; scale: number; viewport: { width: number; height: number }; approxPxW: number; approxPxH: number } {
  const tolPx = ROOT_SIZE_TOLERANCE_MM * PX_PER_MM;
  const argW = widthMm * PX_PER_MM;
  const argH = heightMm * PX_PER_MM;
  const useRoot = root !== null && Math.abs(root.width - argW) <= tolPx && Math.abs(root.height - argH) <= tolPx;
  const scale = dpi / 96;
  // Row 122 (C40 FIX CP-47/CP-46, Manual Rev A ID p.61, p.70, p.80 Tabel 13.1 cek 13: 128 mm = 1512 px +-2 at
  // 300 dpi): Chromium truncates the fractional CSS clip before scaling (runtime.ts screenshot), so a 483.78 px
  // clip gave 1509 px. The CSS box is the whole CSS px whose truncated device width is nearest the mathematical
  // width (128 mm -> 484 css px -> 1512 px; 166 mm -> 628 -> 1962 = 1961 +1). The SVG keeps its viewBox and is
  // scaled into that box (at most 1 css px larger than the exact size); pHYs and the DOCX extent stay in mm.
  const fit = (exactCss: number, targetPx: number): number => {
    const lo = Math.max(1, Math.floor(exactCss));
    const cands = [lo, lo + 1];
    return cands.reduce((best, c) => (Math.abs(Math.floor(c * scale) - targetPx) < Math.abs(Math.floor(best * scale) - targetPx) ? c : best));
  };
  const approxPxW = Math.round((widthMm / 25.4) * dpi);
  const approxPxH = Math.round((heightMm / 25.4) * dpi);
  const cssW = fit(useRoot ? root.width : argW, approxPxW);
  const cssH = fit(useRoot ? root.height : argH, approxPxH);
  return {
    cssW,
    cssH,
    scale,
    viewport: { width: Math.max(1, Math.ceil(cssW)), height: Math.max(1, Math.ceil(cssH)) },
    approxPxW,
    approxPxH,
  };
}

function countPdfPages(pdf: Uint8Array): number {
  const s = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString("latin1");
  let max = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    max = Math.max(max, Number(m[1] ?? m[2]));
  }
  if (max > 0) return max;
  return (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/** Metrik tata letak HTML untuk lint R (S45). Lihat `MeasuredKind` untuk isi elemen. */
export async function measureLayout(html: string, opts: MeasureOptions = {}): Promise<MeasuredLayout> {
  const op = "measureLayout";
  assertSize(op, html, BROWSER_MAX_HTML_BYTES);
  const pageWidthMm = assertMm(op, "pageWidthMm", opts.pageWidthMm ?? 210);
  const pageHeightMm = assertMm(op, "pageHeightMm", opts.pageHeightMm ?? 297);
  const viewportWidthPx = Math.round(opts.viewportWidthPx ?? Math.ceil(pageWidthMm * PX_PER_MM));
  if (!(viewportWidthPx >= 100 && viewportWidthPx <= BROWSER_MAX_BITMAP_PX)) fail(op, "viewportWidthPx out of range");
  const maxElements = Math.min(Math.max(1, Math.trunc(opts.maxElements ?? 20000)), BROWSER_MAX_MEASURE_ELEMENTS);
  const media = opts.media ?? "screen";
  const viewport = { width: viewportWidthPx, height: Math.ceil(pageHeightMm * PX_PER_MM) };

  return withSandboxedPage(op, { viewport, timeoutMs: opts.timeoutMs }, async ({ page, blocked }) => {
    await page.emulateMedia({ media });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(FONTS_READY_SCRIPT);
    const r = (await page.evaluate(measureExpression({ pageWidthMm, pageHeightMm, maxElements }))) as {
      paged: boolean;
      pageCount: number;
      truncated: boolean;
      elements: MeasuredElement[];
    };
    let pageCount = r.pageCount;
    let pageCountSource: MeasuredLayout["pageCountSource"] = r.paged ? "elements" : "none";
    if (!r.paged && opts.countPrintPages !== false) {
      const pdf = await page.pdf({
        width: `${pageWidthMm}mm`,
        height: `${pageHeightMm}mm`,
        preferCSSPageSize: true,
        printBackground: true,
      });
      pageCount = countPdfPages(pdf);
      pageCountSource = "print";
    }
    return {
      pageCount,
      elements: r.elements,
      paged: r.paged,
      pageCountSource,
      truncated: r.truncated,
      blockedRequests: blocked(),
      viewportWidthPx,
      media,
    };
  });
}

/**
 * Pratinjau HTML sebagai PNG per halaman. Markup ber-`.page`: satu PNG per
 * elemen halaman; dokumen alir: irisan setinggi lembar.
 */
export async function previewHtml(html: string, opts: PreviewOptions = {}): Promise<HtmlPreview> {
  const op = "previewHtml";
  assertSize(op, html, BROWSER_MAX_HTML_BYTES);
  const pageWidthMm = assertMm(op, "pageWidthMm", opts.pageWidthMm ?? 210);
  const pageHeightMm = assertMm(op, "pageHeightMm", opts.pageHeightMm ?? 297);
  const dpi = opts.dpi ?? 96;
  if (typeof dpi !== "number" || !Number.isFinite(dpi) || dpi < 72 || dpi > 300) fail(op, "dpi must be in [72, 300]");
  const maxPages = Math.min(Math.max(1, Math.trunc(opts.maxPages ?? BROWSER_DEFAULT_PREVIEW_MAX_PAGES)), BROWSER_MAX_PREVIEW_PAGES);
  const pagePxW = pageWidthMm * PX_PER_MM;
  const pagePxH = pageHeightMm * PX_PER_MM;
  const scale = dpi / 96;
  if (pagePxW * scale > BROWSER_MAX_BITMAP_PX || pagePxH * scale > BROWSER_MAX_BITMAP_PX) fail(op, "page bitmap too large");
  const viewport = { width: Math.ceil(pagePxW), height: Math.ceil(pagePxH) };

  return withSandboxedPage(op, { viewport, deviceScaleFactor: scale, timeoutMs: opts.timeoutMs }, async ({ page, blocked }) => {
    await page.emulateMedia({ media: opts.media ?? "screen" });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(FONTS_READY_SCRIPT);
    let rects = (await page.evaluate(PAGE_RECTS_SCRIPT)) as Array<{ x: number; y: number; width: number; height: number }>;
    const paged = rects.length > 0;
    if (!paged) {
      const doc = (await page.evaluate(DOC_SIZE_SCRIPT)) as { width: number; height: number };
      const n = Math.max(1, Math.ceil(doc.height / pagePxH - 1e-6));
      rects = Array.from({ length: n }, (_, k) => ({ x: 0, y: k * pagePxH, width: pagePxW, height: pagePxH }));
    }
    const pages: Uint8Array[] = [];
    for (const r of rects.slice(0, maxPages)) {
      if (r.width < 1 || r.height < 1) continue;
      const shot = await page.screenshot({
        type: "png",
        fullPage: true,
        clip: { x: r.x, y: r.y, width: r.width, height: r.height },
        animations: "disabled",
        caret: "hide",
        scale: "device",
      });
      pages.push(withPngDpi(new Uint8Array(shot.buffer, shot.byteOffset, shot.byteLength), dpi));
    }
    return { pageCount: rects.length, pages, truncated: rects.length > maxPages, dpi, paged, blockedRequests: blocked() };
  });
}

/** Tutup instans setelah operasi berjalan selesai. Idempoten. */
export async function closeBrowser(): Promise<void> {
  await shutdownBrowser();
}

/** Identitas modul untuk log pemanggil. */
export const BROWSER_MODULE_ID = MODULE;
