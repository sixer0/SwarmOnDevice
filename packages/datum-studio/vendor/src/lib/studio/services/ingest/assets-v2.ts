/**
 * Aset kiriman `studio.doc/v2` di ingest (SR-12; register §4.5 T2-06/T2-28,
 * §11.1 butir 8; D-134 batas piksel; D-175 tata letak aset SR-19).
 *
 * Tahap rencana (`planV2Assets`) MURNI BACA dan aman untuk dryRun:
 *  - `assets[k]` base64 -> didekode lewat helper jalur artefak yang sama
 *    (`decodeImageDetailed`: sniff PNG/JPEG + `IMAGE_MAX_SIDE_PX`/`IMAGE_MAX_PIXELS`);
 *  - `assets[k]` `{assetRef}` -> baris M13 (`findAssetBySha`), atau berkas ber-path
 *    adaptor v1 (`assetPaths`, di bawah akar aset), atau sumber harness, atau
 *    berkas datar lama `<akar aset>/<sha>.<ext>` (revisi lama);
 *  - `image.asset` yang bukan kunci `assets` dan bukan rujukan langsung dicari di
 *    sumber harness (indeks figur S94) lalu DITAMBAHKAN ke `assets` kiriman.
 * Tahap simpan (`storePlannedAssets`) menulis byte yang belum terdaftar ke
 * `StudioAsset` lewat SR-19 (`storeAssetRow`, idempoten per sha256).
 */
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import {
  ASSET_REF_PATTERN,
  STUDIO_MAX_ASSET_BYTES,
  isPathInside,
  type AssetInputV2,
  type StudioDocV2,
  type ValidationIssue,
} from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { StudioEngineError } from "../../contract/errors";
import type { ComposeAssetInfo } from "../compose";
import { decodeImageDetailed, type DecodedImageDetail } from "../images/decode";
import { assetShardRelPath } from "../images/store";
import { ASSET_TOO_LARGE_KEYWORD, assetStoreRoot, type IngestAssetSource } from "./assets";
import { ingestLog } from "./log";
import { isObject, joinPointer, sha256Hex } from "./util";

/** Kata kunci isu aset tak dikenal (ingest -> 422 `ASSET_NOT_FOUND`). */
export const ASSET_NOT_FOUND_KEYWORD = "assetNotFound";
/** Kata kunci isu jenis aset tidak didukung (ingest -> 415 `ASSET_TYPE_UNSUPPORTED`). */
export const ASSET_TYPE_KEYWORD = "assetTypeUnsupported";

const ASSET_REF_RE = new RegExp(ASSET_REF_PATTERN);

export interface PlannedAsset {
  sha256: string;
  mime: "image/png" | "image/jpeg";
  widthPx?: number;
  heightPx?: number;
  /** `StudioAsset.relPath` (baris ada) atau tata letak C33c yang akan ditulis SR-19. */
  relPath: string;
  /** Byte yang belum terdaftar di M13 (harus disimpan sebelum revisi ditulis). */
  bytes?: Uint8Array;
  origin: "dataBase64" | "db" | "path" | "source" | "store";
}

export interface V2AssetPlan {
  /** Per sha256 heksa kecil. */
  bySha: Map<string, PlannedAsset>;
  /** Kunci `assets` kiriman -> `sha256:<hex>`. */
  refs: Map<string, string>;
  /** Kunci yang ditambahkan dari sumber harness (bentuk `{assetRef}`). */
  added: Record<string, { assetRef: string }>;
  issues: ValidationIssue[];
}

export interface PlanV2AssetsInput {
  doc: StudioDocV2;
  pointerPrefix: string;
  sources: readonly IngestAssetSource[];
  /** Aset ber-path hasil adaptor v1 (kunci v2 -> path relatif akar aset). */
  assetPaths?: Readonly<Record<string, { path: string; sha256: string; mime: "image/png" | "image/jpeg" }>>;
  /** Pencarian baris M13 per sha (null = tidak ada atau DB tidak tersedia). */
  lookupSha: (sha256: string) => Promise<{ mime: string; widthPx: number; heightPx: number; relPath: string } | null>;
  correlationId: string;
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

function mimeOf(m: string): "image/png" | "image/jpeg" {
  return m === "image/jpeg" ? "image/jpeg" : "image/png";
}

/** Dekode + batas piksel; galat dipetakan ke isu siap pakai. */
function decode(input: { base64?: string; bytes?: Uint8Array }, key: string, ptr: string): DecodedImageDetail | ValidationIssue {
  try {
    return decodeImageDetailed(input);
  } catch (e) {
    if (!(e instanceof StudioEngineError)) throw e;
    const det = (isObject(e.details) ? e.details : {}) as { reason?: unknown; widthPx?: unknown; heightPx?: unknown };
    const keyword = e.code === "ASSET_TOO_LARGE" ? ASSET_TOO_LARGE_KEYWORD : e.code === "ASSET_TYPE_UNSUPPORTED" ? ASSET_TYPE_KEYWORD : "asset";
    return {
      pointer: ptr,
      keyword,
      message: `Aset "${key}": ${e.message}`,
      ...(typeof det.reason === "string" ? { reason: det.reason } : {}),
      ...(typeof det.widthPx === "number" ? { widthPx: det.widthPx } : {}),
      ...(typeof det.heightPx === "number" ? { heightPx: det.heightPx } : {}),
    } as ValidationIssue;
  }
}

function isIssue(v: DecodedImageDetail | ValidationIssue): v is ValidationIssue {
  return "pointer" in v;
}

/** Semua blok `image` dengan medan `asset` beserta pointer (rekursif, melewati `assets` dan `x`). */
function imageRefs(node: unknown, ptr: string, out: Array<{ asset: string; pointer: string }>): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => imageRefs(n, joinPointer(ptr, i), out));
    return;
  }
  if (!isObject(node)) return;
  if (node.type === "image" && typeof node.asset === "string") out.push({ asset: node.asset, pointer: joinPointer(ptr, "asset") });
  for (const [k, v] of Object.entries(node)) {
    if (k !== "assets" && k !== "x" && v !== null && typeof v === "object") imageRefs(v, joinPointer(ptr, k), out);
  }
}

/** Rencana aset kiriman v2 (tanpa tulis). */
export async function planV2Assets(i: PlanV2AssetsInput): Promise<V2AssetPlan> {
  const plan: V2AssetPlan = { bySha: new Map(), refs: new Map(), added: {}, issues: [] };
  let root: string | null = null;
  const storeRoot = (): string => (root ??= assetStoreRoot());
  const put = (a: PlannedAsset): void => {
    const prev = plan.bySha.get(a.sha256);
    // Baris M13 yang sudah ada diutamakan (tanpa byte = tidak ditulis ulang).
    if (!prev || (prev.bytes && !a.bytes)) plan.bySha.set(a.sha256, a);
  };
  const fromBytes = (bytes: Uint8Array, key: string, ptr: string, origin: PlannedAsset["origin"], wantSha?: string): string | null => {
    const d = decode({ bytes }, key, ptr);
    if (isIssue(d)) {
      plan.issues.push(d);
      return null;
    }
    if (wantSha && d.sha256 !== wantSha) {
      plan.issues.push({ pointer: ptr, keyword: "asset", message: `Aset "${key}": sha256 isi ${d.sha256} tidak sama dengan rujukan ${wantSha}` });
      return null;
    }
    put({ sha256: d.sha256, mime: d.mime, widthPx: d.widthPx, heightPx: d.heightPx, relPath: assetShardRelPath(d.sha256, d.mime), bytes: d.bytes, origin });
    return d.sha256;
  };
  const sourceBytes = (key: string | undefined, sha: string | undefined): Uint8Array | null => {
    const cands = [
      ...(key ? i.sources.filter((s) => s.key === key) : []),
      ...(sha ? i.sources.filter((s) => s.key !== key && s.sha256 === sha) : []),
    ];
    let fallback: Uint8Array | null = null;
    for (const s of cands) {
      const b = readCapped(s.absPath);
      if (!b) continue;
      if (!sha || sha256Hex(b) === sha) return b;
      fallback ??= b;
    }
    return sha ? null : fallback;
  };
  /** sha dikenal: M13 -> path adaptor -> sumber -> berkas datar lama. */
  const resolveSha = async (sha: string, key: string, ptr: string): Promise<boolean> => {
    if (plan.bySha.has(sha)) return true;
    const row = await i.lookupSha(sha);
    if (row) {
      put({ sha256: sha, mime: mimeOf(row.mime), widthPx: row.widthPx, heightPx: row.heightPx, relPath: row.relPath, origin: "db" });
      return true;
    }
    const ap = i.assetPaths?.[key];
    if (ap && ap.sha256 === sha) {
      const abs = path.resolve(storeRoot(), ap.path);
      if (!isPathInside(abs, storeRoot()) || abs === storeRoot()) {
        plan.issues.push({ pointer: ptr, keyword: "asset", message: `Path aset "${key}" keluar dari akar aset` });
        return false;
      }
      const b = readCapped(abs);
      if (b) return fromBytes(b, key, ptr, "path", sha) !== null;
    }
    const src = sourceBytes(key, sha);
    if (src) return fromBytes(src, key, ptr, "source", sha) !== null;
    for (const ext of ["png", "jpg"]) {
      const b = readCapped(path.resolve(storeRoot(), `${sha}.${ext}`));
      if (b) return fromBytes(b, key, ptr, "store", sha) !== null;
    }
    plan.issues.push({
      pointer: ptr,
      keyword: ASSET_NOT_FOUND_KEYWORD,
      message: `Aset "${key}" (sha256:${sha.slice(0, 12)}…) tidak dikenal; unggah dulu lewat POST /api/studio/assets atau sertakan dataBase64`,
    });
    return false;
  };

  // 1) Peta `assets` kiriman.
  for (const [key, raw] of Object.entries(i.doc.assets ?? {})) {
    const input = raw as AssetInputV2;
    const ptr = joinPointer(i.pointerPrefix, "assets", key);
    if ("dataBase64" in input) {
      const d = decode({ base64: input.dataBase64 }, key, joinPointer(ptr, "dataBase64"));
      if (isIssue(d)) {
        plan.issues.push(d);
        continue;
      }
      if (d.mime !== input.mime) {
        plan.issues.push({ pointer: joinPointer(ptr, "mime"), keyword: "asset", message: `Aset "${key}": isi ${d.mime} tetapi dinyatakan ${input.mime}` });
        continue;
      }
      put({ sha256: d.sha256, mime: d.mime, widthPx: d.widthPx, heightPx: d.heightPx, relPath: assetShardRelPath(d.sha256, d.mime), bytes: d.bytes, origin: "dataBase64" });
      plan.refs.set(key, `sha256:${d.sha256}`);
    } else if (typeof input.assetRef === "string" && ASSET_REF_RE.test(input.assetRef)) {
      const sha = input.assetRef.slice(7).toLowerCase();
      if (await resolveSha(sha, key, joinPointer(ptr, "assetRef"))) plan.refs.set(key, `sha256:${sha}`);
    }
  }

  // 2) Rujukan blok gambar.
  const refs: Array<{ asset: string; pointer: string }> = [];
  imageRefs(i.doc.sections ?? {}, joinPointer(i.pointerPrefix, "sections"), refs);
  for (const r of refs) {
    if (ASSET_REF_RE.test(r.asset)) {
      await resolveSha(r.asset.slice(7).toLowerCase(), r.asset, r.pointer);
      continue;
    }
    if (i.doc.assets && Object.prototype.hasOwnProperty.call(i.doc.assets, r.asset)) continue;
    if (plan.added[r.asset]) continue;
    const b = sourceBytes(r.asset, undefined);
    if (b) {
      const sha = fromBytes(b, r.asset, r.pointer, "source");
      if (sha) {
        plan.added[r.asset] = { assetRef: `sha256:${sha}` };
        plan.refs.set(r.asset, `sha256:${sha}`);
      }
      continue;
    }
    plan.issues.push({
      pointer: r.pointer,
      keyword: ASSET_NOT_FOUND_KEYWORD,
      message: `Gambar merujuk aset "${r.asset}" yang tidak ada di assets; sertakan asetnya`,
    });
  }
  if (plan.issues.length > 0) {
    ingestLog({ level: "warn", message: "aset kiriman v2 bermasalah", correlationId: i.correlationId, code: "ASSET_PLAN_ISSUES", context: { issues: plan.issues.length } });
  }
  return plan;
}

/** Metadata aset untuk compose (per sha256). */
export function composeAssetsOf(plan: V2AssetPlan): Record<string, ComposeAssetInfo> {
  const out: Record<string, ComposeAssetInfo> = {};
  for (const [sha, a] of plan.bySha) {
    out[sha] = { mime: a.mime, relPath: a.relPath, ...(a.widthPx !== undefined ? { widthPx: a.widthPx, heightPx: a.heightPx } : {}) };
  }
  return out;
}

/**
 * Simpan byte rencana yang belum terdaftar ke M13 lewat SR-19 (idempoten,
 * dedupe sha256). `skipDataBase64` = biarkan aset base64 disimpan layanan
 * kiriman (SR-13) agar tidak ditulis dua kali.
 */
export async function storePlannedAssets(
  caller: StudioCaller,
  plan: V2AssetPlan,
  opts: { missionFolder?: string | null; correlationId: string; skipDataBase64?: boolean },
): Promise<number> {
  const { storeAssetRow } = await import("../images/asset-store");
  let stored = 0;
  for (const a of plan.bySha.values()) {
    if (!a.bytes) continue;
    if (opts.skipDataBase64 && a.origin === "dataBase64") continue;
    const r = await storeAssetRow(caller, { file: a.bytes, mime: a.mime }, opts.missionFolder ?? null, { correlationId: opts.correlationId });
    if (r.row.relPath) a.relPath = r.row.relPath;
    stored += 1;
  }
  return stored;
}
