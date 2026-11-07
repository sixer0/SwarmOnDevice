/**
 * Aset gambar dokumen v2 (SR-19, register I52, model M13 `StudioAsset`).
 *
 * - `storeAsset`: unggah idempoten (R18 `POST /api/studio/assets`, kiriman
 *   `assets` base64). Dekode + batas memakai helper TUNGGAL jalur artefak
 *   `decodeImageDetailed` (D-134 FIX-1 M-02): sisi > 20.000 px atau > 80 MP
 *   -> 413 `ASSET_TOO_LARGE`; selain PNG/JPEG -> 415 `ASSET_TYPE_UNSUPPORTED`;
 *   masukan rusak -> 400 `SCHEMA_INVALID` (D-61). MIME klien diabaikan
 *   (diambil dari magic bytes). Dedupe per sha256: unggah ulang = baris yang
 *   sama, `created: false`.
 * - `resolveAssetRef`: `sha256:<hex>` (C27) atau kunci lokal `assets` kiriman
 *   (C26) -> baris M13; tak dikenal -> 422 `ASSET_NOT_FOUND`.
 * - `resolveSubmissionAssets`: peta `assets` kiriman -> baris M13 (base64
 *   disimpan, `assetRef` dicari), untuk ingest v2 (SR-12) dan route.
 *
 * Berkas: tata letak C33c `assets/<sha[0..2]>/<sha>.<ext>` (= `relPath` M13)
 * DAN entri tata letak datar `assets/<sha>.<ext>` yang masih dibaca renderer
 * figur dan ingest v1 (D-61, D-63). FIX-SEC N-07/IP-47: entri datar kini hard
 * link ke berkas shard (isi disimpan sekali; cadangan salinan biasa bila link
 * tidak didukung). Berkas beralamat isi ditulis sebelum baris DB; bila
 * transaksi pemanggil di-rollback, berkas yatim tidak berbahaya (unggah
 * berikutnya memakainya ulang).
 *
 * Kuota (FIX-SEC N-07, SR-57, D-247), hanya untuk aset BARU (sha256 belum
 * terdaftar; dedupe tidak dihitung), ditegakkan di layanan sehingga berlaku
 * untuk R18 maupun `assets` base64 kiriman:
 * - byte aset baru per pemanggil dalam jendela bergulir 24 jam, dihitung dari
 *   baris M13 (`createdBy`, `createdAt`; tahan restart). Sesi HQ/Google per
 *   requester: bawaan 512 MiB (`STUDIO_ASSET_QUOTA_BYTES_PER_DAY`) = 25 aset
 *   ukuran maksimum 20 MiB atau ratusan gambar dokumen biasa per hari.
 *   Pemegang `x-internal-secret` berbagi SATU ember (agentId hanya label yang
 *   dapat dipalsukan): bawaan 2 GiB (`STUDIO_ASSET_QUOTA_INTERNAL_BYTES_PER_DAY`).
 *   Melebihi -> 429 `RATE_LIMITED` (`reason: "asset_quota_exceeded"`,
 *   `Retry-After`). Unggah serentak dapat melampaui sedikit (dibatasi laju
 *   60/menit route).
 * - ruang disk kosong volume akar Studio setelah tulis minimal
 *   `STUDIO_ASSET_MIN_FREE_BYTES` (bawaan 2 GiB, cadangan untuk DB, log, dan
 *   keluaran render); selain itu 500 `STORAGE_WRITE_FAILED`
 *   (`reason: "insufficient_disk_space"`; kontrak belum punya kode 507).
 *
 * Semua akses DB lewat `opts.db` (klien transaksi pemanggil) atau impor malas
 * klien DB, agar graf impor modul gambar murni tetap bebas DB (Swarm: see below).
 *
 * Swarm patch (row 109, Prisma cut; 01_specs_studio.md §1.2 site 2): rows are the DATUM Studio
 * store's `asset` table (`StudioStore.putAsset` / `getAsset`, content-addressed
 * `assets/<sha[0..2]>/<sha>.<ext>`); `opts.db` is the caller's store transaction.
 */
import { statfs } from "node:fs/promises";
import { activeTx, assetOf, readWith, studioStore, type SqlParam, type StudioAsset, type StudioTx } from "../_swarm-store";
import type { StudioCaller } from "../../contract/auth";
import { ASSET_KEY_PATTERN, ASSET_REF_PATTERN, getStudioEnv } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import type { AssetDtoV2 } from "../../contract/types/v2/api";
import type { AssetInputV2 } from "../../contract/types/v2/common";
import { storageLog } from "../storage";
import { decodeImageDetailed, IMAGE_SOURCE, type DecodedImageDetail } from "./decode";
import { assetRelPath, assetShardRelPath, linkAssetCopy, writeAssetFile } from "./store";

/** Baris M13 (tipe internal modul, register §0: tidak diekspor dari kontrak). */
export type StudioAssetRow = StudioAsset;

/** Klien DB minimum: transaksi store pemanggil (Swarm). */
export type StudioAssetDb = StudioTx;

export interface AssetStoreOptions {
  /** Klien transaksi pemanggil; tanpa ini dipakai `prisma` global. */
  db?: StudioAssetDb;
  correlationId?: string;
}

/** Masukan `storeAsset`: bentuk kiriman v2 atau byte mentah (multipart/berkas). */
export type StoreAssetInput = AssetInputV2 | { file: Uint8Array; mime?: string };

const ASSET_REF_RE = new RegExp(ASSET_REF_PATTERN);
const ASSET_KEY_RE = new RegExp(ASSET_KEY_PATTERN);
const BARE_SHA_RE = /^[0-9a-f]{64}$/;
const MISSION_FOLDER_MAX = 200;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const MIB = 1024 * 1024;
export const ASSET_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ASSET_QUOTA_BYTES_PER_DAY_DEFAULT = 512 * MIB;
export const ASSET_QUOTA_INTERNAL_BYTES_PER_DAY_DEFAULT = 2048 * MIB;
export const ASSET_MIN_FREE_BYTES_DEFAULT = 2048 * MIB;
/** Prefiks/nilai requester agen internal (sama dengan `contract/auth`; disalin agar modul ini tetap bebas next-auth). */
const INTERNAL_REQUESTER_PREFIX = "agent:";
const INTERNAL_ANONYMOUS_REQUESTER = "anonymous-internal";

function envBytes(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

export interface AssetQuotaLimits {
  /** Byte aset baru per requester sesi per 24 jam. */
  perCallerBytes: number;
  /** Byte aset baru per 24 jam untuk seluruh pemanggil internal (satu ember). */
  internalBytes: number;
  /** Ruang kosong minimum yang harus tersisa di volume akar setelah tulis. */
  minFreeBytes: number;
}

export function assetQuotaLimits(): AssetQuotaLimits {
  return {
    perCallerBytes: envBytes("STUDIO_ASSET_QUOTA_BYTES_PER_DAY", ASSET_QUOTA_BYTES_PER_DAY_DEFAULT, MIB),
    internalBytes: envBytes("STUDIO_ASSET_QUOTA_INTERNAL_BYTES_PER_DAY", ASSET_QUOTA_INTERNAL_BYTES_PER_DAY_DEFAULT, MIB),
    minFreeBytes: envBytes("STUDIO_ASSET_MIN_FREE_BYTES", ASSET_MIN_FREE_BYTES_DEFAULT, 0),
  };
}

export interface AssetQuotaScope {
  /** SQL condition on `asset` rows of this bucket (was a Prisma `where`), with its parameters. */
  where: { sql: string; params: SqlParam[] };
  limitBytes: number;
  bucket: "caller" | "internal";
}

/** Ember kuota pemanggil: `where` baris M13 miliknya + batas byte. */
export function assetQuotaScope(caller: Pick<StudioCaller, "kind" | "requester">, limits: AssetQuotaLimits = assetQuotaLimits()): AssetQuotaScope {
  if (caller.kind === "INTERNAL_AGENT") {
    return {
      where: { sql: "(substr(created_by, 1, ?) = ? OR created_by = ?)", params: [INTERNAL_REQUESTER_PREFIX.length, INTERNAL_REQUESTER_PREFIX, INTERNAL_ANONYMOUS_REQUESTER] },
      limitBytes: limits.internalBytes,
      bucket: "internal",
    };
  }
  return { where: { sql: "created_by = ?", params: [caller.requester] }, limitBytes: limits.perCallerBytes, bucket: "caller" };
}

export interface AssetQuotaOptions {
  correlationId?: string;
  now?: number;
  limits?: AssetQuotaLimits;
  /** Sumber byte kosong (uji); bawaan `statfs` akar Studio. */
  freeBytes?: () => Promise<number | null>;
}

/** Byte kosong volume akar Studio; null bila tidak terbaca (cek dilewati, dicatat). */
async function workspaceFreeBytes(): Promise<number | null> {
  try {
    const st = await statfs(getStudioEnv().workspaceRoot);
    return Number(st.bavail) * Number(st.bsize);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    storageLog({
      level: "warn",
      message: "free disk space check unavailable",
      code: "IMAGE_ASSET_DISK_CHECK_FAILED",
      context: { module: IMAGE_SOURCE, errno: e?.code, errorMessage: e?.message },
    });
    return null;
  }
}

/**
 * Tolak aset baru bila kuota 24 jam pemanggil terlampaui (429 RATE_LIMITED)
 * atau ruang disk tidak cukup (500 STORAGE_WRITE_FAILED). Hanya dipanggil
 * untuk sha256 yang belum terdaftar.
 */
export async function assertAssetQuota(
  caller: Pick<StudioCaller, "kind" | "requester">,
  newBytes: number,
  db: StudioAssetDb,
  opts: AssetQuotaOptions = {},
): Promise<void> {
  const limits = opts.limits ?? assetQuotaLimits();
  const now = opts.now ?? Date.now();
  const scope = assetQuotaScope(caller, limits);
  const since = new Date(now - ASSET_QUOTA_WINDOW_MS);
  const agg = db.get<{ used: number | null; oldest: number | null }>(
    `SELECT sum(bytes) AS used, min(time_created) AS oldest FROM asset WHERE ${scope.where.sql} AND time_created >= ?`,
    [...scope.where.params, since.getTime()],
  );
  const usedBytes = Number(agg?.used ?? 0);
  if (usedBytes + newBytes > scope.limitBytes) {
    const oldest = agg?.oldest !== null && agg?.oldest !== undefined ? Number(agg.oldest) : now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + ASSET_QUOTA_WINDOW_MS - now) / 1000));
    storageLog({
      level: "warn",
      message: "asset upload quota exceeded",
      code: "IMAGE_ASSET_QUOTA_EXCEEDED",
      correlationId: opts.correlationId,
      context: { module: IMAGE_SOURCE, callerKind: caller.kind, bucket: scope.bucket, usedBytes, requestedBytes: newBytes, quotaBytes: scope.limitBytes },
    });
    throw new StudioEngineError("RATE_LIMITED", `Asset upload quota exceeded: at most ${scope.limitBytes} bytes of new assets per 24 hours`, {
      reason: "asset_quota_exceeded",
      bucket: scope.bucket,
      quotaBytes: scope.limitBytes,
      usedBytes,
      requestedBytes: newBytes,
      windowHours: 24,
      retryAfterSec,
    });
  }
  const free = await (opts.freeBytes ?? workspaceFreeBytes)();
  // Entri datar biasanya hard link (isi sekali); cadangan salinan biasa menulis dua kali.
  if (free !== null && free - 2 * newBytes < limits.minFreeBytes) {
    storageLog({
      level: "error",
      message: "insufficient free disk space for asset upload",
      code: "IMAGE_ASSET_DISK_LOW",
      correlationId: opts.correlationId,
      context: { module: IMAGE_SOURCE, freeBytes: free, requestedBytes: newBytes, minFreeBytes: limits.minFreeBytes },
    });
    throw new StudioEngineError("STORAGE_WRITE_FAILED", "Insufficient free disk space on the Studio workspace volume", {
      reason: "insufficient_disk_space",
    });
  }
}

/** Run `fn` on the caller's tx, the job this call runs in, or a job of its own. */
function withDb<T>(opts: AssetStoreOptions, fn: (db: StudioAssetDb) => T | Promise<T>): Promise<T> {
  return readWith(opts.db ?? activeTx(), fn);
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new StudioEngineError("SCHEMA_INVALID", message, details);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** DTO R18 (tanpa path berkas). */
export function toAssetDto(row: StudioAssetRow): AssetDtoV2 {
  return {
    sha256: row.sha256,
    mime: row.mime === "image/jpeg" ? "image/jpeg" : "image/png",
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    bytes: row.bytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `sha256:<hex>` (C27) dari baris/sha. */
export function assetRefOf(sha256: string): string {
  return `sha256:${sha256.toLowerCase()}`;
}

function normalizeMissionFolder(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") invalid("missionFolder must be a string", { reason: "mission_folder_type" });
  const s = v.trim();
  if (s === "") return null;
  if (s.length > MISSION_FOLDER_MAX || CONTROL_CHAR_RE.test(s)) {
    invalid("missionFolder is invalid", { reason: "mission_folder_format", maxLength: MISSION_FOLDER_MAX });
  }
  return s;
}

/** Cari baris M13 per sha256; `null` bila tidak ada. */
export async function findAssetBySha(sha256: string, opts: AssetStoreOptions = {}): Promise<StudioAssetRow | null> {
  const sha = sha256.toLowerCase();
  if (!BARE_SHA_RE.test(sha)) invalid("sha256 must be 64 hex characters", { reason: "sha256_format" });
  return withDb(opts, (db) => {
    const r = db.get("SELECT * FROM asset WHERE sha256 = ?", [sha]);
    return r ? assetOf(r) : null;
  });
}

function notFound(ref: string, reason: "unknown_sha256" | "unknown_local_key"): never {
  storageLog({ level: "warn", message: "asset reference not found", code: "IMAGE_ASSET_NOT_FOUND", context: { module: IMAGE_SOURCE, ref, reason } });
  throw new StudioEngineError("ASSET_NOT_FOUND", `asset ${ref} is not known`, { ref, reason });
}

export interface ResolveAssetRefOptions extends AssetStoreOptions {
  /** Aset kiriman yang sudah diresolusi (`resolveSubmissionAssets`): kunci lokal -> baris. */
  local?: ReadonlyMap<string, StudioAssetRow> | Readonly<Record<string, StudioAssetRow>>;
}

function localLookup(local: ResolveAssetRefOptions["local"], key: string): StudioAssetRow | undefined {
  if (!local) return undefined;
  if (local instanceof Map) return local.get(key);
  const rec = local as Readonly<Record<string, StudioAssetRow>>;
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;
}

/**
 * I52: rujukan aset -> baris M13. Urutan: `sha256:<hex>` (C27) dicari di DB;
 * kunci lokal (C26) dicari di `opts.local`; 64 heksa polos yang bukan kunci
 * lokal diperlakukan sebagai sha256 (AD-14 "sha256 saja"). Tak dikenal ->
 * 422 `ASSET_NOT_FOUND`; bentuk lain -> 400 `SCHEMA_INVALID`.
 */
export async function resolveAssetRef(ref: string, opts: ResolveAssetRefOptions = {}): Promise<StudioAssetRow> {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 71) {
    invalid("asset reference must be sha256:<hex> or an asset key", { reason: "asset_ref_format" });
  }
  if (ASSET_REF_RE.test(ref)) {
    const row = await findAssetBySha(ref.slice("sha256:".length), opts);
    return row ?? notFound(ref, "unknown_sha256");
  }
  if (ASSET_KEY_RE.test(ref)) {
    const hit = localLookup(opts.local, ref);
    if (hit) return hit;
    if (BARE_SHA_RE.test(ref)) {
      const row = await findAssetBySha(ref, opts);
      return row ?? notFound(assetRefOf(ref), "unknown_sha256");
    }
    return notFound(ref, "unknown_local_key");
  }
  return invalid("asset reference must be sha256:<hex> or an asset key", { reason: "asset_ref_format" });
}

function decodeInput(input: StoreAssetInput): { img: DecodedImageDetail; declared?: string } {
  if (!isRecord(input)) invalid("asset input must be an object", { reason: "input_type" });
  if ("file" in input) {
    const declared = typeof input.mime === "string" ? input.mime.toLowerCase() : undefined;
    return { img: decodeImageDetailed({ bytes: input.file }), declared };
  }
  if ("dataBase64" in input) {
    if (typeof input.dataBase64 !== "string") invalid("dataBase64 must be a string", { reason: "base64_not_string" });
    const declared = typeof input.mime === "string" ? input.mime.toLowerCase() : undefined;
    return { img: decodeImageDetailed({ base64: input.dataBase64 }), declared };
  }
  return invalid("asset input needs assetRef, dataBase64 or file", { reason: "input_shape" });
}

/**
 * Simpan/dedupe satu aset dan kembalikan barisnya. `assetRef` hanya dicari
 * (tidak membuat baris). Penyisipan memakai `ON CONFLICT DO NOTHING`
 * (`skipDuplicates`) agar unggah serentak dan pemakaian di dalam transaksi
 * pemanggil tidak membatalkan transaksi.
 */
export async function storeAssetRow(
  caller: StudioCaller,
  input: StoreAssetInput,
  missionFolder?: string | null,
  opts: AssetStoreOptions = {},
): Promise<{ row: StudioAssetRow; created: boolean }> {
  if (isRecord(input) && "assetRef" in input) {
    if (typeof input.assetRef !== "string" || !ASSET_REF_RE.test(input.assetRef)) {
      invalid("assetRef must be sha256:<64 hex>", { reason: "asset_ref_format" });
    }
    return { row: await resolveAssetRef(input.assetRef, opts), created: false };
  }
  if (!caller || typeof caller.requester !== "string" || caller.requester.trim() === "") {
    invalid("caller requester is required", { reason: "caller_missing" });
  }
  const { img, declared } = decodeInput(input);
  if (declared && declared !== img.mime && !(declared === "image/jpg" && img.mime === "image/jpeg")) {
    storageLog({ level: "warn", message: "declared asset type differs from sniffed type", code: "IMAGE_TYPE_MISMATCH", correlationId: opts.correlationId, context: { module: IMAGE_SOURCE, declared, sniffed: img.mime } });
  }
  const folder = normalizeMissionFolder(missionFolder);
  const relPath = assetShardRelPath(img.sha256, img.mime);

  // Kuota + ruang disk hanya untuk aset baru (dedupe tidak menambah byte).
  const known = await withDb(opts, (db) => db.get("SELECT id FROM asset WHERE sha256 = ?", [img.sha256]));
  if (!known) await withDb(opts, (db) => assertAssetQuota(caller, img.bytes.byteLength, db, { correlationId: opts.correlationId }));

  await writeAssetFile(relPath, img.bytes, img.sha256, opts);
  await linkAssetCopy(relPath, assetRelPath(img.sha256, img.mime), img.bytes, img.sha256, opts);

  try {
    // `putAsset` = INSERT ... ON CONFLICT(sha256) DO NOTHING (the clone's skipDuplicates) after a
    // write-once of the same bytes at the same content address.
    const mime = img.mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const tx = opts.db ?? activeTx();
    const stored = await studioStore().putAsset(img.bytes, { mime, widthPx: img.widthPx, heightPx: img.heightPx, missionFolder: folder, createdBy: caller.requester }, tx);
    const row = assetOf(stored as unknown as Record<string, unknown>);
    if (row.relPath !== relPath) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "asset row path differs from the content address", { sha256: img.sha256, reason: "row_path" });
    }
    const created = !known;
    storageLog({
      level: "info",
      message: created ? "studio asset registered" : "studio asset deduplicated",
      code: created ? "IMAGE_ASSET_CREATED" : "IMAGE_ASSET_DEDUPED",
      correlationId: opts.correlationId,
      context: { module: IMAGE_SOURCE, assetId: row.id, relPath, bytes: row.bytes, mime: row.mime, widthPx: row.widthPx, heightPx: row.heightPx },
    });
    return { row, created };
  } catch (err) {
    const e = err as Error & { code?: string };
    storageLog({
      level: "error",
      message: "studio asset db write failed",
      code: "IMAGE_ASSET_DB_FAILED",
      correlationId: opts.correlationId,
      stack_trace: e?.stack,
      context: { module: IMAGE_SOURCE, relPath, prismaCode: e?.code, errorMessage: e?.message },
    });
    throw err;
  }
}

/** I52: unggah idempoten; `created: false` bila sha256 sudah terdaftar (route: 200, selain itu 201). */
export async function storeAsset(
  caller: StudioCaller,
  input: StoreAssetInput,
  missionFolder?: string,
  opts: AssetStoreOptions = {},
): Promise<{ asset: AssetDtoV2; created: boolean }> {
  const { row, created } = await storeAssetRow(caller, input, missionFolder, opts);
  return { asset: toAssetDto(row), created };
}

/**
 * Resolusi `assets` kiriman (C26 kunci -> AssetInputV2): base64 disimpan
 * (dedupe), `assetRef` dicari. Hasil dipakai sebagai `opts.local`
 * `resolveAssetRef` untuk medan `asset` blok. Galat membawa `assetKey` dan
 * `pointer` (`/assets/<kunci>`).
 */
export async function resolveSubmissionAssets(
  caller: StudioCaller,
  assets: Readonly<Record<string, AssetInputV2>> | undefined,
  opts: AssetStoreOptions & { missionFolder?: string | null } = {},
): Promise<Map<string, StudioAssetRow>> {
  const out = new Map<string, StudioAssetRow>();
  if (assets === undefined || assets === null) return out;
  if (!isRecord(assets)) invalid("assets must be an object", { reason: "assets_type", pointer: "/assets" });
  for (const [key, input] of Object.entries(assets)) {
    const pointer = `/assets/${key}`;
    if (!ASSET_KEY_RE.test(key)) invalid(`asset key "${key}" is invalid`, { reason: "asset_key_format", pointer });
    try {
      out.set(key, (await storeAssetRow(caller, input, opts.missionFolder, opts)).row);
    } catch (err) {
      if (err instanceof StudioEngineError) {
        const base = isRecord(err.details) ? err.details : { detail: err.details };
        throw new StudioEngineError(err.code, err.message, { ...base, assetKey: key, pointer });
      }
      throw err;
    }
  }
  return out;
}
