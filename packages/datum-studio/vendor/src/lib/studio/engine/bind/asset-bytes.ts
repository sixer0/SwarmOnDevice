/**
 * Sumber byte aset raster dokumen tunggal (IP-34, F-046) untuk renderer DOCX
 * (figur S19, pembungkus S18) dan HTML (S21-S24).
 *
 * Urutan: `ctx.assetBytes(ref.sha256, key)` (dipramuat layanan render S51
 * lewat `preloadAssetBytes`: dataBase64 dicek sha256, aset tersimpan dibaca
 * `readImageAsset` S53) lalu cadangan `ref.dataBase64`. Bila keduanya tidak
 * ada, pemanggil melanjutkan jalur lamanya sendiri (path akar aset, aset
 * templat, FigureStore) — helper ini tidak membaca disk.
 *
 * Isomorfik (tanpa impor `node:*`): dipakai juga oleh renderer HTML yang bisa
 * berjalan di klien. Lokasi netral `engine/bind` (INT-T, D-105): dulu
 * `engine/docx/figures/asset-bytes.ts`, sehingga HTML tidak lagi mengimpor dari
 * `engine/docx`.
 */
import type { AssetRef, RenderContext } from "../../contract";

export type DocAssetSource = "assetBytes" | "dataBase64";

export interface DocAssetBytes {
  ref: AssetRef;
  /** Byte aset; absen bila tidak ada di `assetBytes` maupun `dataBase64`. */
  bytes?: Uint8Array;
  source?: DocAssetSource;
  /** Base64 asli (tanpa spasi) bila `source` = dataBase64; dipakai HTML apa adanya. */
  base64?: string;
  /** `dataBase64` ada tetapi bukan base64 yang sah. */
  invalidBase64?: true;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Dekode base64 isomorfik; `undefined` bila kosong atau tidak sah. */
export function decodeBase64(s: string): Uint8Array | undefined {
  const clean = s.replace(/\s+/g, "");
  if (clean.length === 0 || !B64_RE.test(clean)) return undefined;
  const g = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(clean, "base64"));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Byte aset `doc.assets[key]`. `undefined` = kunci tidak terdaftar di aset
 * dokumen. Galat pencarian `assetBytes` tidak menggagalkan render: dicatat
 * (warn `ASSET_BYTES_LOOKUP_FAILED`) lalu cadangan dataBase64 dipakai.
 */
export function docAssetBytes(ctx: RenderContext, key: string, address?: string): DocAssetBytes | undefined {
  const ref: AssetRef | undefined = ctx.snapshot?.doc?.assets?.[key];
  if (!ref) return undefined;
  if (typeof ref.sha256 === "string" && ref.sha256 !== "" && typeof ctx.assetBytes === "function") {
    try {
      const bytes = ctx.assetBytes(ref.sha256, key);
      if (bytes && bytes.length > 0) return { ref, bytes, source: "assetBytes" };
    } catch (e) {
      ctx.log({
        level: "warn",
        code: "ASSET_BYTES_LOOKUP_FAILED",
        message: `aset "${key}": assetBytes gagal (${e instanceof Error ? e.message : String(e)}); cadangan dataBase64/path dipakai`,
        ...(address ? { address } : {}),
      });
    }
  }
  // dataBase64 kosong = tidak ada (perilaku lama `if (ref.dataBase64)`).
  if (typeof ref.dataBase64 === "string" && ref.dataBase64 !== "") {
    const bytes = decodeBase64(ref.dataBase64);
    if (!bytes) return { ref, invalidBase64: true };
    return { ref, bytes, source: "dataBase64", base64: ref.dataBase64.replace(/\s+/g, "") };
  }
  return { ref };
}
