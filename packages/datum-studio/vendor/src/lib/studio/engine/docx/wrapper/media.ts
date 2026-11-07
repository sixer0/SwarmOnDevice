/**
 * Media halaman pembungkus (S18): logo sampul, citra Datum Rule, dan
 * penempatan `wp:inline`.
 *
 * Konvensi media SAMA dengan figur S19 (engine/docx/figures/media.ts) agar
 * perakit S20 menangani satu pola: nama part `fig-<sha256 32 heksa>.<png|jpg>`
 * di `word/media/`, relasi `rIdFig<sha256 32 heksa>`, id `wp:docPr` =
 * 100000 + ordinal * 16 + indeks gambar dalam blok. Isi sama -> nama sama,
 * sehingga Datum Rule berulang dideduplikasi. Namespace drawing dideklarasikan
 * lokal di elemen agar fragmen sah tanpa bergantung pada akar document.xml.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { zlibSync } from "fflate";

import type { AssetRef, DocxFragment, Hex, RenderContext } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { assertStudioAssetPath, getStudioEnv, isPathInside, studioAssetsRoot } from "../../../contract/env";
import { docAssetBytes } from "../../bind";
import { decorativeDocPrXml, type DecorativeKind } from "../blocks/media";

export type { DecorativeKind };
import { pNum } from "./formats";
import { DRAWING_NS, escapeXml, mmToEmu } from "./xml";

export type MediaItem = NonNullable<DocxFragment["media"]>[number];

/** Akar aset Studio relatif cwd repo (S13). Swarm patch (row 107, M4): reads use studioAssetsRoot(), not cwd. */
export const STUDIO_ASSETS_DIR = path.join("src", "lib", "studio", "assets");
/** Logo sampul benchmark (BM image1.png, sha256 6963...111e = manifest S13). */
export const DEFAULT_LOGO_REL_PATH = "logo/gsp-tinta.png";
/** Lebar logo sampul BM (research/07 §7 penempatan 1: 44,00 x 23,66 mm). */
export const DEFAULT_LOGO_WIDTH_MM = 44;
/** Basis id `wp:docPr` (sama dengan S19 DOCPR_ID_BASE). */
export const WRAPPER_DOCPR_ID_BASE = 100000;

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export function mediaName(data: Uint8Array, ext: "png" | "jpeg"): string {
  return `fig-${sha256Hex(data).slice(0, 32)}.${ext === "png" ? "png" : "jpg"}`;
}

/** Id relasi deterministik untuk media bernama `name` (= S19 figureMediaRelId). */
export function mediaRelId(name: string): string {
  const m = /^fig-([0-9a-f]{32})\.(png|jpg)$/.exec(name);
  if (!m) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `nama media pembungkus tidak dikenal: ${name}`);
  return `rIdFig${m[1]}`;
}

// ── PNG ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new TextEncoder().encode(type);
  return [u32(data.length), t, data, u32(crc32([t, data]))];
}

/** PNG RGBA 8-bit deterministik (filter 0, zlib level 9, pHYs dpi). */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array, dpi: number): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(9);
  phys.set(u32(ppm), 0);
  phys.set(u32(ppm), 4);
  phys[8] = 1;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk("IHDR", ihdr),
    ...chunk("pHYs", phys),
    ...chunk("IDAT", zlibSync(raw, { level: 9 })),
    ...chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Ukuran piksel PNG dari IHDR (tanpa dekode). */
export function pngSize(b: Uint8Array): { widthPx: number; heightPx: number } | undefined {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return undefined;
  const r = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  return { widthPx: r(16), heightPx: r(20) };
}

// ── Datum Rule ───────────────────────────────────────────────────────────

/** Resolusi citra rule BM: 600 dpi (research/07 §7.1 image2/image3). */
export const DATUM_RULE_DPI = 600;
/** Tinggi terpasang citra rule BM (5976000 x 86874 EMU = 166 x 2,41 mm). */
export const DATUM_RULE_HEIGHT_MM = 2.41;

export interface DatumRuleSpec {
  widthMm: number;
  color: Hex;
  /** Jarak tik (mm) = grid.latticeXMm. */
  pitchMm: number;
  /** Segmen pejal depan (mm) = device.datumRule.frontSegmentMm. */
  frontSegmentMm: number;
}

/**
 * Citra Datum Rule pada 600 dpi, geometri piksel diukur dari BM.docx
 * (image2.png 3921x57 dan image3.png 3024x57): garis atas baris 0-5 penuh,
 * segmen depan baris 6-18 dari x 0 sampai round(segmen), tik selebar 5 px
 * baris 0-32 di setiap kelipatan round(pitch), sisa transparan.
 */
export function datumRulePng(s: DatumRuleSpec): { png: Uint8Array; widthMm: number; heightMm: number } {
  const pxPerMm = DATUM_RULE_DPI / 25.4;
  const w = Math.max(1, Math.round(s.widthMm * pxPerMm));
  const h = 57;
  const pitch = Math.max(6, Math.round(s.pitchMm * pxPerMm));
  const front = Math.max(0, Math.round(s.frontSegmentMm * pxPerMm));
  const rgba = new Uint8Array(w * h * 4);
  const cr = parseInt(s.color.slice(0, 2), 16);
  const cg = parseInt(s.color.slice(2, 4), 16);
  const cb = parseInt(s.color.slice(4, 6), 16);
  const set = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    rgba[i] = cr;
    rgba[i + 1] = cg;
    rgba[i + 2] = cb;
    rgba[i + 3] = 255;
  };
  for (let y = 0; y <= 5; y++) for (let x = 0; x < w; x++) set(x, y);
  if (front > 0) for (let y = 6; y <= 18; y++) for (let x = 0; x <= front; x++) set(x, y);
  for (let x0 = 0; x0 < w; x0 += pitch) for (let y = 0; y <= 32; y++) for (let x = x0; x <= x0 + 4; x++) set(x, y);
  // Tinggi terpasang mengikuti rasio piksel (BM: 166 -> 2,413167 mm; 128 -> 2,412694 mm).
  return { png: encodePngRgba(w, h, rgba, DATUM_RULE_DPI), widthMm: s.widthMm, heightMm: (s.widthMm * h) / w };
}

// ── Pemuatan aset ────────────────────────────────────────────────────────

export interface LoadedImage {
  data: Uint8Array;
  ext: "png" | "jpeg";
  contentType: "image/png" | "image/jpeg";
  widthPx?: number;
  heightPx?: number;
}

function sniff(data: Uint8Array): { ext: "png" | "jpeg"; contentType: "image/png" | "image/jpeg" } {
  if (data[0] === 0xff && data[1] === 0xd8) return { ext: "jpeg", contentType: "image/jpeg" };
  if (data[0] === 0x89 && data[1] === 0x50) return { ext: "png", contentType: "image/png" };
  throw new StudioEngineError("ASSET_TYPE_UNSUPPORTED", "aset gambar pembungkus bukan PNG/JPEG");
}

function readAbs(absPath: string, label: string): Uint8Array {
  if (!existsSync(absPath)) {
    throw new StudioEngineError("FILE_MISSING_ON_DISK", `aset ${label} tidak ada di disk`, { asset: label });
  }
  return new Uint8Array(readFileSync(absPath));
}

function fromBytes(data: Uint8Array, expectSha?: string, label = "aset"): LoadedImage {
  if (expectSha && sha256Hex(data) !== expectSha.toLowerCase()) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `sha256 ${label} tidak cocok dengan deklarasi`, { asset: label });
  }
  const t = sniff(data);
  const size = t.ext === "png" ? pngSize(data) : undefined;
  return { data, ...t, widthPx: size?.widthPx, heightPx: size?.heightPx };
}

interface ManifestEntry {
  path?: string;
  sha256?: string;
}

let manifestCache: { dir: string; entries: ManifestEntry[] } | undefined;

/** Entri manifest aset S13 (`src/lib/studio/assets/manifest.json`), dicache per cwd. */
function studioManifest(): ManifestEntry[] {
  const dir = studioAssetsRoot();
  if (manifestCache?.dir === dir) return manifestCache.entries;
  const mp = path.join(dir, "manifest.json");
  let entries: ManifestEntry[] = [];
  if (existsSync(mp)) {
    try {
      entries = (JSON.parse(readFileSync(mp, "utf8")) as { entries?: ManifestEntry[] }).entries ?? [];
    } catch (e) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "manifest aset Studio tidak terbaca", { cause: e instanceof Error ? e.message : String(e) });
    }
  }
  manifestCache = { dir, entries };
  return entries;
}

/** Cari berkas raster ber-sha256 sama: `tpl.assets` lalu manifest S13. */
function findBySha(ctx: RenderContext, sha: string, label: string): LoadedImage | undefined {
  const want = sha.toLowerCase();
  for (const k of Object.keys(ctx.tpl.assets).sort()) {
    const t = ctx.tpl.assets[k];
    if (t.kind === "raster" && t.sha256.toLowerCase() === want) return fromBytes(readAbs(assertStudioAssetPath(t.absPath), label), want, label);
  }
  const root = studioAssetsRoot();
  const hit = studioManifest().find((e) => e.sha256?.toLowerCase() === want && e.path);
  if (hit?.path) {
    const abs = path.resolve(root, hit.path);
    if (isPathInside(abs, root) && existsSync(abs)) return fromBytes(readAbs(abs, label), want, label);
  }
  return undefined;
}

/**
 * Muat aset gambar berdasarkan kunci. Urutan: `doc.assets[key]` lewat
 * `ctx.assetBytes` (sha256) atau dataBase64 (`docAssetBytes`, IP-34),
 * path relatif akar aset Studio (dijaga dari path traversal), `tpl.assets[key]`,
 * berkas ber-sha256 sama di `tpl.assets` atau manifest S13 (konvensi S93 C11:
 * `bm-fig-NN` hanya membawa sha256), lalu PNG `ctx.figures.get(key)`.
 * `undefined` bila tidak terselesaikan.
 */
export function loadAsset(ctx: RenderContext, key: string): LoadedImage | undefined {
  // Sumber tunggal (IP-34): ctx.assetBytes per sha256, lalu dataBase64.
  const src = docAssetBytes(ctx, key);
  const ref: AssetRef | undefined = src?.ref;
  if (src?.invalidBase64) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `dataBase64 aset ${key} bukan base64 yang sah`, { asset: key });
  if (src?.bytes) return fromBytes(src.bytes, ref?.sha256, key);
  // Path dokumen relatif `<STUDIO_WORKSPACE_ROOT>/assets` (sama dengan S19);
  // tanpa path dicoba `assets/<sha256>.<ext>` bila berkasnya ada.
  if (ref?.path || ref?.sha256) {
    const root = path.resolve(getStudioEnv().workspaceRoot, "assets");
    const rel = ref.path ?? `${ref.sha256.toLowerCase()}.${ref.mime === "image/png" ? "png" : "jpg"}`;
    const abs = path.resolve(root, rel);
    if (!isPathInside(abs, root)) throw new StudioEngineError("PATH_OUTSIDE_ROOT", `path aset ${key} keluar dari akar aset`, { asset: key });
    if (ref.path || existsSync(abs)) return fromBytes(readAbs(abs, key), ref.sha256, key);
  }
  const t = ctx.tpl.assets[key];
  if (t && t.kind === "raster") return fromBytes(readAbs(assertStudioAssetPath(t.absPath), key), ref?.sha256 ?? t.sha256, key);
  if (ref?.sha256) {
    const bySha = findBySha(ctx, ref.sha256, key);
    if (bySha) return bySha;
  }
  const fig = ctx.figures.get(key);
  if (fig?.png) return fromBytes(fig.png, ref?.sha256, key);
  return undefined;
}

/** Logo sampul: kunci eksplisit > `tpl.assets.logo` > aset S13 `logo/gsp-tinta.png`. */
export function loadLogo(ctx: RenderContext, key?: string): LoadedImage {
  if (key) {
    const a = loadAsset(ctx, key);
    if (!a) throw new StudioEngineError("FILE_NOT_FOUND", `aset logo "${key}" tidak dikenal`, { asset: key });
    return a;
  }
  const t = loadAsset(ctx, "logo");
  if (t) return t;
  return fromBytes(readAbs(path.resolve(studioAssetsRoot(), DEFAULT_LOGO_REL_PATH), DEFAULT_LOGO_REL_PATH));
}

/**
 * Datum Rule: aset bernama (`device.asset`) > aset templat `rule<lebar>` /
 * `datumRule<lebar>` (§13.1 K-24) > citra yang dibangkitkan dengan geometri BM.
 * Aset bernama yang tak terselesaikan tidak menggagalkan render: rule
 * dibangkitkan dan dicatat di log (piksel setara, byte PNG berbeda).
 */
export function loadDatumRule(
  ctx: RenderContext,
  widthMm: number,
  color: Hex,
  assetKey?: string,
): { img: LoadedImage; widthMm: number; heightMm: number } {
  const keys = assetKey ? [assetKey] : [`rule${Math.round(widthMm)}`, `datumRule${Math.round(widthMm)}`];
  for (const key of keys) {
    const fromAsset = loadAsset(ctx, key);
    if (fromAsset) {
      const hMm = fromAsset.widthPx && fromAsset.heightPx ? (widthMm * fromAsset.heightPx) / fromAsset.widthPx : DATUM_RULE_HEIGHT_MM;
      return { img: fromAsset, widthMm, heightMm: hMm };
    }
  }
  if (assetKey) {
    ctx.log({ level: "warn", code: "FILE_NOT_FOUND", message: `aset Datum Rule "${assetKey}" tidak terselesaikan; rule dibangkitkan dari geometri BM` });
  }
  const p = ctx.tpl.params;
  const g = datumRulePng({
    widthMm,
    color,
    pitchMm: pNum(p, "grid.latticeXMm") ?? 10.6667,
    frontSegmentMm: pNum(p, "device.datumRule.frontSegmentMm") ?? 9,
  });
  return { img: fromBytes(g.png), widthMm: g.widthMm, heightMm: g.heightMm };
}

// ── wp:inline ────────────────────────────────────────────────────────────

/**
 * Run gambar inline. `docPrId` harus unik per dokumen; pemanggil memberi
 * nilai deterministik dari ordinal blok (perakit S20 boleh menomori ulang).
 * Gambar pembungkus selalu aparatus (logo sampul, Datum Rule): `wp:docPr`
 * ditandai dekoratif dengan nama bermakna dari `decorative` (FIX-HZ2, D-326).
 */
export function inlineImageRunXml(i: {
  relId: string;
  name: string;
  widthMm: number;
  heightMm: number;
  docPrId: number;
  decorative?: DecorativeKind;
  lang?: "ID" | "EN";
}): string {
  const cx = mmToEmu(i.widthMm);
  const cy = mmToEmu(i.heightMm);
  const n = escapeXml(i.name);
  return (
    `<w:r><w:drawing><wp:inline xmlns:wp="${DRAWING_NS.wp}" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    decorativeDocPrXml(i.docPrId, i.decorative ?? "ornament", i.lang ?? "ID", DRAWING_NS.a) +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${DRAWING_NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${DRAWING_NS.a}"><a:graphicData uri="${DRAWING_NS.pic}">` +
    `<pic:pic xmlns:pic="${DRAWING_NS.pic}"><pic:nvPicPr><pic:cNvPr id="0" name="${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip xmlns:r="${DRAWING_NS.r}" r:embed="${escapeXml(i.relId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}
