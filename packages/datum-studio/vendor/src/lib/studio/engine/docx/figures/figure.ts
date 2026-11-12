/**
 * Renderer DOCX blok figur `chart`, `diagram`, `image`, `symbolSheet` (S19).
 *
 * Urutan paragraf (BM research/07 §3 dan §7; DT-15 caption di atas, SUMBER di
 * bawah):
 *   1. caption (K-29): run label "Gambar n.m" + pemisah, lalu satu kalimat
 *   2. paragraf gambar (K-32): `wp:inline` berukuran mm tepat, spasi baris
 *      auto (melepas spasi tepat badan, P9-51) + keepNext
 *      (symbolSheet/diagram berlembar banyak: satu paragraf per lembar)
 *   3. baris KUNCI opsional (K-33)
 *   4. baris SUMBER + PROVENANS (K-34, border atas ink200)
 *
 * Sumber bitmap:
 *   - chart/diagram/symbolSheet: PNG 300 dpi dari `ctx.figures` (diisi
 *     `prepareFigureStore` lewat layanan browser S25 sebelum perakitan);
 *   - image: `ctx.figures` bila ada, selain itu aset raster bersha256.
 * Media dideduplikasi menurut sha256 dengan nama part deterministik.
 */
import type {
  BorderSpec,
  Caption,
  ChartBlock,
  DiagramBlock,
  DocxBlockRenderer,
  DocxFragment,
  FigureCommon,
  ImageBlock,
  Inline,
  NormBlock,
  ParaFormat,
  ParamMap,
  ProvenanceMark,
  RenderContext,
  Run,
  RunProps,
  SourceLine,
  SymbolSheetBlock,
} from "../../../contract";
import { facesInXml, hfRunXml, inlinePlain, runOwnProps } from "../package/xml";
import {
  DEFAULT_CAPTION_SEPARATOR,
  FIGURE_LABELS,
  FIGURE_LABEL_SPACING,
  defaultGlyphRun,
  figureLabels,
  figureRole,
  markGlyph,
  mergePara,
  mergeRun,
} from "./defaults";
import { type FigureAltInput, figureAltText, stripSourceLabel } from "../../front/alt-text";
import { apparatusLabelRunText, artifactLabelText, provenanceMarkLabelText, type WrapperLang, wrapperLangOf } from "../../front/texts";
import { FIGURE_PREPARE_FAILED, type FigurePrepareFailure, failRender, figurePrepareFailureOf, warnRender } from "./log";
import { type FigureImage, type FigureMediaEntry, addMedia, figureImageFromBytes, figureMediaRelId, resolveRasterAsset } from "./media";
import { DOCPR_ID_BASE, drawingParagraphXml, inlineRunsXml, paragraphXml, textRun } from "./ooxml";
import { RASTER_DPI_FLOOR, classDerivedWidth, rasterPlacedWidthMm } from "../../tokens/raster-width";
import { mmToTw } from "../../tokens";
import { type ParaAdjust, apparatusParaAdjust } from "../blocks/apparatus";
import { baselineSnapTw, snapDrawingPara } from "../blocks/rhythm";

/** Penyesuai format paragraf apparatus figur (C20 kolom rel tercadang, C19 garis dasar; `blocks/apparatus.ts`). */
export type { ParaAdjust } from "../blocks/apparatus";

function adjusted(para: ParaFormat | undefined, adjust: ParaAdjust | undefined): ParaFormat | undefined {
  return adjust ? adjust(para ?? {}) : para;
}

export type FigureBlockType = "chart" | "diagram" | "image" | "symbolSheet";
type FigureBlock = ChartBlock | DiagramBlock | ImageBlock | SymbolSheetBlock;

/**
 * Lebar figur sah TURUNAN (D-158/D-245 H1): `grid.allowedFigureWidthsMm` efektif
 * (kolom teks, bentang penuh; A4 = 128/166). Aset raster boleh selain ini.
 */
const FIGURE_WIDTHS_PARAM = "grid.allowedFigureWidthsMm";
/** DATUM-33: tinggi figur <= `diagram.maxHeightMm` (P9-45) / blok teks turunan `grid.textBlockHeightMm` (A4 247). */
const MAX_HEIGHT_PARAMS = ["diagram.maxHeightMm", "grid.textBlockHeightMm"] as const;
/** Toleransi keanggotaan lebar sah (mm). */
const WIDTH_TOLERANCE_MM = 0.005;
/** DATUM-39: dpi efektif minimum aset raster (= batas bawah R-65 `image.rasterDpi`, 150). */
const MIN_RASTER_DPI = RASTER_DPI_FLOOR;
/** Batas jumlah lembar per blok (penjaga loop `#n`). */
const MAX_SHEETS = 64;

function paramNum(p: ParamMap, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Lebar figur sah efektif; absen/tidak sah = BY_CONSTRUCTION_FAILED (tanpa cadangan literal A4). */
function allowedFigureWidths(block: NormBlock, ctx: RenderContext): number[] {
  const v = ctx.tpl.params[FIGURE_WIDTHS_PARAM];
  const out = Array.isArray(v) ? v.filter((w): w is number => typeof w === "number" && Number.isFinite(w) && w > 0) : [];
  if (out.length === 0 || (Array.isArray(v) && out.length !== v.length)) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `Lebar figur sah tidak terbaca: ${FIGURE_WIDTHS_PARAM} wajib ada di parameter templat`, block.address ?? undefined, {
      key: FIGURE_WIDTHS_PARAM,
    });
  }
  return out;
}

/** Tinggi figur maksimum efektif; absen = BY_CONSTRUCTION_FAILED (tanpa cadangan literal 247). */
function maxFigureHeight(block: NormBlock, ctx: RenderContext): number {
  for (const key of MAX_HEIGHT_PARAMS) {
    const v = paramNum(ctx.tpl.params, key);
    if (v !== undefined && v > 0) return v;
  }
  return failRender(ctx, "BY_CONSTRUCTION_FAILED", `Tinggi figur maksimum tidak terbaca: ${MAX_HEIGHT_PARAMS.join(" / ")} wajib ada di parameter templat`, block.address ?? undefined, {
    keys: [...MAX_HEIGHT_PARAMS],
  });
}

function mmList(ws: readonly number[]): string {
  return ws.map((w) => String(Math.round(w * 100) / 100)).join("/");
}

function paramStr(p: ParamMap, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

/** Kunci pencarian FigureStore untuk blok: label artefak, penomoran, blockId, alamat. */
export function figureStoreKeys(block: NormBlock, numbering: Readonly<Record<string, string>>): string[] {
  const keys = [block.artifactLabel, numbering[block.blockId], block.blockId, block.address ?? undefined];
  return [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
}

/** Kunci lembar ke-n (n >= 2) satu figur: `<kunci>#<n>`. */
export function sheetKey(key: string, n: number): string {
  return n <= 1 ? key : `${key}#${n}`;
}

function asFigureBlock(block: NormBlock, type: FigureBlockType, ctx: RenderContext): FigureBlock {
  const c = block.content as Partial<FigureBlock> | null;
  if (!c || typeof c !== "object" || c.type !== type || !c.caption || !c.source || typeof c.widthMm !== "number") {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `Blok ${block.blockId} bukan blok ${type} yang lengkap (caption, source, widthMm)`, block.address ?? undefined);
  }
  return c as FigureBlock;
}

// ── Caption, KUNCI, SUMBER ───────────────────────────────────────────────

function captionLabel(block: NormBlock, cap: Caption, ctx: RenderContext): string {
  const numbered = block.artifactLabel ?? ctx.snapshot.numbering[block.blockId];
  if (cap.label && numbered && cap.label !== numbered) {
    warnRender(ctx, "caption.label", `Label caption "${cap.label}" berbeda dari hasil penomoran "${numbered}"`, block.address ?? undefined);
  }
  const label = cap.label ?? numbered;
  if (!label) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `Figur ${block.blockId} tanpa label caption (penomoran belum dijalankan)`, block.address ?? undefined);
  }
  return label;
}

/** DT-15 / P5-19: caption satu kalimat. Hanya dicatat; lint 30 yang memutuskan. */
function checkOneSentence(text: string, block: NormBlock, ctx: RenderContext): void {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .filter((s) => s.trim().length > 0);
  if (sentences.length > 1) {
    warnRender(ctx, "DT-15", `Caption ${block.blockId} memuat ${sentences.length} kalimat; DT-15 meminta satu`, block.address ?? undefined);
  }
}

/** Bahasa label aparatus = bahasa dokumen (S13/F-2). */
function langOf(ctx: RenderContext): WrapperLang {
  return wrapperLangOf(ctx.snapshot?.doc?.meta);
}

export function captionXml(block: NormBlock, cap: Caption, ctx: RenderContext, runDefaults?: RunProps, adjust?: ParaAdjust): string {
  const p = ctx.tpl.params;
  const role = figureRole(ctx.tpl, "caption");
  // D-3: tampilan label berbahasa dokumen; alamat/penomoran tetap ("Gambar n.m").
  const label = artifactLabelText(captionLabel(block, cap, ctx), langOf(ctx));
  const sep = cap.separator ?? paramStr(p, "render.caption.separator") ?? DEFAULT_CAPTION_SEPARATOR;
  checkOneSentence(inlinePlain(cap.inline), block, ctx);
  const runs =
    // Row 122 (C40 FIX CP-28, DT-15 ID p.41): the label is always bold capitals (role or labelProps cannot turn it off).
    textRun(label + sep, { ...mergeRun(role.labelRun, cap.labelProps), b: true, caps: true }, p) +
    inlineRunsXml(cap.inline, mergeRun(role.run, runDefaults), p);
  return paragraphXml(adjusted(mergePara(role.para, cap.format), adjust), runs);
}

/**
 * Label yang dikenali di teks penulis: label ID; dokumen berbahasa lain juga label bahasanya
 * (S13/F-2). Dokumen ID hanya mengenali label ID (perilaku sebelum S13).
 */
function knownLabels(pick: (l: typeof FIGURE_LABELS) => string, lang: WrapperLang): string[] {
  return lang === "ID" ? [pick(FIGURE_LABELS)] : [pick(FIGURE_LABELS), pick(figureLabels(lang))];
}

/** Buang label awal yang sudah ditulis penulis ("KUNCI ...", "SUMBER ..."). */
function stripLeadingLabel(text: string, labels: readonly string[]): string {
  const re = new RegExp(`^\\s*(?:${labels.join("|")})\\b[\\s:]*`);
  return text.replace(re, "");
}

/** Run label aparatus figur di bentuk `runs`: teks hanya "KUNCI", "SUMBER" atau "PROVENANS" (+ spasi/titik dua). */
function labelRunRe(lang: WrapperLang): RegExp {
  const words = [...knownLabels((l) => l.key, lang), ...knownLabels((l) => l.source, lang), ...knownLabels((l) => l.provenance, lang)];
  return new RegExp(`^\\s*(?:${words.join("|")})\\s*:?\\s*$`);
}

function isLabelRun(r: Run, re: RegExp): boolean {
  return "t" in r && re.test(r.t);
}

/**
 * Inline aparatus (KUNCI/SUMBER) berbentuk `runs` (RQ-3, permintaan RT-01):
 * run label ("KUNCI  ", "SUMBER  ", "   PROVENANS ") memakai `labelRun` peran
 * (spacingTw 12 dari templat), run lain memakai `run` peran. Properti milik run
 * tetap menang (dokumen verbatim membawa format lengkap, keluaran tidak
 * berubah); face XOR faceRole lewat `mergeRun`.
 */
function apparatusRunsXml(i: Inline, base: RunProps, label: RunProps, p: ParamMap, lang: WrapperLang): string {
  if (!("runs" in i)) return inlineRunsXml(i, base, p);
  const re = labelRunRe(lang);
  return (i.runs as readonly Run[])
    .map((r) => (isLabelRun(r, re) ? textRun(apparatusLabelRunText((r as { t: string }).t, lang), mergeRun(label, runOwnProps(r)), p) : hfRunXml(r, base, p)))
    .join("");
}

export function keyRowXml(keyRow: FigureCommon["keyRow"], ctx: RenderContext, runDefaults?: RunProps, adjust?: ParaAdjust): string {
  if (!keyRow) return "";
  const p = ctx.tpl.params;
  const role = figureRole(ctx.tpl, "figure.keyRow");
  const base = mergeRun(role.run, runDefaults);
  // C1 (D-44): bentuk `runs` lengkap, label "KUNCI  " disediakan penulis (sama dengan
  // baris SUMBER berbentuk runs) dan memakai `labelRun` peran (RQ-3); label hanya
  // ditambahkan untuk `text`.
  const lang = langOf(ctx);
  const para = adjusted(role.para, adjust);
  if (!("text" in keyRow)) return paragraphXml(para, apparatusRunsXml(keyRow, base, mergeRun(role.labelRun), p, lang));
  const labelXml = textRun(figureLabels(lang).key + FIGURE_LABEL_SPACING.keyAfter, mergeRun(role.labelRun), p);
  return paragraphXml(para, labelXml + textRun(stripLeadingLabel(inlinePlain(keyRow), knownLabels((l) => l.key, lang)), base, p));
}

function provenanceMarksXml(marks: readonly ProvenanceMark[], ctx: RenderContext, base: RunProps): string {
  const p = ctx.tpl.params;
  const role = figureRole(ctx.tpl, "figure.source");
  return marks
    .map((m, i) => {
      const glyphProps = mergeRun(base, defaultGlyphRun(ctx.tpl), role.glyphRun?.[m]);
      return (i > 0 ? textRun(" · ", base, p) : "") + textRun(markGlyph(p, m), glyphProps, p) + textRun(` ${provenanceMarkLabelText(m, langOf(ctx))}`, base, p);
    })
    .join("");
}

/**
 * Baris SUMBER: `"SUMBER  " + teks [+ "   PROVENANS " + teks]`. Teks polos
 * dipecah pada kata PROVENANS (label tebal); `provenance[]` ditulis sebagai
 * glif + nama tanda bila teks belum memuat segmen PROVENANS. Bentuk `runs`:
 * label disediakan penulis, run label memakai `labelRun` peran (RQ-3).
 */
export function sourceLineXml(src: SourceLine, ctx: RenderContext, address: string | undefined, runDefaults?: RunProps, adjust?: ParaAdjust): string {
  const p = ctx.tpl.params;
  const role = figureRole(ctx.tpl, "figure.source");
  const label = mergeRun(role.labelRun);
  const base = mergeRun(role.run, runDefaults);
  const para = adjusted(mergePara(role.para, src.format), adjust);
  const lang = langOf(ctx);
  const L = figureLabels(lang);
  const provenanceWords = knownLabels((l) => l.provenance, lang);
  if ("runs" in src.inline) {
    let xml = apparatusRunsXml(src.inline, base, label, p, lang);
    const plain = inlinePlain(src.inline);
    if (src.provenance?.length && !provenanceWords.some((w) => plain.includes(w))) {
      xml += textRun(FIGURE_LABEL_SPACING.provenanceBefore + L.provenance + FIGURE_LABEL_SPACING.provenanceAfter, label, p);
      xml += provenanceMarksXml(src.provenance, ctx, base);
    }
    return paragraphXml(para, xml);
  }
  const text = stripLeadingLabel(inlinePlain(src.inline), knownLabels((l) => l.source, lang));
  if (text.trim().length === 0) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", "Baris SUMBER figur kosong (DT-15, lint 29)", address);
  }
  const segments = text.split(new RegExp(`\\s*\\b(?:${provenanceWords.join("|")})\\b\\s*`));
  let xml = textRun(L.source + FIGURE_LABEL_SPACING.sourceAfter, label, p) + textRun(segments[0], base, p);
  for (const seg of segments.slice(1)) {
    xml += textRun(FIGURE_LABEL_SPACING.provenanceBefore + L.provenance + FIGURE_LABEL_SPACING.provenanceAfter, label, p);
    xml += textRun(seg, base, p);
  }
  if (segments.length === 1 && src.provenance?.length) {
    xml += textRun(FIGURE_LABEL_SPACING.provenanceBefore + L.provenance + FIGURE_LABEL_SPACING.provenanceAfter, label, p);
    xml += provenanceMarksXml(src.provenance, ctx, base);
  } else if (segments.length === 1 && p["source.provenanceField.required"] !== false) {
    warnRender(ctx, "P5-23", "Baris SUMBER figur tanpa medan PROVENANS", address);
  }
  return paragraphXml(para, xml);
}

// ── Bitmap ───────────────────────────────────────────────────────────────

interface Sheet {
  img: FigureImage;
  widthMm: number;
  heightMm: number;
}

function placedHeight(block: FigureBlock, widthMm: number, storeW: number | undefined, storeH: number | undefined, img: FigureImage, sheetIndex: number): number {
  if (block.heightMm !== undefined && sheetIndex === 0) return (block.heightMm * widthMm) / block.widthMm;
  if (storeW && storeH && storeW > 0) return (storeH * widthMm) / storeW;
  return (img.heightPx * widthMm) / img.widthPx;
}

/**
 * Lebar tempatan satu lembar. Gambar raster pada snapshot v2 (lebar dari kelas
 * templat): aturan ukuran asli K-2 (D-242, `engine/tokens/raster-width`) — tidak diperbesar
 * melewati lebar aslinya pada resolusi templat; lebar kelas = batas atas. Figur
 * vektor (chart/diagram/symbolSheet) digambar mesin tepat selebar blok (D-245 H1).
 */
function placedWidth(fb: FigureBlock, img: FigureImage, ctx: RenderContext): number {
  if (fb.type !== "image" || !classDerivedWidth(ctx.snapshot)) return fb.widthMm;
  return rasterPlacedWidthMm(fb.widthMm, img.widthPx, ctx.tpl.params);
}

/** Ambil lembar PNG dari FigureStore (kunci figur, lalu `#2`, `#3`, ...). */
function sheetsFromStore(block: NormBlock, fb: FigureBlock, ctx: RenderContext): Sheet[] {
  const address = block.address ?? undefined;
  for (const key of figureStoreKeys(block, ctx.snapshot.numbering)) {
    const first = ctx.figures.get(key);
    if (!first) continue;
    const out: Sheet[] = [];
    for (let n = 1; n <= MAX_SHEETS; n++) {
      const e = n === 1 ? first : ctx.figures.get(sheetKey(key, n));
      if (!e) break;
      if (!e.png) {
        failRender(ctx, "BY_CONSTRUCTION_FAILED", `Figur "${key}" lembar ${n} belum dirasterisasi ke PNG (jalankan prepareFigureStore)`, address);
      }
      const img = figureImageFromBytes(e.png, ctx, address, `Figur "${key}" lembar ${n}`);
      const widthMm = placedWidth(fb, img, ctx);
      out.push({ img, widthMm, heightMm: placedHeight(fb, widthMm, e.widthMm, e.heightMm, img, n - 1) });
    }
    return out;
  }
  return [];
}

/**
 * Swarm 1.2.6 (row 68, T-15, register N-036): penanda FIGURE_PREPARE_FAILED dari `prepareFigureStore` untuk blok ini
 * (kunci pertama yang ada di FigureStore menang, sama dengan `sheetsFromStore`). undefined = tidak ada penanda.
 */
function prepareFailureOf(block: NormBlock, ctx: RenderContext): FigurePrepareFailure | undefined {
  for (const key of figureStoreKeys(block, ctx.snapshot.numbering)) {
    const e = ctx.figures.get(key);
    if (e) return figurePrepareFailureOf(e);
  }
  return undefined;
}

/** Bingkai placeholder: sama dengan penanda draf DOCX (`blocks/source-register.ts`, 0.5pt dashed #B45309). */
const PREPARE_FAILED_SIDE: BorderSpec = { val: "dashed", sz: 4, color: "B45309", space: 4 };

/**
 * T-15: paragraf placeholder yang terlihat untuk figur yang gagal disiapkan, di tempat gambar. Teksnya memuat penanda
 * `FIGURE_PREPARE_FAILED` dan label figur; bingkai putus-putus #B45309 membuat pemindai placeholder verifikasi DOCX
 * (PLACEHOLDER_IN_OUTPUT) menolak keluaran ini sehingga tidak pernah hijau.
 */
function prepareFailedParagraphXml(block: NormBlock, fb: FigureBlock, ctx: RenderContext, label: string, format: ParaFormat | undefined, failure: FigurePrepareFailure): string {
  const lang = langOf(ctx);
  const name = artifactLabelText(label, lang) || `${fb.type} ${block.blockId}`;
  const cause = failure.causeCode ? ` (${failure.causeCode})` : "";
  const text =
    lang === "ID"
      ? `${FIGURE_PREPARE_FAILED}: ${name} gagal disiapkan${cause}; grafik tidak dicetak`
      : `${FIGURE_PREPARE_FAILED}: ${name} could not be prepared${cause}; the graphic is not printed`;
  const side = PREPARE_FAILED_SIDE;
  const para: ParaFormat = { ...(format ?? {}), borders: { top: side, left: side, bottom: side, right: side } };
  warnRender(ctx, FIGURE_PREPARE_FAILED, `figur ${name} dicetak sebagai placeholder: ${failure.message}`, block.address ?? undefined);
  return paragraphXml(para, textRun(text, mergeRun(figureRole(ctx.tpl, "caption").run, { i: true, color: "B45309" }), ctx.tpl.params));
}

function figureSheets(block: NormBlock, fb: FigureBlock, ctx: RenderContext): Sheet[] {
  const fromStore = sheetsFromStore(block, fb, ctx);
  if (fromStore.length > 0) return fromStore;
  if (fb.type === "image") {
    const img = resolveRasterAsset(fb.asset, ctx, block.address ?? undefined);
    const widthMm = placedWidth(fb, img, ctx);
    return [{ img, widthMm, heightMm: placedHeight(fb, widthMm, undefined, undefined, img, 0) }];
  }
  failRender(
    ctx,
    "BY_CONSTRUCTION_FAILED",
    `Figur ${fb.type} ${block.blockId} tidak ada di FigureStore (kunci: ${figureStoreKeys(block, ctx.snapshot.numbering).join(", ")})`,
    block.address ?? undefined,
  );
}

/** dpi efektif dari piksel nyata terhadap lebar tempatan (mm). */
export function effectiveDpi(widthPx: number, widthMm: number): number {
  return widthPx / (widthMm / 25.4);
}

/**
 * DATUM-39 (F-043, D-94): `true` bila raster benar-benar kurang resolusi.
 * Rasterisasi Node (engine/browser, aturan acuan `raster.py`) memotong klip ke
 * px CSS bulat lalu menskalakan dpi/96, sehingga PNG kehilangan < 1 px CSS
 * (= minDpi/96 px perangkat, ditambah 1 px pembulatan) — mis. 24 mm = 281 px
 * (297,4 dpi), 128 mm = 1509 px (299,4 dpi). Lolos bila kekurangan piksel
 * dalam toleransi itu ATAU dpi efektif >= 99 % minimum (ambang lama, 297 dpi
 * untuk 300); selain itu peringatan.
 */
export function rasterDpiShortfall(widthPx: number, widthMm: number, minDpi: number): boolean {
  if (!(widthPx > 0) || !(widthMm > 0) || !(minDpi > 0)) return false;
  if (effectiveDpi(widthPx, widthMm) >= minDpi * 0.99) return false;
  const idealPx = (widthMm / 25.4) * minDpi;
  return idealPx - widthPx > minDpi / 96 + 1;
}

function guardSheet(block: NormBlock, fb: FigureBlock, s: Sheet, ctx: RenderContext): void {
  const address = block.address ?? undefined;
  if (!(s.widthMm > 0) || !(s.heightMm > 0) || !Number.isFinite(s.heightMm)) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `Ukuran figur ${block.blockId} tidak sah: ${s.widthMm} x ${s.heightMm} mm`, address);
  }
  if (fb.type !== "image") {
    const allowed = allowedFigureWidths(block, ctx);
    if (!allowed.some((w) => Math.abs(fb.widthMm - w) <= WIDTH_TOLERANCE_MM)) {
      warnRender(ctx, "DATUM-31", `Lebar ${fb.type} ${fb.widthMm} mm bukan ${mmList(allowed)} mm`, address);
    }
  }
  const maxH = maxFigureHeight(block, ctx);
  if (s.heightMm > maxH) {
    warnRender(ctx, "DATUM-33", `Tinggi figur ${s.heightMm.toFixed(2)} mm melebihi blok teks ${maxH} mm`, address);
  }
  const minDpi =
    fb.type === "image" ? MIN_RASTER_DPI : (paramNum(ctx.tpl.params, "chart.output.rasterDpiForWord") ?? paramNum(ctx.tpl.params, "render.png.dpi") ?? 300);
  if (rasterDpiShortfall(s.img.widthPx, s.widthMm, minDpi)) {
    const dpi = effectiveDpi(s.img.widthPx, s.widthMm);
    warnRender(ctx, "DATUM-39", `dpi efektif ${dpi.toFixed(1)} < ${minDpi} (${s.img.widthPx} px pada ${s.widthMm} mm)`, address);
  }
}

function fileNameFor(block: NormBlock, fb: FigureBlock, ctx: RenderContext, label: string, ext: string, n: number): string {
  if (fb.type === "image") {
    const ref = ctx.snapshot.doc.assets?.[fb.asset];
    const base = ref?.path?.split(/[\\/]/).pop();
    if (base && n === 0) return base;
  }
  return `${label}${n > 0 ? ` ${n + 1}` : ""}.${ext}`;
}

/** Masukan teks alternatif figur (FIX-H8): label, caption, sumber polos, bahasa, petunjuk jenis. */
function figureAltInput(fb: FigureBlock, ctx: RenderContext, label: string): FigureAltInput {
  let kindHint: string | undefined;
  if (fb.type === "chart" && fb.spec && "kind" in fb.spec && typeof fb.spec.kind === "string") kindHint = fb.spec.kind;
  else if (fb.type === "symbolSheet") kindHint = fb.dialect;
  else if (fb.type === "image") kindHint = ctx.snapshot.doc.assets?.[fb.asset]?.path;
  return {
    type: fb.type,
    label,
    caption: inlinePlain(fb.caption.inline),
    source: stripSourceLabel(inlinePlain(fb.source.inline)),
    language: ctx.snapshot.doc.meta?.language,
    kindHint,
  };
}

// ── Renderer ─────────────────────────────────────────────────────────────

/**
 * Apparatus figur (caption, KUNCI, SUMBER), opt-in mati = undefined:
 * C20 (R-75) selebar kolom teks atau lebih sempit ikut badan 128 mm bila kolom rel dicadangkan,
 * figur bentang penuh tidak diubah; C19 (R-74) jarak dikunci ke garis dasar, leading caption/KUNCI/SUMBER tetap
 * (GF-21 (a), `snapApparatusPara`).
 */
function apparatusAdjust(block: NormBlock, ctx: RenderContext, sheets: ReadonlyArray<Pick<Sheet, "widthMm">>): ParaAdjust | undefined {
  const p = ctx.tpl.params;
  const kind = ctx.snapshot.units.find((u) => u.key === block.unitKey)?.kind;
  const widthTw = Math.max(0, ...sheets.map((s) => mmToTw(s.widthMm)));
  return apparatusParaAdjust((k) => p[k], kind, widthTw);
}

function renderFigure(type: FigureBlockType): DocxBlockRenderer {
  return (block: NormBlock, ctx: RenderContext): DocxFragment => {
    const fb = asFigureBlock(block, type, ctx);
    const role = figureRole(ctx.tpl, "figure.paragraph");
    const label = captionLabel(block, fb.caption, ctx);
    const media: FigureMediaEntry[] = [];
    const paraFormat = mergePara(role.para, fb.format, fb.paragraphFormat);
    // T-15 (row 68): figur yang gagal disiapkan -> caption, placeholder berpenanda, KUNCI, SUMBER; tanpa media.
    const failure = prepareFailureOf(block, ctx);
    if (failure) {
      const adjust = apparatusAdjust(block, ctx, [{ widthMm: fb.widthMm }]);
      const xml =
        captionXml(block, fb.caption, ctx, fb.runDefaults, adjust) +
        prepareFailedParagraphXml(block, fb, ctx, label, paraFormat, failure) +
        keyRowXml(fb.keyRow, ctx, fb.runDefaults, adjust) +
        sourceLineXml(fb.source, ctx, block.address ?? undefined, fb.runDefaults, adjust);
      return { xml, media, facesUsed: facesInXml(xml) };
    }
    const sheets = figureSheets(block, fb, ctx);
    const altBase = figureAltInput(fb, ctx, label);
    const rhythmBase = baselineSnapTw((k) => ctx.tpl.params[k]);

    let pictures = "";
    sheets.forEach((s, i) => {
      guardSheet(block, fb, s, ctx);
      const name = addMedia(media, s.img);
      const docPrId = DOCPR_ID_BASE + block.ordinal * 16 + i;
      // FIX-H8: nama/judul/deskripsi objek dari nomor + caption (+ sumber), bukan "Picture n".
      const alt = figureAltText({ ...altBase, sheet: { index: i + 1, count: sheets.length } });
      // C19 (R-74): tinggi gambar tidak diskalakan; jarak sesudah menutup sisa sampai garis dasar.
      const format = rhythmBase === undefined ? paraFormat : snapDrawingPara(paraFormat, mmToTw(s.heightMm), rhythmBase);
      pictures += drawingParagraphXml(format, {
        relId: figureMediaRelId(name),
        docPrId,
        docPrName: alt.name,
        descr: alt.descr,
        title: alt.title,
        fileName: fileNameFor(block, fb, ctx, label, name.endsWith(".png") ? "png" : "jpg", i),
        widthMm: s.widthMm,
        heightMm: s.heightMm,
      });
    });

    const adjust = apparatusAdjust(block, ctx, sheets);
    const xml =
      captionXml(block, fb.caption, ctx, fb.runDefaults, adjust) +
      pictures +
      keyRowXml(fb.keyRow, ctx, fb.runDefaults, adjust) +
      sourceLineXml(fb.source, ctx, block.address ?? undefined, fb.runDefaults, adjust);
    return { xml, media, facesUsed: facesInXml(xml) };
  };
}

export const renderChartFigure = renderFigure("chart");
export const renderDiagramFigure = renderFigure("diagram");
export const renderImageFigure = renderFigure("image");
export const renderSymbolSheetFigure = renderFigure("symbolSheet");
