/**
 * Perangkat halaman (DeviceBlock, §3.3): pita segel, logo, garis rambut,
 * Datum Rule, string punggung, cap terbit. Padanan HTML perangkat S18.
 * Aset hanya sebagai `data:` URI (D-38); tidak ada URL eksternal.
 */
import type { DeviceBlock, NormBlock, RenderContext, RoleKey } from "../../../contract";
import { assertStudioAssetPath } from "../../../contract/env";
import { StudioEngineError } from "../../../contract/errors";
import { docAssetBytes } from "../../bind";
import { SEAL_BAND_TEXT_HEX, sealBandTextsOf, spineTextOf, wrapperLangOf } from "../../front/texts";
import { DEFAULT_LOGO_WIDTH_MM } from "../../docx/wrapper/media";
import { HTML_BLOCK_CLASSES as C } from "./classes";
import { el, isObj, paramBool, paramNum, reportBad } from "./common";
import { attr, finite, num } from "./escape";
import { inlineHtml } from "./inline";

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(b: Uint8Array, sig: readonly number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

function sniffMime(b: Uint8Array): "image/png" | "image/jpeg" | undefined {
  if (startsWith(b, PNG)) return "image/png";
  if (startsWith(b, JPEG)) return "image/jpeg";
  return undefined;
}

function toBase64(b: Uint8Array): string {
  const g = globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (g.Buffer) return g.Buffer.from(b).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Baca berkas aset templat (server saja); klien tanpa `node:fs` -> undefined. */
function readTemplateAsset(absPath: string): Uint8Array | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.("node:fs") as { readFileSync(p: string): Uint8Array } | undefined;
  // Swarm patch (row 107, row 11 M3): template asset reads stay inside the Studio asset root.
  return fs ? new Uint8Array(fs.readFileSync(assertStudioAssetPath(absPath))) : undefined;
}

/**
 * Data URI raster dari kunci aset: aset dokumen (`ctx.assetBytes` per sha256,
 * lalu dataBase64; sumber tunggal `docAssetBytes`, IP-34) > FigureStore > aset templat.
 */
export function assetDataUri(ctx: RenderContext, key: string, block: NormBlock): string | undefined {
  try {
    const bytes = docAssetBytes(ctx, key, block.address ?? block.blockId)?.bytes;
    const mime = bytes ? sniffMime(bytes) : undefined;
    if (bytes && mime) return `data:${mime};base64,${toBase64(bytes)}`;
    const fig = ctx.figures?.get(key);
    if (fig?.png) {
      const mime = sniffMime(fig.png);
      if (mime) return `data:${mime};base64,${toBase64(fig.png)}`;
    }
    const tplAsset = ctx.tpl?.assets?.[key];
    if (tplAsset && tplAsset.kind === "raster") {
      const bytes = readTemplateAsset(tplAsset.absPath);
      const mime = bytes ? sniffMime(bytes) : undefined;
      if (bytes && mime) return `data:${mime};base64,${toBase64(bytes)}`;
    }
  } catch (e) {
    ctx.log({
      level: "error",
      message: `engine/html/blocks: aset "${key}" gagal dibaca: ${e instanceof Error ? e.message : String(e)}`,
      code: "RENDER_ASSET_UNREADABLE",
      address: block.address ?? block.blockId,
    });
    return undefined;
  }
  ctx.log({
    level: "warn",
    message: `engine/html/blocks: aset raster "${key}" tidak ditemukan atau bukan PNG/JPEG`,
    code: "RENDER_ASSET_MISSING",
    address: block.address ?? block.blockId,
  });
  return undefined;
}

/**
 * Lebar Datum Rule pembungkus turunan (`cover.datumRule.widthMm`, lalu `grid.fullSpanMm`;
 * sama dengan DOCX `datumRuleParagraphXml`); absen = BY_CONSTRUCTION_FAILED (D-245 H1).
 */
function coverDatumRuleWidthMm(ctx: RenderContext, block: NormBlock): number {
  const p = ctx.tpl?.params ?? {};
  for (const key of ["cover.datumRule.widthMm", "grid.fullSpanMm"]) {
    const v = finite(p[key], 1, 1000);
    if (v !== undefined) return v;
  }
  const message = "engine/html/blocks: lebar Datum Rule tidak terbaca: cover.datumRule.widthMm / grid.fullSpanMm wajib ada di parameter templat";
  ctx.log({ level: "error", message, code: "BY_CONSTRUCTION_FAILED", address: block.address ?? block.blockId });
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, { keys: ["cover.datumRule.widthMm", "grid.fullSpanMm"] });
}

/**
 * Atribut gambar aparatus dekoratif (logo sampul; FIX-HZ2, D-326, WCAG 1.1.1):
 * `alt=""` + `role="presentation"` sehingga pembaca layar melewatinya. Padanan
 * DOCX: `wp:docPr descr=""` + `adec:decorative` (`engine/docx/blocks/media`).
 * Gambar isi (figur) memakai alt dari `engine/front/alt-text` (FIX-H8).
 * Ditulis literal karena `attr()` membuang nilai kosong.
 */
export const DECORATIVE_IMG_ATTRS = ' alt="" role="presentation"';

/**
 * Datum Rule sebagai SVG inline (tanpa skrip): garis tebal `weightMm`, segmen
 * depan `frontSegmentMm` tiga kali lebih tebal, `ticks` tik sama jarak.
 */
export function datumRuleSvg(ctx: RenderContext, widthMm: number): string {
  const w = finite(widthMm, 1, 1000);
  if (w === undefined) {
    // D-245 H1: tanpa cadangan literal A4; lebar tidak sah = cacat perakitan.
    const message = `engine/html/blocks: lebar Datum Rule tidak sah (${String(widthMm)} mm)`;
    ctx.log({ level: "error", message, code: "BY_CONSTRUCTION_FAILED" });
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, { widthMm });
  }
  const weight = finite(paramNum(ctx, "device.datumRule.weightMm", 0.2), 0.05, 5) ?? 0.2;
  const front = Math.min(w, finite(paramNum(ctx, "device.datumRule.frontSegmentMm", 9), 0, 1000) ?? 9);
  const ticks = Math.round(finite(paramNum(ctx, "device.datumRule.ticks", 12), 0, 200) ?? 12);
  const tickH = 1.2;
  const h = tickH + weight * 3;
  const y = h - weight * 1.5;
  const parts: string[] = [
    `<line x1="0" y1="${num(y)}" x2="${num(w)}" y2="${num(y)}" stroke="currentColor" stroke-width="${num(weight)}"/>`,
  ];
  if (front > 0) {
    // Row 123 (CP-23): `data-st-lead` marks the lead segment; the shell (`base/shell.ts` `withDatumRuleLeads`) sets its
    // length from the sheet position of the unit that holds the rule (PDF: grows with the page, ID p.53 DT-13f).
    parts.push(`<line data-st-lead="1" x1="0" y1="${num(y)}" x2="${num(front)}" y2="${num(y)}" stroke="currentColor" stroke-width="${num(weight * 3)}"/>`);
  }
  for (let i = 1; i < ticks; i++) {
    const x = (w * i) / ticks;
    parts.push(`<line x1="${num(x)}" y1="${num(y - tickH)}" x2="${num(x)}" y2="${num(y)}" stroke="currentColor" stroke-width="${num(weight)}"/>`);
  }
  return `<svg class="${C.datumRule}" xmlns="http://www.w3.org/2000/svg" width="${num(w)}mm" height="${num(h)}mm" viewBox="0 0 ${num(w)} ${num(h)}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

/** Bungkus Datum Rule dalam paragraf peran (U04 wrapper / U21 bab). */
export function datumRuleHtml(ctx: RenderContext, role: RoleKey, widthMm: number, format?: DeviceBlock["format"]): string {
  if (!paramBool(ctx, "device.datumRule.enabled", true)) return "";
  return el(ctx, "div", { classes: [C.device], role, format, attrs: [["role", "presentation"]] }, datumRuleSvg(ctx, widthMm));
}

/**
 * Teks bawaan pita segel HTML. ID: kiri = klasifikasi, kanan = kendali salinan (P4S-18/19), perilaku
 * pratinjau sejak sebelum ronde ini (research/33 B-07/R-5; HTML ID byte-sama). Bahasa lain (S15):
 * teks bawaan berbahasa dari tabel teks yang sama dengan DOCX (`sealBandTextsOf`: EN bila param =
 * bawaan registri, pasangan templat menang, copyControl menang di kanan).
 */
function sealBandDefaults(ctx: RenderContext): { left?: { text: string }; right?: { text: string } } {
  const meta = ctx.snapshot?.doc?.meta;
  if (!meta) return {};
  // Row 123 (C40 FIX CP-07, ID p.49 Tabel 8.1 "klasifikasi kiri, kendali salinan kanan"): ID now prints the same pair
  // as DOCX and EN (`sealBandTextsOf`: "KLASIFIKASI · <level>" left, copy control right). Before, the ID HTML printed
  // the bare level and an empty right cell (row 98: band text only "T E R B A T A S").
  const [lt, rt] = sealBandTextsOf(meta, ctx.tpl?.params ?? {}, wrapperLangOf(meta));
  return { left: lt ? { text: lt } : undefined, right: rt ? { text: rt } : undefined };
}

/** Pita segel: kiri/kanan dari blok bila diisi, selain itu teks bawaan (`sealBandDefaults`). */
export function sealBandHtml(ctx: RenderContext, d: Partial<DeviceBlock>): string {
  if (!paramBool(ctx, "device.sealBand.enabled", true)) return "";
  const defaults = d.left === undefined || d.right === undefined ? sealBandDefaults(ctx) : {};
  const left = d.left ?? defaults.left;
  const right = d.right ?? defaults.right;
  const hMm = finite(d.heightMm, 0, 100) ?? finite(paramNum(ctx, "device.sealBand.heightMm", 5), 0, 100) ?? 5;
  return el(
    ctx,
    "div",
    {
      classes: [C.device, C.sealBand],
      role: "wrapper.sealBand",
      format: { ...d.format, lineTw: d.format?.lineTw ?? Math.round((hMm * 1440) / 25.4), lineRule: d.format?.lineRule ?? "exact" },
      // Row 123 (C40 FIX CP-07, ID p.49 Tabel 8.1, p.89): band text #F4F5F6 (the role carried cream #F6E9E9).
      run: { color: SEAL_BAND_TEXT_HEX },
      attrs: [["data-height-mm", num(hMm)]],
    },
    `<span class="${C.sealLeft}">${inlineHtml(left)}</span><span class="${C.sealRight}">${inlineHtml(right)}</span>`,
  );
}

export function renderDevice(block: NormBlock, ctx: RenderContext, d: DeviceBlock): string {
  const widthMm = finite(d.widthMm, 1, 1000);
  switch (d.device) {
    case "sealBand":
      return sealBandHtml(ctx, d);
    case "logo": {
      if (typeof d.asset !== "string" || !d.asset) return reportBad(ctx, block, "logo tanpa asset");
      const uri = assetDataUri(ctx, d.asset, block);
      if (!uri) return "";
      // Row 123 (CP-02, ID p.47 butir 2): a logo device without a width is placed at the cover width (44 mm), never at its pixel size.
      const size = [`width:${num(widthMm ?? DEFAULT_LOGO_WIDTH_MM)}mm`, finite(d.heightMm, 1, 1000) ? `height:${num(d.heightMm as number)}mm` : "height:auto"]
        .filter(Boolean)
        .join(";");
      return el(
        ctx,
        "div",
        { classes: [C.device, C.logo], role: "cover.logo", format: d.format },
        `<img${attr("src", uri)}${DECORATIVE_IMG_ATTRS}${attr("style", size)}>`,
      );
    }
    case "hairline":
      return el(ctx, "div", { classes: [C.device], role: "cover.hairline", format: d.format }, `<hr class="${C.hairline}">`);
    case "datumRule":
      return datumRuleHtml(ctx, "wrapper.datumRule", widthMm ?? coverDatumRuleWidthMm(ctx, block), d.format);
    case "spineString": {
      if (!paramBool(ctx, "device.spine.enabled", true)) return "";
      const rot = paramNum(ctx, "device.spine.rotationDeg", 90) === 90 ? "90" : "0";
      const text = d.text ?? { runs: [{ t: spineText(ctx) }] };
      return el(
        ctx,
        "div",
        { classes: [C.device, C.spine], role: "cover.identityString", format: d.format, attrs: [["data-rotate", rot]] },
        inlineHtml(text),
      );
    }
    case "issueStamp":
      return el(ctx, "div", { classes: [C.device, C.issueStamp], role: "cover.colophonRight", format: d.format }, inlineHtml(d.text));
    default:
      return reportBad(ctx, block, `device tak dikenal ${String((d as { device?: unknown }).device)}`);
  }
}

/**
 * String punggung dari `device.spine.fields` (P4S-24), dipisah " · ". FIX-F lanjutan (D-314): teks = DOCX
 * `spineText` lewat sumber bersama `engine/front/texts` (`spineTextOf`; bulan Romawi, bukan nama bulan).
 */
export function spineText(ctx: RenderContext): string {
  const meta = ctx.snapshot?.doc?.meta;
  return meta ? spineTextOf(meta, ctx.tpl?.params ?? {}) : "";
}

export function isDevice(v: unknown): v is DeviceBlock {
  return isObj(v) && v.type === "device" && typeof v.device === "string";
}
