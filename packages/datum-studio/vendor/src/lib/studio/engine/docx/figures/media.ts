/**
 * Media figur DOCX (S19): pengenalan PNG/JPEG, sha256, nama part deterministik,
 * deduplikasi, dan resolusi aset raster (`assets{}` dokumen atau templat).
 *
 * Nama part = `fig-<sha256 32 hex>.<png|jpg>` di bawah `word/media/`; relasi
 * `rIdFig<sha256 32 hex>`. Isi sama -> nama sama -> satu part (deduplikasi
 * lintas blok dilakukan perakit S20 dengan `mergeFigureMedia`).
 *
 * Modul khusus server (node:crypto, node:fs, node:path).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AssetRef, DocxFragment, RenderContext } from "../../../contract";
import { STUDIO_MAX_ASSET_BYTES, getStudioEnv, isPathInside } from "../../../contract/env";
import { StudioEngineError } from "../../../contract/errors";
import { docAssetBytes } from "../../bind";
import { failRender } from "./log";

export type FigureMime = "image/png" | "image/jpeg";

export interface FigureImage {
  bytes: Uint8Array;
  mime: FigureMime;
  sha256: string;
  widthPx: number;
  heightPx: number;
  /** dpi tertanam (PNG pHYs / JPEG JFIF), bila ada. */
  dpi?: number;
}

export type FigureMediaEntry = NonNullable<DocxFragment["media"]>[number];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) + b[o + 1];
}

function sniffPng(b: Uint8Array): Omit<FigureImage, "bytes" | "sha256"> | null {
  if (b.length < 33 || !PNG_SIG.every((v, i) => b[i] === v)) return null;
  // IHDR wajib chunk pertama.
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  const widthPx = u32(b, 16);
  const heightPx = u32(b, 20);
  let dpi: number | undefined;
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === "pHYs" && len >= 9 && b[o + 16] === 1) {
      dpi = Math.round((u32(b, o + 8) * 0.0254) * 10) / 10; // piksel per meter -> dpi
      break;
    }
    if (type === "IDAT" || type === "IEND") break;
    o += 12 + len;
  }
  return { mime: "image/png", widthPx, heightPx, dpi };
}

function sniffJpeg(b: Uint8Array): Omit<FigureImage, "bytes" | "sha256"> | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let dpi: number | undefined;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    const len = u16(b, o + 2);
    // APP0 JFIF: satuan 1 = dpi.
    if (marker === 0xe0 && len >= 14 && String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]) === "JFIF" && b[o + 11] === 1) {
      dpi = u16(b, o + 12);
    }
    // SOF0..SOF15 kecuali DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 9 > b.length) return null;
      return { mime: "image/jpeg", heightPx: u16(b, o + 5), widthPx: u16(b, o + 7), dpi };
    }
    o += 2 + len;
  }
  return null;
}

/** Kenali PNG/JPEG dari byte (magic number, bukan ekstensi). */
export function sniffImage(bytes: Uint8Array): Omit<FigureImage, "bytes" | "sha256"> | null {
  const r = sniffPng(bytes) ?? sniffJpeg(bytes);
  if (!r || r.widthPx < 1 || r.heightPx < 1) return null;
  return r;
}

export function figureImageFromBytes(bytes: Uint8Array, ctx: RenderContext, address: string | undefined, what: string): FigureImage {
  if (bytes.length > STUDIO_MAX_ASSET_BYTES) {
    failRender(ctx, "ASSET_TOO_LARGE", `${what}: ${bytes.length} byte melebihi batas ${STUDIO_MAX_ASSET_BYTES}`, address);
  }
  const info = sniffImage(bytes);
  if (!info) failRender(ctx, "ASSET_TYPE_UNSUPPORTED", `${what}: bukan PNG/JPEG yang sah`, address);
  return { bytes, sha256: sha256Hex(bytes), ...info };
}

export function mediaExt(mime: FigureMime): "png" | "jpg" {
  return mime === "image/png" ? "png" : "jpg";
}

/** Nama part deterministik (berkas di `word/media/`). */
export function figureMediaName(sha256: string, mime: FigureMime): string {
  return `fig-${sha256.slice(0, 32)}.${mediaExt(mime)}`;
}

/**
 * Id relasi `word/_rels/document.xml.rels` untuk media figur; perakit S20
 * menulis relasi `{ id: figureMediaRelId(name), type: image, target: "media/" + name }`.
 */
export function figureMediaRelId(name: string): string {
  const m = /^fig-([0-9a-f]{32})\.(png|jpg)$/.exec(name);
  if (!m) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Nama media figur tidak dikenal: ${name}`);
  return `rIdFig${m[1]}`;
}

export const FIGURE_IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/** Tambah media ke daftar fragmen tanpa duplikat (kunci = nama = sha256). */
export function addMedia(list: FigureMediaEntry[], img: FigureImage): string {
  const name = figureMediaName(img.sha256, img.mime);
  if (!list.some((m) => m.name === name)) list.push({ name, data: img.bytes, contentType: img.mime });
  return name;
}

/**
 * Gabung media dari banyak fragmen: deduplikasi menurut nama; nama sama dengan
 * isi berbeda adalah cacat konstruksi (melempar). Urutan = kemunculan pertama.
 */
export function mergeFigureMedia(fragments: ReadonlyArray<Pick<DocxFragment, "media">>): FigureMediaEntry[] {
  const out = new Map<string, FigureMediaEntry>();
  for (const f of fragments) {
    for (const m of f.media ?? []) {
      const prev = out.get(m.name);
      if (!prev) {
        out.set(m.name, m);
        continue;
      }
      if (prev.data.length !== m.data.length || sha256Hex(prev.data) !== sha256Hex(m.data)) {
        throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Media ${m.name} muncul dengan isi berbeda`);
      }
    }
  }
  return [...out.values()];
}

function readGuarded(file: string, root: string, ctx: RenderContext, address: string | undefined, what: string): Uint8Array {
  const abs = path.resolve(file);
  if (!isPathInside(abs, root)) {
    failRender(ctx, "PATH_OUTSIDE_ROOT", `${what}: path di luar akar aset`, address);
  }
  let size: number;
  try {
    size = statSync(abs).size;
  } catch (e) {
    failRender(ctx, "FILE_MISSING_ON_DISK", `${what}: berkas aset tidak ada (${e instanceof Error ? e.message : String(e)})`, address);
  }
  if (size > STUDIO_MAX_ASSET_BYTES) {
    failRender(ctx, "ASSET_TOO_LARGE", `${what}: ${size} byte melebihi batas ${STUDIO_MAX_ASSET_BYTES}`, address);
  }
  try {
    return new Uint8Array(readFileSync(abs));
  } catch (e) {
    failRender(ctx, "FILE_MISSING_ON_DISK", `${what}: gagal membaca aset (${e instanceof Error ? e.message : String(e)})`, address);
  }
}

function assertSha(img: FigureImage, want: string | undefined, ctx: RenderContext, address: string | undefined, what: string): FigureImage {
  if (want && want.toLowerCase() !== img.sha256) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `${what}: sha256 isi ${img.sha256} tidak sama dengan sha256 terdaftar ${want.toLowerCase()}`, address);
  }
  return img;
}

/**
 * Aset raster blok `image`: `doc.assets[key]` (`ctx.assetBytes` per sha256,
 * dataBase64, path relatif `<STUDIO_WORKSPACE_ROOT>/assets`, atau
 * `assets/<sha256>.<ext>`) lalu
 * `tpl.assets[key]` (kind raster). sha256 isi wajib sama dengan yang terdaftar.
 */
export function resolveRasterAsset(key: string, ctx: RenderContext, address: string | undefined): FigureImage {
  const what = `Aset "${key}"`;
  const ref: AssetRef | undefined = ctx.snapshot.doc.assets?.[key];
  if (ref) {
    if (ref.kind !== "raster") failRender(ctx, "ASSET_TYPE_UNSUPPORTED", `${what}: jenis ${String(ref.kind)}`, address);
    // Sumber tunggal (IP-34): ctx.assetBytes, lalu dataBase64, lalu path akar aset.
    const src = docAssetBytes(ctx, key, address);
    if (src?.invalidBase64) failRender(ctx, "ASSET_TYPE_UNSUPPORTED", `${what}: dataBase64 bukan base64 yang sah`, address);
    let bytes: Uint8Array;
    if (src?.bytes) {
      bytes = src.bytes;
    } else {
      const root = path.resolve(getStudioEnv().workspaceRoot, "assets");
      const rel = ref.path ?? `${ref.sha256.toLowerCase()}.${ref.mime === "image/png" ? "png" : "jpg"}`;
      bytes = readGuarded(path.resolve(root, rel), root, ctx, address, what);
    }
    const img = assertSha(figureImageFromBytes(bytes, ctx, address, what), ref.sha256, ctx, address, what);
    if (img.mime !== ref.mime) {
      failRender(ctx, "ASSET_TYPE_UNSUPPORTED", `${what}: isi ${img.mime} tetapi terdaftar ${ref.mime}`, address);
    }
    return img;
  }
  const tplAsset = ctx.tpl.assets[key];
  if (tplAsset) {
    if (tplAsset.kind !== "raster") failRender(ctx, "ASSET_TYPE_UNSUPPORTED", `${what}: aset templat berjenis ${tplAsset.kind}`, address);
    const abs = path.resolve(tplAsset.absPath);
    const bytes = readGuarded(abs, path.dirname(abs), ctx, address, what);
    return assertSha(figureImageFromBytes(bytes, ctx, address, what), tplAsset.sha256, ctx, address, what);
  }
  failRender(ctx, "FILE_NOT_FOUND", `${what} tidak terdaftar di assets dokumen maupun templat`, address);
}
