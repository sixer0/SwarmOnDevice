/**
 * Simpan/baca aset raster lewat layanan penyimpanan S52 (tata letak §7.2
 * `assets/<sha256>.<png|jpg>`). Beralamat isi: nama = sha256 sehingga unggah
 * ulang berkas yang sama idempoten. Path dibangun dan dijaga oleh
 * `resolveSafe`/`assertRealInsideRoot` S52 (tanpa traversal, tanpa symlink
 * keluar akar); tulis atomik tmp -> rename. `AssetRef.path` = relatif akar
 * aset (`<sha256>.<ext>`), sama dengan pembaca S19 dan S51.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetRef } from "../../contract";
import { STUDIO_ASSET_REL_DIR } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import { assertRealInsideRoot, readStoredFile, resolveSafe, sha256Hex, storageLog, toRelPath } from "../storage";
import { decodeImageDetailed, IMAGE_SOURCE, type DecodedImage } from "./decode";
import type { RasterMime } from "./sniff";

export const ASSETS_DIR = "assets";
const SHA256_RE = /^[0-9a-f]{64}$/;
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 50;

export function imageExt(mime: RasterMime): "png" | "jpg" {
  return mime === "image/png" ? "png" : "jpg";
}

/** Nama berkas aset relatif akar aset: `<sha256>.<png|jpg>`. */
export function assetFileName(sha256: string, mime: RasterMime): string {
  const sha = sha256.toLowerCase();
  if (!SHA256_RE.test(sha)) throw new StudioEngineError("SCHEMA_INVALID", "sha256 must be 64 hex characters", { reason: "sha256_format" });
  return `${sha}.${imageExt(mime)}`;
}

/** relPath akar Studio: `assets/<sha256>.<ext>`. */
export function assetRelPath(sha256: string, mime: RasterMime): string {
  return toRelPath(ASSETS_DIR, assetFileName(sha256, mime));
}

export interface StoredImageAsset {
  /** Siap dipakai di `doc.assets[key]` / `StudioImageV1.asset` (tanpa dataBase64). */
  asset: AssetRef & { path: string; widthPx: number; heightPx: number };
  /** Relatif akar Studio (`assets/...`). */
  relPath: string;
  bytes: number;
  /** false = berkas dengan sha256 sama sudah ada (idempoten). */
  created: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function existingMatches(abs: string, relPath: string, sha256: string): Promise<boolean> {
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new StudioEngineError("PATH_OUTSIDE_ROOT", "Asset target is not a regular file", { reason: "target_not_regular" });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const cur = await readStoredFile(relPath);
  return sha256Hex(cur.data) === sha256;
}

async function renameInto(tmp: string, abs: string, relPath: string, sha256: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, abs);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows: unggah serentak berkas yang sama dapat mengunci tujuan; isi sama = selesai.
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && (await existingMatches(abs, relPath, sha256).catch(() => false))) {
        await rm(tmp, { force: true }).catch(() => undefined);
        return;
      }
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(RENAME_RETRY_MS * (attempt + 1));
    }
  }
}

/**
 * C33c (register SR-01): `relPath` M13 = `assets/<sha256[0..2]>/<sha256>.<ext>`
 * relatif akar Studio. Pembaca lama (S19/S51, ingest v1) memakai tata letak
 * datar `assets/<sha256>.<ext>`; SR-19 menulis keduanya (lihat `storeAsset`).
 */
export function assetShardRelPath(sha256: string, mime: RasterMime): string {
  const name = assetFileName(sha256, mime);
  return toRelPath(STUDIO_ASSET_REL_DIR, name.slice(0, 2), name);
}

/**
 * Tulis byte beralamat isi ke `relPath` (di bawah akar Studio) secara atomik
 * (tmp -> rename) dan idempoten: berkas yang ada dengan sha256 sama = tidak
 * ditulis ulang (`created: false`). Galat I/O dicatat ke sink penyimpanan.
 */
export async function writeAssetFile(
  relPath: string,
  bytes: Uint8Array,
  sha256: string,
  opts: { correlationId?: string } = {},
): Promise<{ created: boolean }> {
  const abs = resolveSafe(relPath);
  const tmpDir = resolveSafe("tmp/storage");
  const tmpFile = path.join(tmpDir, `${randomUUID()}.tmp`);
  let wroteTmp = false;
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await assertRealInsideRoot(path.dirname(abs));
    if (await existingMatches(abs, relPath, sha256)) return { created: false };
    await mkdir(tmpDir, { recursive: true });
    await assertRealInsideRoot(tmpDir);
    await writeFile(tmpFile, bytes, { flag: "wx" });
    wroteTmp = true;
    await renameInto(tmpFile, abs, relPath, sha256);
    wroteTmp = false;
    return { created: true };
  } catch (err) {
    if (wroteTmp) await rm(tmpFile, { force: true }).catch(() => undefined);
    if (!(err instanceof StudioEngineError)) {
      const e = err as NodeJS.ErrnoException;
      storageLog({
        level: "error",
        message: "image asset write failed",
        code: "IMAGE_STORE_FAILED",
        correlationId: opts.correlationId,
        stack_trace: e?.stack,
        context: { module: IMAGE_SOURCE, relPath, errno: e?.code, errorMessage: e?.message },
      });
    }
    throw err;
  }
}

/**
 * FIX-SEC N-07 / IP-47 (SR-57, D-247): salinan tata letak datar
 * `assets/<sha>.<ext>` yang masih dibaca pembaca lama (renderer figur DOCX,
 * pembungkus, ingest v1, cadangan D-175) dibuat sebagai HARD LINK ke berkas
 * shard `srcRelPath`, bukan salinan byte kedua: pembaca tidak berubah, tetapi
 * disk hanya menyimpan isi sekali. Bila link tidak didukung (sistem berkas
 * tanpa hard link, beda volume, izin) jatuh ke tulis atomik biasa
 * (`writeAssetFile`). Berkas tujuan yang sudah ada dengan sha256 sama tidak
 * disentuh; isi berbeda (rusak) diganti lewat tulis atomik.
 */
export async function linkAssetCopy(
  srcRelPath: string,
  dstRelPath: string,
  bytes: Uint8Array,
  sha256: string,
  opts: { correlationId?: string } = {},
): Promise<{ created: boolean; linked: boolean }> {
  const src = resolveSafe(srcRelPath);
  const dst = resolveSafe(dstRelPath);
  try {
    await mkdir(path.dirname(dst), { recursive: true });
    await assertRealInsideRoot(path.dirname(dst));
    await assertRealInsideRoot(src);
    if (await existingMatches(dst, dstRelPath, sha256)) return { created: false, linked: false };
    await link(src, dst);
    return { created: true, linked: true };
  } catch (err) {
    if (err instanceof StudioEngineError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && (await existingMatches(dst, dstRelPath, sha256).catch(() => false))) {
      return { created: false, linked: false };
    }
    storageLog({
      level: "info",
      message: "asset hard link unavailable; writing a regular copy",
      code: "IMAGE_LINK_FALLBACK",
      correlationId: opts.correlationId,
      context: { module: IMAGE_SOURCE, relPath: dstRelPath, errno: code },
    });
    const w = await writeAssetFile(dstRelPath, bytes, sha256, opts);
    return { created: w.created, linked: false };
  }
}

/**
 * Simpan gambar yang SUDAH didekode (`decodeImage`) ke `assets/`. Byte
 * diverifikasi ulang (sha256) agar pemanggil tidak dapat menyimpan isi yang
 * berbeda dari klaimnya.
 */
export async function storeImageAsset(img: DecodedImage, opts: { correlationId?: string } = {}): Promise<StoredImageAsset> {
  const sha256 = sha256Hex(img.bytes);
  if (sha256 !== img.sha256) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "image bytes do not match the decoded sha256", { reason: "sha256_mismatch" });
  }
  const relPath = assetRelPath(sha256, img.mime);
  const asset: StoredImageAsset["asset"] = {
    kind: "raster",
    mime: img.mime,
    sha256,
    path: assetFileName(sha256, img.mime),
    widthPx: img.widthPx,
    heightPx: img.heightPx,
  };
  const { created } = await writeAssetFile(relPath, img.bytes, sha256, opts);
  if (!created) return { asset, relPath, bytes: img.bytes.byteLength, created: false };
  storageLog({
    level: "info",
    message: "image asset stored",
    code: "IMAGE_STORED",
    correlationId: opts.correlationId,
    context: { module: IMAGE_SOURCE, relPath, bytes: img.bytes.byteLength, mime: img.mime, widthPx: img.widthPx, heightPx: img.heightPx },
  });
  return { asset, relPath, bytes: img.bytes.byteLength, created: true };
}

/**
 * Baca aset tersimpan menurut `AssetRef` (path relatif akar aset, atau
 * diturunkan dari sha256 + mime), dekode ulang (sniff + batas) dan cocokkan
 * sha256 serta mime dengan yang terdaftar.
 */
export async function readImageAsset(ref: Pick<AssetRef, "sha256" | "mime" | "path">): Promise<DecodedImage & { relPath: string }> {
  const want = typeof ref.sha256 === "string" ? ref.sha256.toLowerCase() : "";
  if (!SHA256_RE.test(want)) throw new StudioEngineError("SCHEMA_INVALID", "asset sha256 must be 64 hex characters", { reason: "sha256_format" });
  let relPath: string;
  if (typeof ref.path === "string" && ref.path) {
    const rel = ref.path.replace(/\\/g, "/").replace(/^\/+/, "");
    relPath = toRelPath(rel.startsWith(`${ASSETS_DIR}/`) ? rel : `${ASSETS_DIR}/${rel}`);
    if (relPath.split("/")[0] !== ASSETS_DIR) throw new StudioEngineError("PATH_OUTSIDE_ROOT", "asset path must be under assets/", { reason: "not_assets_layout" });
  } else {
    relPath = assetRelPath(want, ref.mime);
  }
  const stored = await readStoredFile(relPath);
  const img = decodeImageDetailed({ bytes: new Uint8Array(stored.data.buffer, stored.data.byteOffset, stored.data.byteLength) });
  if (img.sha256 !== want) {
    storageLog({ level: "warn", message: "stored image sha256 differs from reference", code: "IMAGE_SHA_MISMATCH", context: { module: IMAGE_SOURCE, relPath } });
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "stored image content does not match its sha256", { relPath, reason: "sha256_mismatch" });
  }
  if (ref.mime && img.mime !== ref.mime) {
    throw new StudioEngineError("ASSET_TYPE_UNSUPPORTED", `stored image is ${img.mime} but registered as ${ref.mime}`, { relPath, reason: "mime_mismatch" });
  }
  return { mime: img.mime, widthPx: img.widthPx, heightPx: img.heightPx, bytes: img.bytes, sha256: img.sha256, relPath };
}
