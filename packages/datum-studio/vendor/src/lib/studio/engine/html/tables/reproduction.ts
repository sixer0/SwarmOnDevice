/**
 * Mode reproduksi benchmark untuk blok derivation HTML (IP-26, F-037, D-79).
 *
 * Ekstraksi S93 (`benchmark/manual000/doc.json`, D-44) menyalin turunan BM apa
 * adanya: judul, baris uraian/nilai, dan kalimat penutup berupa `Inline.runs`
 * verbatim (konvensi C1, C8), TANPA `result()`; aritmetikanya sudah tertulis
 * di sumber dan tidak dapat diuji ulang terhadap register. Bentuk itu sah di
 * skema (`result?` opsional) tetapi ditolak `buildDerivationBlock` (S12).
 *
 * Predikat gerbang = SATU sumber `engine/bind` (`isVerbatimReproduction`,
 * IP-31/F-042; penanda hanya tepercaya bila lolos ingest ADMIN/harness).
 * Gerbang (keduanya wajib; selain itu jalur terverifikasi biasa berlaku dan
 * turunan tanpa `result()` tetap DITOLAK `BY_CONSTRUCTION_FAILED`):
 * 1. Dokumen bertanda benchmark: `doc.x.benchmark === true` atau objek
 *    (penanda yang sama dengan aturan pengaman D-34 ingest `isBenchmarkDoc`,
 *    tanpa cabang `x.enforcement`, yang hanya mengatur lint).
 * 2. Blok berbentuk verbatim murni: tanpa `result`, tanpa `verdict`, setiap
 *    nilai baris berupa Inline (bukan `registerKey`), `title` dan `closing`
 *    berisi teks. Turunan yang merujuk register selalu dibangun ulang dan
 *    diperiksa, juga di dokumen benchmark.
 *
 * Tata letak mengikuti C8 (renderer `nestedTable` BM): judul, [intro], tabel
 * baris (uraian | nilai + glif tanda), penutup. Run ditulis apa adanya (C1),
 * tanpa label/prefiks tambahan; format eksplisit menang atas peran (C12).
 */
import type { DerivationBlock, Inline, NormBlock, ParaFormat, ProvenanceMark, RenderContext, RunProps } from "../../../contract";
import { hasBenchmarkMarker, isVerbatimDerivation } from "../../bind";
import { attr, escText } from "./escape";
import { inlineHtml, inlinePlain, paraHtml } from "./inline";
import { color, css, markColor, markGlyph, n, pNum, role, ruleCss, runCss } from "./style";

/** Kode log (bukan StudioErrorCode) saat turunan dirender verbatim. */
export const RENDER_DERIVATION_VERBATIM = "RENDER_DERIVATION_VERBATIM";

/** Kolom nilai = lebar rel bukti BM (N01/N02: 1814 tw = 32 mm), padanan DOCX S19. */
const VALUE_COL_MM = 32;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * true bila dokumen membawa penanda benchmark `x.benchmark` (true atau objek).
 * Delegasi ke predikat satu sumber `engine/bind` (IP-31); ekspor dipertahankan
 * untuk kompatibilitas `engine/html/tables/index.ts`.
 */
export function isBenchmarkReproduction(ctx: Pick<RenderContext, "snapshot">): boolean {
  return hasBenchmarkMarker(ctx.snapshot?.doc);
}

/** Predikat bentuk verbatim murni (satu sumber: `engine/bind/reproduction.ts`). */
export { isVerbatimDerivation };

function isInline(v: unknown): v is Inline {
  if (!isRecord(v)) return false;
  return Array.isArray(v.runs) || typeof v.text === "string";
}

function hasText(x: unknown): boolean {
  return isInline(x) && inlinePlain(x).trim().length > 0;
}

/** Format paragraf medan Inline-only: `fieldFormats` kontrak (G-06), lalu jejak S93 `x.<medan>Format`. */
function fieldFormat(d: DerivationBlock, field: "title" | "intro" | "closing"): ParaFormat | undefined {
  const ff = d.fieldFormats as Record<string, ParaFormat | undefined> | undefined;
  if (ff && isRecord(ff[field])) return ff[field];
  const x = d.x;
  const v = isRecord(x) ? x[`${field}Format`] : undefined;
  return isRecord(v) ? (v as ParaFormat) : undefined;
}

/** Glif tanda saja (C8: run glif `mark` sesudah nilai), tanpa nama tanda. */
function glyphHtml(mark: ProvenanceMark | undefined, ctx: RenderContext, base: RunProps): string {
  if (!mark) return "";
  const p = ctx.tpl.params;
  const glyphRun: RunProps = { szHalfPt: base.szHalfPt, faceRole: "symbolGlyph", ...(role(ctx, "rail.mark").glyphRun?.[mark] ?? {}) };
  const style = css(runCss(glyphRun, p), glyphRun.color ? undefined : `color:${markColor(ctx.tpl, mark)}`, "font-style:normal");
  return `<span class="st-mark" data-mark="${escText(mark)}" style="${escText(style)}">${escText(markGlyph(p, mark))}</span>`;
}

/** Perender verbatim (dipanggil `renderDerivationBlock` setelah kedua gerbang lolos). */
export function renderVerbatimDerivation(block: NormBlock, d: DerivationBlock, ctx: RenderContext): string {
  const p = ctx.tpl.params;
  const id = d.id ?? block.artifactLabel ?? ctx.snapshot?.numbering?.[block.blockId] ?? "";
  ctx.log({
    level: "info",
    message: `engine/html/tables: derivation ${id || block.blockId} dirender verbatim (mode reproduksi benchmark, tanpa result())`,
    code: RENDER_DERIVATION_VERBATIM,
    address: block.address ?? undefined,
  });

  const labelRf = role(ctx, "derivation.label");
  const introRf = role(ctx, "derivation.intro");
  const exprRf = role(ctx, "derivation.expr");
  const valRf = role(ctx, "derivation.value");
  const runBase = d.runDefaults ?? {};

  const title = paraHtml(
    inlineHtml(d.title, { ...(labelRf.run ?? labelRf.labelRun ?? {}), ...runBase }, p),
    fieldFormat(d, "title") ?? labelRf.para,
    "break-after:avoid",
    "st-derivation-label",
  );
  const intro = d.intro && hasText(d.intro) ? paraHtml(inlineHtml(d.intro, { ...(introRf.run ?? {}), ...runBase }, p), fieldFormat(d, "intro") ?? introRf.para, "break-after:avoid", "st-derivation-intro") : "";

  const hair = ruleCss(pNum(p, "rules.hairMm", 0.2), color(ctx.tpl, "rules.hair.colour", "ink200"));
  const exprRun: RunProps = { faceRole: "mono", ...(exprRf.run ?? {}) };
  const valRun: RunProps = { faceRole: "mono", ...(valRf.run ?? {}) };
  const td = (extra?: string): string => css("padding:0.8mm 2.5mm 0.8mm 0", "vertical-align:top", extra);
  const rows = d.lines.map((ln, i) => {
    const top = i === 0 ? "" : `border-top:${hair}`;
    const label = paraHtml(inlineHtml(ln.label, exprRun, p), exprRf.para);
    const valueInner = (isInline(ln.value) ? inlineHtml(ln.value, valRun, p) : "") + glyphHtml(ln.mark, ctx, valRun);
    const value = paraHtml(valueInner, valRf.para, "text-align:right;white-space:pre");
    return (
      `<tr class="st-derivation-line" style="break-inside:avoid">` +
      `<td style="${escText(td(top))}">${label}</td>` +
      `<td style="${escText(td(css(top, "white-space:nowrap")))}">${value}</td></tr>`
    );
  });
  const table =
    rows.length > 0
      ? `<table class="st-derivation-table" style="border-collapse:collapse;border-spacing:0;width:100%"><colgroup><col><col style="width:${VALUE_COL_MM}mm"></colgroup><tbody>${rows.join("")}</tbody></table>`
      : "";

  const closing = paraHtml(
    inlineHtml(d.closing, { ...(introRf.run ?? {}), ...runBase }, p),
    fieldFormat(d, "closing") ?? introRf.para,
    undefined,
    "st-derivation-note",
  );

  const left = ruleCss(pNum(p, "rules.derivationLeftMm", 0.45), color(ctx.tpl, "rules.derivationLeft.colour", "signal"));
  const f = d.format;
  const wrap = css(
    `border-left:${left}`,
    "padding-left:4.5mm",
    `margin:${n(f?.spacingBeforeTw !== undefined ? f.spacingBeforeTw / 20 : 8)}pt 0 ${n(f?.spacingAfterTw !== undefined ? f.spacingAfterTw / 20 : 4)}pt 0`,
    "break-inside:avoid",
  );
  const attrs =
    (block.address ? attr("data-address", block.address) : "") +
    (block.blockId ? attr("data-block-id", block.blockId) : "") +
    attr("data-block-type", "derivation") +
    (id ? attr("data-derivation-id", id) : "") +
    attr("data-renderer", "verbatim") +
    attr("data-reproduction", "benchmark");
  return `<div class="st-derivation"${attrs} style="${escText(wrap)}">${title}${intro}${table}${closing}</div>`;
}
