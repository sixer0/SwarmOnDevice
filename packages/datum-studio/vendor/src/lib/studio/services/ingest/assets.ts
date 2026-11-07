/**
 * Resolusi aset raster dokumen (`doc.assets`) -> byte, verifikasi sha256 dan
 * jenis isi, lalu penempatan di penyimpanan beralamat-isi
 * `<STUDIO_WORKSPACE_ROOT>/assets/<sha256>.<png|jpg>` (§7.2; siaran D-49).
 *
 * Kontrak RenderContext tidak memiliki medan byte aset; renderer figur S19
 * (`resolveRasterAsset`) membaca `dataBase64`, lalu `assets/<path>` atau
 * `assets/<sha256>.<ext>`. Maka ingest MEMASTIKAN berkas beralamat-isi ada dan
 * menormalkan AssetRef di snapshot ke bentuk beralamat-isi (tanpa `path` dan
 * `dataBase64`), sehingga render ulang revisi mana pun deterministik.
 *
 * Sumber byte, berurutan: `dataBase64`; berkas penyimpanan (`assets/<path>`
 * atau `assets/<sha>.<ext>`); `sources` dari pemanggil (indeks figur
 * benchmark S94 atau daftar eksplisit, dicocokkan per kunci lalu per sha256).
 * Aset templat (`tpl.assets`) diresolusi renderer, bukan di sini.
 *
 * FIX-1 (S87 M-02): jenis isi dan batas piksel memakai helper yang SAMA dengan
 * jalur artefak (`decodeImageDetailed` services/images: sniff + header PNG/JPEG,
 * `IMAGE_MAX_SIDE_PX`, `IMAGE_MAX_PIXELS`) sebelum byte mencapai soffice atau
 * Chromium. Melewati batas -> isu ber-keyword `assetTooLarge` (route: 413
 * `ASSET_TOO_LARGE`, `details[].reason = "pixel_limit"`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  STUDIO_MAX_ASSET_BYTES,
  getStudioEnv,
  isPathInside,
  type AssetRef,
  type ResolvedTemplate,
  type StudioDocV1,
  type ValidationIssue,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { decodeImageDetailed } from "../images/decode";
import { isObject, joinPointer, sha256Hex } from "./util";

/** Kata kunci isu aset yang melewati batas ukuran/piksel (ingest -> 413 ASSET_TOO_LARGE). */
export const ASSET_TOO_LARGE_KEYWORD = "assetTooLarge";

/** Sumber byte aset di luar dokumen (mis. indeks figur benchmark). Path absolut. */
export interface IngestAssetSource {
  key?: string;
  sha256?: string;
  absPath: string;
}

export interface ResolvedAsset {
  key: string;
  sha256: string;
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  /** Path relatif akar aset penyimpanan (`<sha>.<ext>`). */
  storeRel: string;
  /** Dari mana byte diperoleh. */
  origin: "dataBase64" | "store" | "source";
}

export interface AssetResolution {
  assets: Map<string, ResolvedAsset>;
  issues: ValidationIssue[];
}

/**
 * Jenis isi + batas piksel lewat helper jalur artefak (satu sumber). Kembalian
 * `{ mime }` atau isu siap pakai (pointer `ptr`).
 */
function inspectRaster(key: string, bytes: Uint8Array, ptr: string): { mime: "image/png" | "image/jpeg" } | { issue: ValidationIssue } {
  try {
    const d = decodeImageDetailed({ bytes });
    return { mime: d.mime };
  } catch (e) {
    if (!(e instanceof StudioEngineError)) throw e;
    const det = (e.details ?? {}) as { reason?: unknown; widthPx?: unknown; heightPx?: unknown };
    if (e.code === "ASSET_TOO_LARGE") {
      return {
        issue: {
          pointer: ptr,
          keyword: ASSET_TOO_LARGE_KEYWORD,
          message: `Aset "${key}": ${e.message}`,
          reason: typeof det.reason === "string" ? det.reason : "asset_too_large",
          ...(typeof det.widthPx === "number" ? { widthPx: det.widthPx, heightPx: det.heightPx } : {}),
        } as ValidationIssue,
      };
    }
    return { issue: { pointer: ptr, keyword: "asset", message: `Aset "${key}" bukan PNG/JPEG sah menurut isi: ${e.message}` } };
  }
}

function extFor(mime: "image/png" | "image/jpeg"): string {
  return mime === "image/png" ? "png" : "jpg";
}

export function assetStoreRoot(): string {
  return path.resolve(getStudioEnv().workspaceRoot, "assets");
}

function readCapped(abs: string): Uint8Array | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > STUDIO_MAX_ASSET_BYTES) return null;
    return new Uint8Array(readFileSync(abs));
  } catch {
    return null;
  }
}

/**
 * Muat indeks aset dari berkas JSON (indeks figur S94). Bentuk diterima:
 * array entri atau `{ figures|assets|items: [...] }`; entri membawa `id`|`key`,
 * `sha256`, dan path berkas di `path`|`asset`|`file`|`relPath`|`media` (relatif
 * direktori indeks atau akar repo/cwd). Satu sumber per berkas yang ada;
 * entri tanpa berkas yang ada diabaikan.
 */
export function loadAssetIndex(indexPath: string): IngestAssetSource[] {
  const abs = path.resolve(indexPath);
  const raw: unknown = JSON.parse(readFileSync(abs, "utf8"));
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? ((["figures", "assets", "items"].map((k) => raw[k]).find(Array.isArray) as unknown[] | undefined) ?? [])
      : [];
  const dir = path.dirname(abs);
  const out: IngestAssetSource[] = [];
  for (const e of list) {
    if (!isObject(e)) continue;
    const rels = [e.path, e.asset, e.file, e.relPath, e.media].filter((v): v is string => typeof v === "string" && v !== "");
    // Path relatif direktori indeks, atau relatif akar repo (indeks S94 menulis `benchmark/...`).
    // Satu sumber per berkas yang ada: resolusi memilih yang sha256-nya cocok
    // (indeks S94 memuat `asset` = media asli dan `path` = turunan untuk figur tergambar).
    const key = [e.id, e.key].find((v): v is string => typeof v === "string" && v !== "");
    const sha256 = typeof e.sha256 === "string" ? e.sha256.toLowerCase() : undefined;
    const seen = new Set<string>();
    // Swarm patch (row 107, row 11 M4): no process.cwd()-relative candidate; paths resolve against the index directory only.
    for (const absPath of rels.map((r) => path.resolve(dir, r))) {
      if (seen.has(absPath) || !existsSync(absPath)) continue;
      seen.add(absPath);
      out.push({ key, sha256, absPath });
    }
  }
  return out;
}

/**
 * Resolusi semua `doc.assets` plus validasi rujukan blok `image.asset` dan
 * `device.asset` (kunci harus ada di aset dokumen atau aset templat).
 * Murni baca; penulisan ke penyimpanan lewat `storeResolvedAssets`.
 */
export function resolveDocAssets(
  doc: StudioDocV1,
  tpl: ResolvedTemplate | null,
  sources: readonly IngestAssetSource[],
  pointerPrefix: string,
): AssetResolution {
  const issues: ValidationIssue[] = [];
  const assets = new Map<string, ResolvedAsset>();
  const entries = isObject(doc.assets) ? Object.entries(doc.assets) : [];
  let root: string | null = null;
  const storeRoot = (): string => (root ??= assetStoreRoot());

  for (const [key, ref] of entries as Array<[string, AssetRef]>) {
    const ptr = joinPointer(pointerPrefix, "assets", key);
    const want = String(ref.sha256 ?? "").toLowerCase();
    let bytes: Uint8Array | null = null;
    let origin: ResolvedAsset["origin"] = "dataBase64";
    if (typeof ref.dataBase64 === "string" && ref.dataBase64 !== "") {
      const buf = Buffer.from(ref.dataBase64, "base64");
      if (buf.length > STUDIO_MAX_ASSET_BYTES) {
        issues.push({ pointer: joinPointer(ptr, "dataBase64"), keyword: ASSET_TOO_LARGE_KEYWORD, message: `Aset "${key}" ${buf.length} byte melebihi ${STUDIO_MAX_ASSET_BYTES}`, reason: "bytes_too_large" } as ValidationIssue);
        continue;
      }
      bytes = new Uint8Array(buf);
    }
    if (!bytes) {
      origin = "store";
      const rels = [ref.path, `${want}.${ref.mime === "image/jpeg" ? "jpg" : "png"}`].filter((v): v is string => typeof v === "string" && v !== "");
      for (const rel of rels) {
        const abs = path.resolve(storeRoot(), rel);
        if (!isPathInside(abs, storeRoot()) || abs === storeRoot()) {
          issues.push({ pointer: joinPointer(ptr, "path"), keyword: "asset", message: `Path aset "${key}" keluar dari akar aset` });
          continue;
        }
        bytes = readCapped(abs);
        if (bytes) break;
      }
    }
    if (!bytes) {
      origin = "source";
      const cands = [...sources.filter((s) => s.key === key), ...sources.filter((s) => s.key !== key && s.sha256 === want)];
      let fallback: Uint8Array | null = null;
      for (const s of cands) {
        const b = readCapped(s.absPath);
        if (!b) continue;
        if (sha256Hex(b) === want) {
          bytes = b;
          break;
        }
        fallback ??= b; // tidak cocok: dilaporkan bila tidak ada kandidat yang cocok
      }
      bytes ??= fallback;
    }
    if (!bytes) {
      issues.push({
        pointer: ptr,
        keyword: "asset",
        message: `Byte aset "${key}" (sha256 ${want}) tidak ditemukan: sertakan dataBase64, unggah ke penyimpanan aset, atau berikan indeks aset`,
      });
      continue;
    }
    const sha = sha256Hex(bytes);
    if (sha !== want) {
      issues.push({ pointer: joinPointer(ptr, "sha256"), keyword: "asset", message: `Aset "${key}": sha256 isi ${sha} tidak sama dengan terdaftar ${want}` });
      continue;
    }
    const inspected = inspectRaster(key, bytes, ptr);
    if ("issue" in inspected) {
      issues.push(inspected.issue);
      continue;
    }
    const mime = inspected.mime;
    if (mime !== ref.mime) {
      issues.push({ pointer: joinPointer(ptr, "mime"), keyword: "asset", message: `Aset "${key}": isi ${mime} tetapi terdaftar ${ref.mime}` });
      continue;
    }
    assets.set(key, { key, sha256: sha, mime, bytes, storeRel: `${sha}.${extFor(mime)}`, origin });
  }

  // Rujukan blok ke kunci aset.
  const known = (k: string) => (isObject(doc.assets) && k in doc.assets) || (tpl !== null && k in tpl.assets);
  const walk = (node: unknown, ptr: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, joinPointer(ptr, i)));
      return;
    }
    if (!isObject(node)) return;
    if ((node.type === "image" || node.type === "device") && typeof node.asset === "string" && !known(node.asset)) {
      issues.push({ pointer: joinPointer(ptr, "asset"), keyword: "reference", message: `Kunci aset "${node.asset}" tidak ada di assets dokumen maupun templat` });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k !== "x" && k !== "assets" && v !== null && typeof v === "object") walk(v, joinPointer(ptr, k));
    }
  };
  // Tanpa templat terselesaikan rujukan ke aset templat tidak dapat dinilai.
  if (tpl !== null) walk(doc, pointerPrefix);
  return { assets, issues };
}

/** Tulis aset ke penyimpanan beralamat-isi bila belum ada (atomik: tmp + rename). */
export function storeResolvedAssets(assets: ReadonlyMap<string, ResolvedAsset>): void {
  if (assets.size === 0) return;
  const root = assetStoreRoot();
  mkdirSync(root, { recursive: true });
  for (const a of assets.values()) {
    const abs = path.resolve(root, a.storeRel);
    if (!isPathInside(abs, root)) throw new Error(`Path aset keluar akar: ${a.storeRel}`);
    if (existsSync(abs)) {
      const cur = readCapped(abs);
      if (cur && sha256Hex(cur) === a.sha256) continue;
    }
    const tmp = `${abs}.${process.pid}.tmp`;
    writeFileSync(tmp, a.bytes);
    renameSync(tmp, abs);
  }
}

/**
 * Bentuk AssetRef beralamat-isi di snapshot: tanpa `path`/`dataBase64`
 * (byte ada di `assets/<sha>.<ext>`), sha256 huruf kecil. Hanya untuk aset
 * yang berhasil diresolusi.
 */
export function contentAddressAssets(doc: StudioDocV1, assets: ReadonlyMap<string, ResolvedAsset>): void {
  if (!isObject(doc.assets)) return;
  for (const [key, a] of assets) {
    const ref = doc.assets[key];
    if (!ref) continue;
    const next: AssetRef = { ...ref, sha256: a.sha256 };
    delete next.path;
    delete next.dataBase64;
    doc.assets[key] = next;
  }
}
