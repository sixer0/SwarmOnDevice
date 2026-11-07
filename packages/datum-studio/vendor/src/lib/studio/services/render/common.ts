/**
 * Utilitas bersama pipeline render revisi dan artefak (S51).
 */
import { createHash } from "node:crypto";
import type {
  AnyNormSnapshot,
  NormDocSnapshot,
  NormDocSnapshotV2,
  OutputFileDto,
  ParamValue,
  RenderContext,
  ResolvedTemplate,
  StudioCaller,
  StudioDocV1,
  StudioErrorCode,
  StudioOutputFormat,
  StudioTier,
  WriteOutputInput,
} from "../../contract";
import { StudioEngineError, StudioNotImplemented } from "../../contract/errors";
import { getBrowser } from "../../engine/browser";
import { HtmlAssembleError } from "../../engine/html/assemble";
import { checkOverrideRights } from "../../engine/tokens";
import { ALL_PARAMS } from "../../params";
import { effectiveInlinePolicy } from "../adapt-v1";
import { readImageAsset } from "../images";
import { applyDocOverrides } from "../ingest";
import { inlineFormatPolicyOf } from "../inline-format/policy";
import { checkTemplateWrite } from "../skeleton/access";
import { writeOutput } from "../storage";
import type { RenderJobHandle } from "./job";

/**
 * Kode galat untuk galat apa pun: `StudioEngineError` membawa kodenya sendiri;
 * galat lain memakai `fallback` pemanggil — kode generik kontrak (delta
 * S03-d1, D-52) `RENDER_FAILED` untuk perakitan/render dan
 * `STORAGE_WRITE_FAILED` untuk serah-terima penyimpanan.
 */
export function errorCodeOf(err: unknown, fallback: StudioErrorCode): StudioErrorCode {
  return err instanceof StudioEngineError ? err.code : fallback;
}

/** Galat perakitan HTML: `HtmlAssembleError` (S24) -> `HTML_RENDER_FAILED`, selain itu seperti `errorCodeOf`. */
export function htmlErrorCodeOf(err: unknown): StudioErrorCode {
  return err instanceof HtmlAssembleError ? "HTML_RENDER_FAILED" : errorCodeOf(err, "RENDER_FAILED");
}

export function errorMessageOf(err: unknown): string {
  if (err instanceof StudioNotImplemented) return `${err.message} (module pending)`;
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validasi bentuk minimal snapshot revisi (sumber render ulang deterministik). */
export function asSnapshot(v: unknown): NormDocSnapshot {
  if (
    !isRecord(v) ||
    v.schema !== "studio.norm/v1" ||
    !isRecord(v.doc) ||
    !isRecord((v.doc as Record<string, unknown>).meta) ||
    !Array.isArray(v.blocks) ||
    !Array.isArray(v.units)
  ) {
    throw new StudioEngineError("SCHEMA_INVALID", "revision snapshot is not a studio.norm/v1 snapshot");
  }
  const s = v as unknown as NormDocSnapshot;
  if (!isRecord(s.numbering)) s.numbering = {};
  if (!isRecord(s.register)) s.register = {};
  return s;
}

/**
 * Validasi bentuk minimal snapshot `studio.norm/v1` ATAU `studio.norm/v2`
 * (register 03 §15.1: `doc.chapters` boleh [] pada v2). v2 wajib membawa
 * `skeleton.slots`. `asSnapshot` (v1 saja) tetap untuk pemanggil lama.
 */
export function asAnySnapshot(v: unknown): AnyNormSnapshot {
  if (isRecord(v) && v.schema === "studio.norm/v2") {
    const doc = isRecord(v.doc) ? v.doc : null;
    if (!doc || !isRecord(doc.meta) || !Array.isArray(v.blocks) || !Array.isArray(v.units) || !isRecord(v.skeleton) || !Array.isArray(v.skeleton.slots)) {
      throw new StudioEngineError("SCHEMA_INVALID", "revision snapshot is not a valid studio.norm/v2 snapshot");
    }
    const s = v as unknown as NormDocSnapshotV2;
    if (!Array.isArray(s.doc.chapters)) (s.doc as { chapters: unknown[] }).chapters = [];
    if (!isRecord(s.numbering)) s.numbering = {};
    if (!isRecord(s.register)) s.register = {};
    return s;
  }
  return asSnapshot(v);
}

/**
 * Snapshot apa pun dalam tipe yang dibaca mesin (`RenderContext.snapshot`,
 * `buildFigures`, lint). `NormDocSnapshotV2` adalah perluasan struktural v1
 * (unit/blok turunan, `doc` internal sama); hanya literal `schema` yang beda,
 * dan perakit sadar slot (SR-16/SR-17) memilih jalur dari `schema`. Cast satu
 * tempat ini hilang bila kontrak melebarkan `RenderContext.snapshot` ke
 * `AnyNormSnapshot` (file_requests SR-15).
 */
export function engineSnapshot(s: AnyNormSnapshot): NormDocSnapshot {
  return s as unknown as NormDocSnapshot;
}

/** Catat revisi Chromium (dari path `chromium-<rev>`) bila browser sudah dipakai job ini. */
export async function noteChromium(job: RenderJobHandle): Promise<void> {
  if (job.engine.chromiumRevision) return;
  try {
    const h = await getBrowser();
    job.engine.chromiumRevision = /chromium-(\d+)/i.exec(h.executablePath)?.[1] ?? h.version;
  } catch (err) {
    job.log.warn(`chromium info unavailable: ${errorMessageOf(err)}`);
  }
}

/**
 * Serahkan satu berkas ke services/storage (S52). Galat dicatat per format
 * (tidak melempar) agar format lain tetap ditulis.
 */
export async function handOff(job: RenderJobHandle, input: WriteOutputInput, outputs: OutputFileDto[], failed: Set<StudioOutputFormat>): Promise<void> {
  if (job.aborted) {
    failed.add(input.format);
    return;
  }
  try {
    const dto = await writeOutput({ ...input, renderJobId: job.id });
    outputs.push(dto);
    job.log.info(`output written: ${input.format} ${dto.relPath}`, {
      code: "OUTPUT_WRITTEN",
      context: { format: input.format, role: input.role, bytes: dto.bytes, sha256: dto.sha256, outputId: dto.id },
    });
  } catch (err) {
    failed.add(input.format);
    job.addError(errorCodeOf(err, "STORAGE_WRITE_FAILED"), `storage hand-off failed for ${input.fileName}: ${errorMessageOf(err)}`, input.format, err);
  }
}

/** Job log minimal yang dibutuhkan helper templat/aset (JobLog atau peredam uji). */
type WarnLog = Pick<RenderJobHandle["log"], "warn" | "info">;

/**
 * Parameter render = parameter ingest (D-63, S48): override dokumen
 * (`doc.overrides`) diterapkan di atas templat yang dipin dengan konteks yang
 * sama dengan ingest (`applyDocOverrides`). Override yang tidak lagi sah
 * (registri/templat berubah sejak ingest) dilewati oleh resolver dan dicatat
 * sebagai peringatan job, bukan galat.
 */
export function templateForDoc(base: ResolvedTemplate, doc: StudioDocV1, log: WarnLog): ResolvedTemplate {
  const n = Object.keys(doc.overrides ?? {}).length;
  if (n === 0) return base;
  const applied = applyDocOverrides(base, doc);
  if (applied.issues.length > 0) {
    log.warn(`document overrides partly invalid at render (${applied.issues.length} issue(s)); invalid keys ignored`, {
      code: "DOC_OVERRIDES_INVALID",
      context: { issues: applied.issues.slice(0, 20).map((i) => ({ pointer: i.pointer, message: i.message })) },
    });
  }
  log.info(`document overrides applied: ${n}`, { code: "DOC_OVERRIDES_APPLIED", context: { count: n } });
  return applied.tpl;
}

/** Hasil `gateInlineDocOverrides`: dokumen yang boleh dirender + pointer kunci override yang dikupas. */
export interface InlineOverrideGate {
  doc: StudioDocV1;
  stripped: string[];
}

function jsonPointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** true bila satu kunci boleh ditulis peran pemanggil (izin tulis parameter SR-06: K, T, lapis). */
function overrideWritableBy(caller: Pick<StudioCaller, "kind">, key: string, value: ParamValue, previous: ParamValue | undefined, tier: StudioTier | undefined): boolean {
  try {
    checkTemplateWrite(caller, { isPreset: false, restricted: false }, [{ key, value, previous }], tier ? { tier } : {});
    return true;
  } catch (err) {
    if (err instanceof StudioEngineError) return false;
    throw err;
  }
}

/**
 * Override dokumen v1 (`doc.overrides`) yang boleh dipakai saat render dokumen
 * INLINE (F-068, R09 HTML artefak). Aturannya sama dengan jalur dokumen; fungsi
 * ini hanya merangkai sumber aturan yang dipakai ingest, tanpa salinan:
 *  - kebijakan `ingest.inlineFormat` templat dasar lewat `effectiveInlinePolicy`
 *    (adaptor SR-09; `allow` hanya bagi pemanggil tepercaya). Selain `allow`
 *    efektif, ingest membuang SELURUH `overrides` (KD-26, D-179, D-210), jadi
 *    render juga membuangnya. Ini berlaku untuk tepercaya sekalipun bila
 *    kebijakannya `strip`;
 *  - per kunci, hak kelas K/T (`checkOverrideRights`, sama dengan ingest);
 *  - per kunci, izin tulis peran (`checkTemplateWrite`, D-134: K terkunci,
 *    T hanya-baca, lapis advanced/internal PARAM_SURFACE_FORBIDDEN bagi non-ADMIN).
 * Kunci yang gagal dikupas, tidak pernah diterapkan diam-diam. Murni: tanpa I/O.
 */
export function gateInlineDocOverrides(
  base: ResolvedTemplate,
  doc: StudioDocV1,
  caller: Pick<StudioCaller, "kind">,
  opts: { trusted: boolean; pointer: string },
): InlineOverrideGate {
  const entries = Object.entries(doc.overrides ?? {});
  if (entries.length === 0) return { doc, stripped: [] };
  // D-253: pengurai kebijakan satu sumber dengan ingest (aturan kupas per kunci tetap milik render).
  const allow = effectiveInlinePolicy(inlineFormatPolicyOf(base.params), opts.trusted) === "allow";
  const tier = doc.meta?.tier as StudioTier | undefined;
  const keep: Record<string, ParamValue> = {};
  const stripped: string[] = [];
  for (const [key, value] of entries) {
    const ok =
      allow &&
      checkOverrideRights({ [key]: value }, caller.kind, ALL_PARAMS).length === 0 &&
      overrideWritableBy(caller, key, value, base.params[key], tier);
    if (ok) keep[key] = value;
    else stripped.push(`${opts.pointer}/overrides/${jsonPointerToken(key)}`);
  }
  if (stripped.length === 0) return { doc, stripped };
  const { overrides: _dropped, ...rest } = doc;
  void _dropped;
  return { doc: Object.keys(keep).length > 0 ? { ...rest, overrides: keep } : rest, stripped };
}

/**
 * Pencari baris aset M13 per sha256 (D-175: `StudioAsset.relPath` C33c sumber
 * utama). Layanan memberi `findAssetBySha` (services/images, SR-19); jalur
 * tanpa DB (CLI/benchmark) tidak memberi apa pun -> hanya jalur datar lama.
 */
export type AssetRowLookup = (sha256: string) => Promise<{ relPath: string; mime: string } | null>;

export interface PreloadAssetOptions {
  /** sha256 aset di luar `doc.assets` (mis. `NormBlockV2.assetSha256` snapshot v2). */
  extraSha256?: readonly string[];
  lookupRow?: AssetRowLookup;
}

type RasterMime = "image/png" | "image/jpeg";

function rasterMime(m: unknown): RasterMime | undefined {
  return m === "image/png" || m === "image/jpeg" ? m : undefined;
}

/**
 * Baca satu aset tersimpan: path eksplisit (dokumen lama) -> baris M13
 * `relPath` (D-175) -> jalur datar lama `assets/<sha>.<ext>` sebagai cadangan.
 */
async function readStoredAsset(sha: string, mime: RasterMime | undefined, path: string | undefined, lookupRow: AssetRowLookup | undefined, log: WarnLog): Promise<Uint8Array> {
  if (path) return (await readImageAsset({ sha256: sha, mime: mime as RasterMime, path })).bytes;
  if (lookupRow) {
    try {
      const row = await lookupRow(sha);
      if (row) return (await readImageAsset({ sha256: sha, mime: rasterMime(row.mime) ?? (mime as RasterMime), path: row.relPath })).bytes;
    } catch (err) {
      log.warn(`asset ${sha} not readable via StudioAsset.relPath, trying legacy flat path: ${errorMessageOf(err)}`, {
        code: "ASSET_RELPATH_FALLBACK",
        context: { sha256: sha, errorCode: errorCodeOf(err, "RENDER_FAILED") },
      });
    }
  }
  return (await readImageAsset({ sha256: sha, mime: mime as RasterMime })).bytes;
}

/**
 * Pramuat byte aset raster dokumen untuk `RenderContext.assetBytes`
 * (delta S03-d1, D-63): `dataBase64` didekode (sha256 dicek), aset tersimpan
 * dibaca lewat `readImageAsset` (S53: guard path, verifikasi sha256 + MIME)
 * dengan urutan lokasi D-175 (`readStoredAsset`). Gagal per aset = peringatan
 * job; renderer tetap memakai jalurnya sendiri dan melaporkan galat aset
 * dengan alamat bloknya.
 */
export async function preloadAssetBytes(doc: StudioDocV1, log: WarnLog, opts: PreloadAssetOptions = {}): Promise<NonNullable<RenderContext["assetBytes"]>> {
  const bytes = new Map<string, Uint8Array>();
  const tasks: Array<{ key: string; sha: string; mime?: RasterMime; path?: string; dataBase64?: string }> = [];
  for (const [key, ref] of Object.entries(doc.assets ?? {})) {
    if (!ref || ref.kind !== "raster" || typeof ref.sha256 !== "string") continue;
    tasks.push({ key, sha: ref.sha256.toLowerCase(), mime: rasterMime(ref.mime), path: typeof ref.path === "string" && ref.path ? ref.path : undefined, dataBase64: typeof ref.dataBase64 === "string" ? ref.dataBase64 : undefined });
  }
  for (const sha of opts.extraSha256 ?? []) {
    if (typeof sha === "string" && sha) tasks.push({ key: `sha256:${sha.toLowerCase()}`, sha: sha.toLowerCase() });
  }
  for (const t of tasks) {
    if (bytes.has(t.sha)) continue;
    try {
      if (t.dataBase64 !== undefined) {
        const data = new Uint8Array(Buffer.from(t.dataBase64, "base64"));
        const got = createHash("sha256").update(data).digest("hex");
        if (got !== t.sha) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `embedded asset sha256 ${got} differs from registered ${t.sha}`);
        bytes.set(t.sha, data);
      } else {
        bytes.set(t.sha, await readStoredAsset(t.sha, t.mime, t.path, opts.lookupRow, log));
      }
    } catch (err) {
      log.warn(`asset "${t.key}" not preloaded: ${errorMessageOf(err)}`, {
        code: "ASSET_PRELOAD_FAILED",
        context: { key: t.key, sha256: t.sha, errorCode: errorCodeOf(err, "RENDER_FAILED") },
      });
    }
  }
  if (bytes.size > 0) log.info(`assets preloaded: ${bytes.size}`, { code: "ASSETS_PRELOADED", context: { count: bytes.size } });
  return (sha256: string) => bytes.get(String(sha256).toLowerCase());
}
