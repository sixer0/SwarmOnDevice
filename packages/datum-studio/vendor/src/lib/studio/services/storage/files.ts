/**
 * Tulis dan baca berkas keluaran Studio (S52, I42 `writeOutput`; pembaca untuk
 * route files S57).
 *
 * Tulis: guard traversal -> mkdir -> realpath direktori di dalam akar ->
 * tulis ke `<akar>/tmp/storage/<acak>.tmp` (flag `wx`) -> rename atomik ke
 * tujuan (retry singkat EPERM/EBUSY Windows) -> sha256 + bytes -> upsert
 * `StudioOutputFile` per `relPath` (unik; render ulang revisi yang sama
 * menimpa baris dan berkasnya).
 *
 * Klien DB dimuat MALAS (D-155/IP-48): klien Prisma klon dibuat saat modul
 * dievaluasi dan memuat `.env` saat diimpor, sedangkan modul
 * ini ikut terimpor oleh jalur tanpa DB (orkestrator render murni, CLI, runner)
 * lewat `services/storage`. Klien baru dimuat pada panggilan DB pertama;
 * `import type` tetap boleh (terhapus saat kompilasi).
 *
 * Swarm patch (row 109, Prisma cut; 01_specs_studio.md §1.2 site 7): bytes still go to the folder
 * (`STUDIO_WORKSPACE_ROOT` = the store root, studio spec §2 B), the row goes to
 * `StudioStore.putOutput` (which re-checks the file's sha256 and size on disk).
 *
 * Swarm patch (row 43a, C92, finding F1; store spec §8.2 "a revision folder only gains files"): an
 * output file is never overwritten and its row is never repointed. A write publishes the bytes with a
 * hard link (no clobber) at the caller's name; same bytes there = the existing row is reused (no
 * duplicate). Other bytes there (a re-render whose raster changed) = the bytes go to
 * `<stem>_<sha8>.<ext>` in the same folder with a NEW row; the old file and row stay and still verify.
 * The newest output of a revision is the row with the latest `time_created` (then `rowid`).
 */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { outputFileOf, readWith, studioStore, withStudioTx, type StudioOutputFile, type StudioTx } from "../_swarm-store";
import type { OutputFileScope, StudioOutputFileDto, StudioOutputFormat, WriteOutputInput } from "../../contract";
import { studioRoutePath } from "../../contract/env";
import { STUDIO_OUTPUT_FORMATS, STUDIO_OUTPUT_ROLES, STUDIO_RELEASE_STATUSES } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import { finalFileNameOf } from "../render/final-name";
import { errorFields, storageLog } from "./log";
import { assertRealInsideRoot, assertSafeSegment, DOCS_DIR, resolveSafe, storageRoot, toRelPath } from "./paths";

/** Output row + the owner relation of `OUTPUT_FILE_OWNER_INCLUDE` (document number/kind, revision no). */
function outputRowWithOwner(q: StudioTx, where: "id" | "rel_path", value: string): OutputFileRow | null {
  const r = q.get<Record<string, unknown>>(
    `SELECT o.*, d.doc_number AS owner_doc_number, d.contract_kind AS owner_contract_kind, r.revision_no AS owner_revision_no
       FROM output_file o LEFT JOIN document d ON d.id = o.document_id LEFT JOIN revision r ON r.id = o.revision_id
      WHERE o.${where} = ?`,
    [value],
  );
  if (!r) return null;
  return {
    ...outputFileOf(r),
    document: r.owner_doc_number === null || r.owner_doc_number === undefined ? null : { docNumber: String(r.owner_doc_number), contractKind: (r.owner_contract_kind ?? null) as string | null },
    revision: r.owner_revision_no === null || r.owner_revision_no === undefined ? null : { revisionNo: Number(r.owner_revision_no) },
  };
}

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 50;
/** Kolom `bytes` = Int Postgres. */
const MAX_FILE_BYTES = 2_147_483_647;

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Lingkup render satu berkas: tipe kontrak (IP-48), diekspor ulang untuk pemakai lama. */
export type { OutputFileScope };

/**
 * DTO berkas keluaran + lingkup (SR-30/IP-54, D-212): `draft` (render parsial
 * dokumen INCOMPLETE, D-186) dan `scope` dari kolom `StudioOutputFile`. Kini
 * medan kontrak `OutputFileDto` (IP-48); alias dipertahankan untuk pemakai lama.
 */
export type StoredOutputFileDto = StudioOutputFileDto;

/** Lingkup dari kolom baris; DOCUMENT (bawaan DB) tanpa `key`. */
export function outputFileScope(row: Pick<StudioOutputFile, "scopeKind" | "scopeKey">): OutputFileScope {
  const kind = row.scopeKind;
  return kind !== "DOCUMENT" && row.scopeKey ? { kind, key: row.scopeKey } : { kind };
}

/**
 * Relasi pemilik untuk nama final (DC-20, register 05 §10 FN-03, KD-39):
 * `docNumber` + `contractKind` dokumen dan `revisionNo` revisi. Dipasang pada
 * query baris `StudioOutputFile` agar `toOutputFileDto` dapat mengisi
 * `finalFileName` tanpa query kedua. Berkas artefak tidak membutuhkannya.
 */
export const OUTPUT_FILE_OWNER_INCLUDE = {
  document: { select: { docNumber: true, contractKind: true } },
  revision: { select: { revisionNo: true } },
} as const;

/** Baris `StudioOutputFile`, boleh membawa relasi `OUTPUT_FILE_OWNER_INCLUDE`. */
export type OutputFileRow = StudioOutputFile & {
  document?: { docNumber: string; contractKind?: string | null } | null;
  revision?: { revisionNo: number } | null;
};

/** Swarm patch (I-2): document-number part of a preview row's final name (docNumberSafe folds it to `GSP-Pratinjau-Templat`). */
export const PREVIEW_FINAL_DOC_NUMBER = "GSP Pratinjau Templat";

/**
 * I62 atas satu baris (FN-03..FN-05): artefak -> `ART-<id>_rev0`; revisi ->
 * `docNumberSafe(docNumber)_rev<n>` dari relasi `OUTPUT_FILE_OWNER_INCLUDE`.
 * Selalu string (AM-09 wajib, D-389). Baris revisi tanpa relasi pemilik dimuat,
 * atau baris tanpa revisionId/artifactId (melanggar M08), = galat pemrograman
 * pemanggil -> `TypeError` (500 lewat studioErrorFrom), dicatat lebih dulu.
 * Swarm patch (I-2): baris pratinjau templat (`kind = 'preview'`) dinamai sendiri, lihat di bawah.
 */
export function finalFileNameOfRow(row: OutputFileRow): string {
  const file = { createdAt: row.createdAt, sha256: row.sha256, format: row.format };
  if (row.artifactId) return finalFileNameOf(file, { artifactId: row.artifactId });
  if (row.revisionId && row.document && row.revision) {
    return finalFileNameOf(file, { docNumber: row.document.docNumber, revisionNo: row.revision.revisionNo });
  }
  // Swarm patch (I-2, C76; file_requests row68 line 87): a template preview row (row 67, `kind = 'preview'`) has no
  // revision and no artifact. Its final name is the C51 form with the preview base as document number and rev 0:
  // `GSP-Pratinjau-Templat_rev0_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>` (never taken from the stored file_name).
  if (row.kind === "preview" && !row.revisionId) return finalFileNameOf(file, { docNumber: PREVIEW_FINAL_DOC_NUMBER, revisionNo: 0 });
  const reason = row.revisionId ? "owner relation not loaded (use OUTPUT_FILE_OWNER_INCLUDE)" : "row has neither revisionId nor artifactId";
  const err = new TypeError(`finalFileNameOfRow: ${reason}`);
  const fields = errorFields(err);
  storageLog({
    level: "error",
    message: "output file final name owner missing",
    code: "OUTPUT_FILE_OWNER_MISSING",
    ...fields,
    context: { ...fields.context, id: row.id, revisionId: row.revisionId, documentLoaded: row.document != null, revisionLoaded: row.revision != null },
  });
  throw err;
}

/**
 * Pemeta baris -> `OutputFileDto` bersama (CQ-3): R09, R05, R10 dan semua
 * keluaran `writeOutput` (R17, R07). `finalFileName` (AM-09) selalu diisi;
 * baris revisi wajib dimuat dengan `OUTPUT_FILE_OWNER_INCLUDE`.
 */
export function toOutputFileDto(row: OutputFileRow): StoredOutputFileDto {
  const finalFileName = finalFileNameOfRow(row);
  return {
    id: row.id,
    documentId: row.documentId,
    revisionId: row.revisionId,
    artifactId: row.artifactId,
    renderJobId: row.renderJobId,
    format: row.format,
    role: row.role,
    figureLabel: row.figureLabel,
    relPath: row.relPath,
    fileName: row.fileName,
    bytes: row.bytes,
    sha256: row.sha256,
    mime: row.mime,
    lintVerdict: row.lintVerdict,
    createdAt: row.createdAt.toISOString(),
    url: studioRoutePath("R10", { id: row.id }),
    draft: row.draft,
    scope: outputFileScope(row),
    finalFileName,
  };
}

function badInput(message: string, field: string): Error {
  // Pelanggaran invarian pemanggil (bug internal, bukan masukan user) -> 500 lewat studioErrorFrom.
  return new TypeError(`writeOutput: ${message} (${field})`);
}

/** Invarian M08 (§1.2): tepat satu dari revisionId/artifactId; documentId wajib bila revisionId. */
function checkInput(i: WriteOutputInput): void {
  const hasRev = typeof i.revisionId === "string" && i.revisionId !== "";
  const hasArt = typeof i.artifactId === "string" && i.artifactId !== "";
  if (hasRev === hasArt) throw badInput("exactly one of revisionId/artifactId is required", "revisionId|artifactId");
  if (hasRev && !i.documentId) throw badInput("documentId is required with revisionId", "documentId");
  if (!(STUDIO_OUTPUT_FORMATS as readonly string[]).includes(i.format)) throw badInput("unknown format", "format");
  if (!(STUDIO_OUTPUT_ROLES as readonly string[]).includes(i.role)) throw badInput("unknown role", "role");
  if (i.lintVerdict !== undefined && !(STUDIO_RELEASE_STATUSES as readonly string[]).includes(i.lintVerdict)) {
    throw badInput("unknown lintVerdict", "lintVerdict");
  }
  const base = typeof i.mime === "string" ? mimeBase(i.mime) : null;
  if (base === null) throw badInput(`invalid mime ${JSON.stringify(i.mime)}`, "mime");
  if (base !== OUTPUT_MIME_BASE[i.format]) {
    throw badInput(`mime ${base} does not match format ${i.format} (expected ${OUTPUT_MIME_BASE[i.format]})`, "mime");
  }
}

/**
 * Tipe media dasar per format keluaran (huruf kecil, tanpa parameter). MIME
 * yang dikirim pemanggil boleh membawa parameter (mis. `text/html;
 * charset=utf-8`, dipakai apa adanya sebagai `Content-Type` R10), tetapi tipe
 * dasarnya wajib cocok dengan format (F-032: regex lama menolak parameter
 * sehingga keluaran HTML tidak pernah tersimpan).
 */
export const OUTPUT_MIME_BASE: Readonly<Record<StudioOutputFormat, string>> = {
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PDF: "application/pdf",
  HTML: "text/html",
  SVG: "image/svg+xml",
  PNG: "image/png",
};

const MIME_TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
/** RFC 9110 §8.3.1: `type/subtype *( OWS ";" OWS name=value )`; nilai token atau quoted-string sederhana. */
const MIME_RE = new RegExp(`^(${MIME_TOKEN})\\/(${MIME_TOKEN})((?:[ \\t]*;[ \\t]*${MIME_TOKEN}=(?:${MIME_TOKEN}|"[^"\\\\\\r\\n]*"))*)[ \\t]*$`);
const MAX_MIME_CHARS = 255;

/** Tipe dasar huruf kecil (`type/subtype`) dari MIME sah, atau `null` bila tidak sah. */
export function mimeBase(mime: string): string | null {
  if (mime.length === 0 || mime.length > MAX_MIME_CHARS) return null;
  const m = MIME_RE.exec(mime);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(RENAME_RETRY_MS * (attempt + 1));
    }
  }
}

/** Tujuan yang sudah ada tidak boleh symlink/direktori (cegah tulis menembus tautan). */
async function assertWritableTarget(abs: string): Promise<boolean> {
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new StudioEngineError("PATH_OUTSIDE_ROOT", "Target is not a regular file", { reason: "target_not_regular" });
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Same limit as `assertSafeSegment` (paths.ts MAX_SEGMENT_CHARS, not exported). */
const MAX_OUTPUT_NAME_CHARS = 255;

/**
 * Swarm patch (row 43a; separator row 165D): the names one write may take in its folder, in order: the caller's name,
 * then `<stem> <sha8><ext>`, `<stem> <sha16><ext>`, `<stem> <sha64><ext>` (stem shortened to fit one segment).
 * Deterministic per content, so the same bytes always land on (and reuse) the same name.
 */
function candidateNames(fileName: string, sha256: string): string[] {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  const names = [fileName];
  for (const n of [8, 16, 64]) {
    // Swarm patch (row 165D, F56-2): a space, not `_`, so the delivered DATUM name keeps zero underscores (CP-17).
    const suffix = ` ${sha256.slice(0, n)}${ext}`;
    names.push(`${stem.slice(0, Math.max(0, MAX_OUTPUT_NAME_CHARS - suffix.length)).replace(/[. ]+$/, "")}${suffix}`);
  }
  return names;
}

/** Hard links unsupported on this filesystem: fall back to the clone's rename (checked-then-renamed). */
const NO_HARDLINK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"]);

/**
 * Swarm patch (row 43a): put the bytes of `tmpFile` at `absPath` without ever replacing a file there.
 * `created` = new file (hard link, atomic: EEXIST if another write got there first); `same` = an identical
 * file was already there; `differs` = another file is there and stays untouched.
 */
async function publishNoClobber(tmpFile: string, absPath: string, sha256: string): Promise<"created" | "same" | "differs"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await assertWritableTarget(absPath)) return sha256Hex(await readFile(absPath)) === sha256 ? "same" : "differs";
    try {
      await link(tmpFile, absPath);
      return "created";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") continue; // published meanwhile by another write: compare it on the next pass
      if (!NO_HARDLINK_CODES.has(code)) throw err;
      await renameWithRetry(tmpFile, absPath);
      return "created";
    }
  }
  throw new Error(`writeOutput: target keeps changing during publish (${path.basename(absPath)})`);
}

/** I42: tulis atomik + catat `StudioOutputFile`. Swarm patch (row 43a): tanpa menimpa, lihat kepala berkas. */
export async function writeOutput(i: WriteOutputInput): Promise<StoredOutputFileDto> {
  checkInput(i);
  assertSafeSegment(i.fileName);
  const relDir = toRelPath(i.relDir);
  if (relDir.split("/")[0] !== DOCS_DIR) {
    throw new StudioEngineError("PATH_OUTSIDE_ROOT", "Output directory must be under docs/", { reason: "not_docs_layout" });
  }
  let relPath = `${relDir}/${i.fileName}`;
  let fileName = i.fileName;
  let absPath = resolveSafe(relPath);
  const absDir = path.dirname(absPath);
  const data = typeof i.data === "string" ? Buffer.from(i.data, "utf8") : i.data;
  if (data.byteLength > MAX_FILE_BYTES) throw badInput("file too large for bytes column", "data");
  const sha256 = sha256Hex(data);

  const tmpDir = resolveSafe("tmp/storage");
  const tmpFile = path.join(tmpDir, `${randomUUID()}.tmp`);
  let created = false;
  /** Names in this folder already holding other bytes (kept untouched), for the log. */
  const kept: Array<{ relPath: string; sha256: string | null }> = [];
  try {
    await mkdir(absDir, { recursive: true });
    await assertRealInsideRoot(absDir);
    await mkdir(tmpDir, { recursive: true });
    await assertRealInsideRoot(tmpDir);
    await writeFile(tmpFile, data, { flag: "wx" });
    let placed = false;
    for (const name of candidateNames(i.fileName, sha256)) {
      assertSafeSegment(name);
      const rel = `${relDir}/${name}`;
      const abs = resolveSafe(rel);
      // A row already recording other bytes at this name keeps its name, even if its file went missing.
      const rowSha = await readWith(undefined, (q) => q.get<{ sha256: string }>("SELECT sha256 FROM output_file WHERE rel_path = ?", [rel])?.sha256 ?? null);
      if (rowSha !== null && rowSha !== sha256) {
        kept.push({ relPath: rel, sha256: rowSha });
        continue;
      }
      const got = await publishNoClobber(tmpFile, abs, sha256);
      if (got === "differs") {
        kept.push({ relPath: rel, sha256: null });
        continue;
      }
      relPath = rel;
      fileName = name;
      absPath = abs;
      created = got === "created";
      placed = true;
      break;
    }
    if (!placed) throw new Error(`writeOutput: no free content-addressed name for ${i.fileName}`);
  } catch (err) {
    if (!(err instanceof StudioEngineError)) {
      storageLog({
        level: "error",
        message: "output file write failed",
        code: "STORAGE_WRITE_FAILED",
        correlationId: i.renderJobId,
        ...errorFields(err),
        context: { ...errorFields(err).context, relPath },
      });
    }
    throw err;
  } finally {
    // The tmp file is a hard-link source (or already renamed away): always dropped.
    await rm(tmpFile, { force: true }).catch(() => undefined);
  }

  const fields = {
    documentId: i.documentId ?? null,
    revisionId: i.revisionId ?? null,
    artifactId: i.artifactId ?? null,
    renderJobId: i.renderJobId ?? null,
    format: i.format,
    role: i.role,
    figureLabel: i.figureLabel ?? null,
    fileName,
    bytes: data.byteLength,
    sha256,
    mime: i.mime,
    lintVerdict: i.lintVerdict ?? "PENDING",
  } as const;

  try {
    const row = await withStudioTx(async (tx) => {
      const before = outputRowWithOwner(tx, "rel_path", relPath);
      if (before && before.sha256 !== sha256) {
        // The file at relPath holds these bytes (published or compared above). A row recording other bytes
        // there is a conflict: it is never repointed (row 43a), the write fails instead.
        throw new Error(`writeOutput: output_file row at ${relPath} records other bytes`);
      }
      if (!before) {
        await studioStore().putOutput(tx, {
          kind: "document",
          documentId: fields.documentId,
          revisionId: fields.revisionId,
          renderJobId: fields.renderJobId,
          format: fields.format,
          role: fields.role,
          figureLabel: fields.figureLabel,
          relPath,
          fileName: fields.fileName,
          bytes: fields.bytes,
          sha256,
          mime: fields.mime,
          lintVerdict: fields.lintVerdict,
        });
      } else if (before.lintVerdict !== fields.lintVerdict || before.renderJobId !== fields.renderJobId) {
        // Same bytes: the existing row is reused; only its job/verdict metadata follows the latest write.
        tx.run(
          `UPDATE output_file SET document_id = ?, revision_id = ?, render_job_id = ?, format = ?, role = ?, figure_label = ?, mime = ?, lint_verdict = ?
            WHERE rel_path = ? AND sha256 = ?`,
          [fields.documentId, fields.revisionId, fields.renderJobId, fields.format, fields.role, fields.figureLabel, fields.mime, fields.lintVerdict, relPath, sha256],
        );
      }
      return outputRowWithOwner(tx, "rel_path", relPath)!;
    });
    if (created && kept.length > 0) {
      storageLog({
        level: "info",
        message: "output file appended next to other content of the same name",
        code: "STORAGE_OUTPUT_APPENDED",
        correlationId: i.renderJobId,
        context: { id: row.id, relPath, sha256, kept },
      });
    }
    storageLog({
      level: "info",
      message: "output file stored",
      code: "STORAGE_OUTPUT_WRITTEN",
      correlationId: i.renderJobId,
      context: { id: row.id, relPath, bytes: row.bytes, sha256 },
    });
    return toOutputFileDto(row);
  } catch (err) {
    // Berkas baru tanpa baris DB = yatim: dibuang. Berkas yang sudah ada (identik) dibiarkan.
    if (created) await rm(absPath, { force: true }).catch(() => undefined);
    storageLog({
      level: "error",
      message: created ? "output file DB record failed (new file removed)" : "output file DB record failed (existing identical file kept on disk)",
      code: "STORAGE_DB_FAILED",
      correlationId: i.renderJobId,
      ...errorFields(err),
      context: { ...errorFields(err).context, relPath },
    });
    throw err;
  }
}

// ── Baca (S57) ───────────────────────────────────────────────────────────

export interface StoredFile {
  absPath: string;
  bytes: number;
  data: Buffer;
}

/**
 * Baca berkas dengan guard yang sama (lexical + realpath). Berkas tidak ada /
 * bukan berkas biasa -> `FILE_MISSING_ON_DISK` (410).
 */
export async function readStoredFile(relPath: string): Promise<StoredFile> {
  const absPath = resolveSafe(relPath);
  try {
    const st = await lstat(absPath);
    if (!st.isSymbolicLink() && !st.isFile()) {
      throw new StudioEngineError("FILE_MISSING_ON_DISK", "Stored file is missing on disk", { relPath });
    }
    // Symlink diterima hanya bila target nyatanya tetap di dalam akar.
    await assertRealInsideRoot(absPath);
    const data = await readFile(absPath);
    return { absPath, bytes: data.byteLength, data };
  } catch (err) {
    if (err instanceof StudioEngineError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      storageLog({ level: "warn", message: "stored file missing on disk", code: "FILE_MISSING_ON_DISK", context: { relPath } });
      throw new StudioEngineError("FILE_MISSING_ON_DISK", "Stored file is missing on disk", { relPath });
    }
    storageLog({ level: "error", message: "stored file read failed", code: "STORAGE_READ_FAILED", ...errorFields(err), context: { ...errorFields(err).context, relPath } });
    throw err;
  }
}

/**
 * Untuk R10 `/api/studio/files/[id]`: baris DB -> berkas di disk (guard sama).
 * `FILE_NOT_FOUND` (404) bila baris tidak ada; `FILE_MISSING_ON_DISK` (410)
 * bila berkas hilang; `verifySha` opsional membandingkan sha256 (selisih ->
 * log warn, berkas tetap dikembalikan dengan `shaMatches: false`).
 * `contractKind` = jenis kontrak dokumen pemilik (null untuk artefak dan
 * dokumen output biasa); R10 memakainya untuk nama unduhan bawaan (U-2, D-363).
 */
export async function readOutputFile(
  id: string,
  opts: { verifySha?: boolean } = {},
): Promise<{ file: StoredOutputFileDto; absPath: string; data: Buffer; shaMatches?: boolean; contractKind: string | null }> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw new StudioEngineError("FILE_NOT_FOUND", "File not found");
  }
  const row = await readWith(undefined, (q) => outputRowWithOwner(q, "id", id));
  if (!row) throw new StudioEngineError("FILE_NOT_FOUND", "File not found");
  const stored = await readStoredFile(row.relPath);
  const file = toOutputFileDto(row);
  const contractKind = row.document?.contractKind ?? null;
  if (!opts.verifySha) return { file, absPath: stored.absPath, data: stored.data, contractKind };
  const shaMatches = sha256Hex(stored.data) === row.sha256;
  if (!shaMatches) {
    storageLog({ level: "warn", message: "stored file sha256 differs from DB", code: "STORAGE_SHA_MISMATCH", context: { id, relPath: row.relPath } });
  }
  return { file, absPath: stored.absPath, data: stored.data, shaMatches, contractKind };
}

/** Path absolut akar (untuk diagnosa/UI status; tidak membocorkan ke klien). */
export function storageRootPath(): string {
  return storageRoot();
}
