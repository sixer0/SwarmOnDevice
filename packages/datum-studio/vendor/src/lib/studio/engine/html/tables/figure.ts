/**
 * Figur HTML: chart, diagram, image, symbolSheet (padanan DOCX S19).
 *
 * - Grafik diambil dari `ctx.figures` (FigureStore, diisi produsen chart/diagram
 *   sebelum perakitan) dengan kunci berurutan: blockId, label artefak, alamat,
 *   artifactId (spec rujukan), kunci aset (image).
 * - SVG disisipkan INLINE setelah disanitasi (teks tetap `<text>` nyata, bukan
 *   gambar); PNG/JPEG sebagai data URI. Tidak ada rujukan eksternal (D-38).
 * - symbolSheet tanpa entri FigureStore memakai `symbolSheetSvg` (engine/symbols)
 *   dengan ukuran lembar turunan (lebar blok, `grid.textBlockHeightMm`; D-245 H1)
 *   dan `symbol.sheet.fit` templat (D-147), sama dengan layanan render.
 * - Gambar raster snapshot v2: aturan ukuran asli K-2 (D-242, modul bersama
 *   `engine/tokens/raster-width`): lebar kelas templat = batas atas, tidak diperbesar melewati lebar asli
 *   pada resolusi templat `image.rasterDpi` (R-65, D-257).
 * - Caption di atas, baris KUNCI lalu SUMBER/PROVENANS di bawah.
 * - Wadah `<figure data-figure="<label>">` dibaca layanan browser S25.
 * Grafik yang tidak tersedia ditulis sebagai placeholder berlabel dan dicatat
 * lewat `ctx.log` (tidak senyap).
 */
import type {
  AssetRef,
  ChartBlock,
  DiagramBlock,
  FigureCommon,
  ImageBlock,
  NormBlock,
  RenderContext,
  SymbolSheetBlock,
} from "../../../contract";
import { docAssetBytes } from "../../bind";
import { faceForRole } from "../assemble/faces";
import { baselineSnapTw } from "../../docx/blocks/rhythm";
import { type FigureAltInput, figureAltText, stripSourceLabel } from "../../front/alt-text";
import { classDerivedWidth, rasterPlacedWidthMm } from "../../tokens/raster-width";
import { symbolSheetSvg, type SymbolSheetOptions } from "../../symbols";
import { artifactLabel, captionHtml, keyRowHtml, sourceParagraphHtml } from "./apparatus";
import { artifactLabelText, wrapperLangOf } from "../../front/texts";
import { attr, escText, safeIdent } from "./escape";
import { inlinePlain } from "./inline";
import { base64DataUri, rasterDataUri, sanitizeSvg, toBase64 } from "./svg";
import { color, css, labels, n, paraCss, role } from "./style";

type FigureBlock = ChartBlock | DiagramBlock | ImageBlock | SymbolSheetBlock;

interface Graphic {
  html: string;
  source: "store" | "asset" | "symbols" | "missing";
}

function lookupKeys(block: NormBlock, fb: FigureBlock, label: string): string[] {
  const keys: Array<string | null | undefined> = [block.blockId, label, block.address];
  if ((fb.type === "chart" || fb.type === "diagram") && fb.spec && typeof fb.spec === "object" && "artifactId" in fb.spec) {
    keys.push(fb.spec.artifactId);
  }
  if (fb.type === "image") keys.push(fb.asset);
  return [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

/**
 * Row 123 (C40 FIX CP-19, ID p.50, p.89 A.2): every `font-family` attribute of an inline figure SVG lists the embedded
 * symbol face before any generic family, so mark glyphs (■ ◈ ◇ △) the Plex face lacks render in DejaVu Sans and not
 * in a system font (row 98: figure glyphs printed in Menlo-Regular; Chromium 1234 probe: Times New Roman / Menlo).
 */
export function withSymbolFallback(svg: string, symbolFamily: string): string {
  const sym = symbolFamily.trim();
  if (!sym || !/^[A-Za-z0-9 ._-]+$/.test(sym)) return svg;
  return svg.replace(/(\sfont-family=")([^"]*)(")/g, (m, a: string, v: string, c: string) => {
    const fams = v.split(",").map((f) => f.trim()).filter(Boolean);
    if (fams.some((f) => f.replace(/^['"]|['"]$/g, "").toLowerCase() === sym.toLowerCase())) return m;
    const g = fams.findIndex((f) => GENERIC_FAMILIES.has(f.toLowerCase()));
    const at = g < 0 ? fams.length : g;
    return `${a}${[...fams.slice(0, at), sym, ...fams.slice(at)].join(", ")}${c}`;
  });
}

function svgHtml(svg: string, ctx: RenderContext, block: NormBlock, prefix: string, widthMm: number | undefined, heightMm: number | undefined, aria: string): string | undefined {
  const r = sanitizeSvg(svg, { idPrefix: prefix, widthMm, heightMm, ariaLabel: aria });
  if (r.removed.elements > 0 || r.removed.attributes > 0) {
    ctx.log({
      level: "warn",
      message: `engine/html/tables: SVG figur disanitasi (${r.removed.elements} elemen, ${r.removed.attributes} atribut dibuang)`,
      address: block.address ?? undefined,
    });
  }
  return r.svg.length > 0 ? withSymbolFallback(r.svg, faceForRole(ctx.tpl, "symbolGlyph")) : undefined;
}

function imgHtml(uri: string, widthMm: number | undefined, heightMm: number | undefined, alt: string): string {
  const style = css("display:block", widthMm !== undefined ? `width:${n(widthMm)}mm` : "max-width:100%", heightMm !== undefined ? `height:${n(heightMm)}mm` : "height:auto");
  return `<img src="${escText(uri)}" alt="${escText(alt)}" style="${escText(style)}">`;
}

function resolveGraphic(block: NormBlock, fb: FigureBlock, ctx: RenderContext, label: string, aria: string): Graphic {
  const prefix = `fig-${safeIdent(block.blockId || label || String(block.ordinal))}`;
  let widthMm: number | undefined = typeof fb.widthMm === "number" && fb.widthMm > 0 ? fb.widthMm : undefined;
  let heightMm: number | undefined = typeof fb.heightMm === "number" && fb.heightMm > 0 ? fb.heightMm : undefined;

  // 1. FigureStore.
  for (const key of lookupKeys(block, fb, label)) {
    let entry: ReturnType<RenderContext["figures"]["get"]>;
    try {
      entry = ctx.figures?.get(key);
    } catch (e) {
      ctx.log({ level: "warn", message: `engine/html/tables: FigureStore.get("${key}") gagal (${e instanceof Error ? e.message : String(e)})`, address: block.address ?? undefined });
      entry = undefined;
    }
    if (!entry) continue;
    widthMm = widthMm ?? (entry.widthMm > 0 ? entry.widthMm : undefined);
    heightMm = heightMm ?? (entry.heightMm > 0 ? entry.heightMm : undefined);
    if (typeof entry.svg === "string" && entry.svg.length > 0) {
      const html = svgHtml(entry.svg, ctx, block, prefix, widthMm, heightMm, aria);
      if (html) return { html, source: "store" };
    }
    if (entry.png && entry.png.length > 0) {
      const uri = rasterDataUri(entry.png);
      if (uri) return { html: imgHtml(uri, widthMm, heightMm, aria), source: "store" };
    }
  }

  // 2. Aset raster dokumen (image): ctx.assetBytes per sha256, lalu dataBase64
  //    (sumber tunggal `docAssetBytes`, IP-34). Base64 asli dipakai apa adanya.
  if (fb.type === "image") {
    const src = docAssetBytes(ctx, fb.asset, block.address ?? undefined);
    const asset: AssetRef | undefined = src?.ref;
    if (asset && (src?.bytes || src?.invalidBase64)) {
      const b64 = src.base64 ?? (src.bytes ? toBase64(src.bytes) : "");
      const uri = base64DataUri(asset.mime, b64);
      if (uri) {
        if (widthMm !== undefined && classDerivedWidth(ctx.snapshot)) {
          const placed = rasterPlacedWidthMm(widthMm, asset.widthPx, ctx.tpl.params);
          if (heightMm !== undefined) heightMm = (heightMm * placed) / widthMm;
          widthMm = placed;
        }
        if (heightMm === undefined && widthMm !== undefined && asset.widthPx && asset.heightPx) heightMm = (widthMm * asset.heightPx) / asset.widthPx;
        return { html: imgHtml(uri, widthMm, heightMm, aria), source: "asset" };
      }
      ctx.log({ level: "error", message: `engine/html/tables: aset "${fb.asset}" bukan PNG/JPEG base64 yang sah`, code: "ASSET_TYPE_UNSUPPORTED", address: block.address ?? undefined });
    }
  }

  // 3. Lembar simbol langsung dari engine/symbols.
  if (fb.type === "symbolSheet") {
    try {
      const opts: SymbolSheetOptions = { fit: ctx.tpl.params["symbol.sheet.fit"] === true };
      if (widthMm !== undefined) opts.widthMm = widthMm;
      const blockH = ctx.tpl.params["grid.textBlockHeightMm"];
      if (typeof blockH === "number" && blockH > 0) opts.heightMm = blockH;
      const sheets = symbolSheetSvg(fb.dialect, fb.cols, opts);
      const parts = sheets
        .map((s, i) => svgHtml(s, ctx, block, `${prefix}-s${i}`, widthMm, undefined, sheetAria(fb, ctx, label, i + 1, sheets.length)))
        .filter((s): s is string => !!s);
      if (parts.length > 0) return { html: parts.join(""), source: "symbols" };
    } catch (e) {
      ctx.log({ level: "warn", message: `engine/html/tables: symbolSheetSvg(${fb.dialect}) tidak tersedia (${e instanceof Error ? e.message : String(e)})`, address: block.address ?? undefined });
    }
  }

  // 4. Placeholder berlabel (tercatat).
  ctx.log({
    level: "warn",
    message: `engine/html/tables: grafik figur ${label || block.blockId} (${fb.type}) tidak ada di FigureStore; placeholder ditulis`,
    code: "ARTIFACT_NOT_FOUND",
    address: block.address ?? undefined,
  });
  const ink = color(ctx.tpl, "ink400", "ink400");
  const style = css(
    "display:flex",
    "align-items:center",
    "justify-content:center",
    `width:${widthMm !== undefined ? `${n(widthMm)}mm` : "100%"}`,
    `height:${n(heightMm ?? 40)}mm`,
    `border:0.2mm dashed ${ink}`,
    `color:${ink}`,
    "font-size:7pt",
  );
  return { html: `<div class="st-figure-missing" style="${escText(style)}">${escText(`${labels(ctx).figureMissing}: ${artifactLabelText(label, wrapperLangOf(ctx.snapshot?.doc?.meta)) || fb.type}`)}</div>`, source: "missing" };
}

/**
 * Teks alternatif figur (FIX-H8): SATU sumber dengan `wp:docPr` DOCX (`engine/front/alt-text`):
 * label + caption + "Sumber: ..."; tanpa caption -> subjek dari jenis figur.
 */
function htmlAltInput(fb: FigureBlock, ctx: RenderContext, label: string): FigureAltInput {
  let kindHint: string | undefined;
  if (fb.type === "chart" && fb.spec && typeof fb.spec === "object" && "kind" in fb.spec && typeof fb.spec.kind === "string") kindHint = fb.spec.kind;
  else if (fb.type === "symbolSheet") kindHint = fb.dialect;
  else if (fb.type === "image") kindHint = ctx.snapshot?.doc?.assets?.[fb.asset]?.path;
  return {
    type: fb.type,
    label,
    caption: inlinePlain(fb.caption?.inline),
    source: stripSourceLabel(inlinePlain(fb.source?.inline)),
    language: ctx.snapshot?.doc?.meta?.language,
    kindHint,
  };
}

function sheetAria(fb: FigureBlock, ctx: RenderContext, label: string, index: number, count: number): string {
  return figureAltText({ ...htmlAltInput(fb, ctx, label), sheet: { index, count } }).descr;
}

/** Renderer HtmlBlockRenderer untuk chart/diagram/image/symbolSheet. */
export function renderFigureBlock(block: NormBlock, ctx: RenderContext): string {
  const fb = block.content as FigureBlock | null;
  if (!fb || typeof fb !== "object" || !("caption" in fb)) {
    ctx.log({ level: "error", message: `engine/html/tables: isi blok ${block.type} tidak berbentuk figur`, code: "SCHEMA_INVALID", address: block.address ?? undefined });
    return `<figure class="st-figure st-invalid"${attr("data-address", block.address ?? undefined)}></figure>`;
  }
  const common: FigureCommon = fb;
  const label = artifactLabel(block, ctx, common.caption);
  const aria = figureAltText(htmlAltInput(fb, ctx, label)).descr;
  const g = resolveGraphic(block, fb, ctx, label, aria);
  const rf = role(ctx, "figure.paragraph");
  const graphicStyle = css(paraCss(common.paragraphFormat ?? rf.para).replace("white-space:pre-wrap", "white-space:normal"), "line-height:0");
  const figStyle = css("margin:0", "break-inside:avoid", typeof common.widthMm === "number" && common.widthMm > 0 ? `max-width:${n(common.widthMm)}mm` : undefined);
  const attrs =
    (block.address ? attr("data-address", block.address) : "") +
    (block.blockId ? attr("data-block-id", block.blockId) : "") +
    attr("data-block-type", fb.type) +
    attr("data-figure", label || block.blockId) +
    attr("data-graphic-source", g.source);
  // C22b / GF-21 (R-74): caption, KUNCI dan SUMBER figur dikunci ke garis dasar (= DOCX figure.ts `apparatusAdjust`).
  const base = baselineSnapTw((k) => ctx.tpl?.params?.[k]);
  return (
    `<figure class="st-figure st-figure-${escText(fb.type)}"${attrs} style="${escText(figStyle)}">` +
    captionHtml(common.caption, label, ctx, "margin-bottom:2.2mm", base) +
    `<div class="st-figure-graphic" style="${escText(graphicStyle)}">${g.html}</div>` +
    keyRowHtml(common.keyRow, ctx, base) +
    sourceParagraphHtml(common.source, ctx, "figure.source", true, base) +
    `</figure>`
  );
}
