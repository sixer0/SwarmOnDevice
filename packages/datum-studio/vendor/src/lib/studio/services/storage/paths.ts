/**
 * Jalur penyimpanan Studio (S52, 01_specs.md §7.2): penamaan DATUM, direktori
 * per misi, dan guard traversal. Modul murni (tanpa DB); tidak mengimpor
 * `./log` agar tidak ada impor sirkular.
 *
 * Akar = `getStudioEnv().workspaceRoot` (env `STUDIO_WORKSPACE_ROOT`, default
 * `data/studio-workspace`, KT-03). `getStudioEnv` sudah melempar
 * `STORAGE_ROOT_FORBIDDEN` bila akar sama/di dalam `SHARED_WORKSPACE`
 * produksi, jadi modul ini tidak pernah menulis ke workspace produksi.
 */
import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { getStudioEnv } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";

// ── Konstanta ────────────────────────────────────────────────────────────

/** §7.2: `mission.folder`, cocok `classifyPath` IL (research/02:412). */
export const MISSION_FOLDER_RE = /^\d{4}-\d{2}-\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$/;
export const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Nomor berkas setelah `/` -> `-` (P3-19). */
export const FILE_NUMBER_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
/** Id artefak (cuid) / segmen id aman. */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const EXT_RE = /^[a-z0-9]{1,10}$/;
/** DATUM-38: maks 120 karakter sebelum ekstensi. */
export const DATUM_NAME_MAX = 120;
export const MAX_REL_PATH_CHARS = 1000;
const MAX_SEGMENT_CHARS = 255;
/**
 * Karakter terlarang di nama berkas Windows + kendali. C35 L-02 (CWE-451): juga kontrol bidi
 * (U+200E/F, U+202A-202E, U+2066-2069) agar nama tidak tampil terbalik di unduhan/penjelajah berkas.
 */
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const STUDIO_DIR = "studio";
export const FIGURE_DIR = "figur";
export const ARTIFACT_DIR = "artefak";
export const DOCS_DIR = "docs";

// ── Akar ─────────────────────────────────────────────────────────────────

/** Akar absolut Studio (melempar STORAGE_ROOT_FORBIDDEN, KT-03). */
export function storageRoot(): string {
  return getStudioEnv().workspaceRoot;
}

function outside(detail: Record<string, unknown>): StudioEngineError {
  return new StudioEngineError("PATH_OUTSIDE_ROOT", "Path is outside the Studio storage root", detail);
}

function invalid(message: string, detail: Record<string, unknown>): StudioEngineError {
  return new StudioEngineError("SCHEMA_INVALID", message, detail);
}

/** true bila `child` berada DI DALAM `parent` (bukan sama), keduanya absolut. */
function strictlyInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function insideOrSame(child: string, parent: string): boolean {
  return path.relative(parent, child) === "" || strictlyInside(child, parent);
}

// ── Segmen dan guard ─────────────────────────────────────────────────────

/** Satu segmen nama (berkas/direktori) aman; selain itu PATH_OUTSIDE_ROOT. */
export function assertSafeSegment(seg: string): void {
  if (
    typeof seg !== "string" ||
    seg.length === 0 ||
    seg.length > MAX_SEGMENT_CHARS ||
    seg === "." ||
    seg === ".." ||
    seg.includes("/") ||
    seg.includes("\\") ||
    FORBIDDEN_SEGMENT_CHARS.test(seg) ||
    /[. ]$/.test(seg) ||
    seg !== seg.trimStart() ||
    WIN_RESERVED.test(seg)
  ) {
    throw outside({ reason: "unsafe_segment" });
  }
}

function splitRel(relPath: string): string[] {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > MAX_REL_PATH_CHARS) {
    throw outside({ reason: "empty_or_too_long" });
  }
  // Absolut POSIX/Windows, UNC, huruf drive, perangkat (`\\?\`, `\\.\`).
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw outside({ reason: "absolute" });
  }
  const segs = relPath.split(/[\\/]/);
  for (const s of segs) assertSafeSegment(s);
  return segs;
}

/** Leluhur terdekat yang ada (untuk cek realpath sebelum direktori dibuat). */
function nearestExisting(abs: string): string {
  let cur = abs;
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return cur;
}

/**
 * Cek symlink/junction (sinkron): realpath leluhur terdekat yang ada wajib di
 * dalam realpath akar. Bila akar belum ada, tidak ada apa pun di bawahnya
 * sehingga cek lexical sudah cukup.
 */
function assertRealInsideRootSync(abs: string, root: string): void {
  if (!existsSync(root)) return;
  const realRoot = realpathSync.native(root);
  const anchor = nearestExisting(abs);
  if (!insideOrSame(anchor, root)) return; // leluhur di atas akar = akar belum dibuat (ditangani di atas)
  const realAnchor = realpathSync.native(anchor);
  if (!insideOrSame(realAnchor, realRoot)) throw outside({ reason: "symlink_escape" });
}

/**
 * Guard traversal (I42): relatif akar, pemisah `/` atau `\`; tolak absolut,
 * `..`, `.`, segmen kosong, karakter terlarang, nama perangkat Windows, dan
 * symlink/junction yang keluar akar. Hasil = path absolut yang berawalan
 * akar + pemisah; selain itu `PATH_OUTSIDE_ROOT`.
 */
export function resolveSafe(relPath: string): string {
  const segs = splitRel(relPath);
  const root = storageRoot();
  const abs = path.resolve(path.join(root, ...segs));
  if (!strictlyInside(abs, root) || !abs.startsWith(root + path.sep)) throw outside({ reason: "lexical" });
  assertRealInsideRootSync(abs, root);
  return abs;
}

/** Versi async (setelah direktori dibuat / sebelum baca): realpath target wajib di dalam realpath akar. */
export async function assertRealInsideRoot(abs: string): Promise<void> {
  const root = storageRoot();
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(abs)]);
  if (!strictlyInside(realTarget, realRoot)) throw outside({ reason: "symlink_escape" });
}

/** relPath kanonik untuk DB: segmen digabung `/`. */
export function toRelPath(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split(/[\\/]/)).filter((s) => s.length > 0);
  const rel = segs.join("/");
  splitRel(rel);
  return rel;
}

// ── Penamaan DATUM (DATUM-38) ────────────────────────────────────────────

/**
 * Rapikan teks menjadi nama berkas DATUM: `_` -> spasi; `<>:"/\|?*` dan
 * kendali dibuang; spasi beruntun dirapatkan; titik/spasi akhir dibuang.
 */
export function datumClean(text: string): string {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/_/g, " ")
    .replace(FORBIDDEN_NAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

function normalizeExt(ext: string): string {
  const e = String(ext ?? "").replace(/^\.+/, "").toLowerCase();
  if (!EXT_RE.test(e)) throw invalid("Invalid file extension", { field: "ext" });
  return e;
}

function clip(stem: string, max: number): string {
  return Array.from(stem).slice(0, Math.max(0, max)).join("").replace(/[. ]+$/, "");
}

/** `docNumber` -> `<nomor-berkas>` (P3-19: `/` -> `-`), divalidasi sebagai segmen. */
export function fileNumber(docNumber: string): string {
  const n = String(docNumber ?? "").trim().replace(/\//g, "-");
  if (!FILE_NUMBER_RE.test(n) || /\.$/.test(n) || n.length > 120) {
    throw invalid("Invalid document number for storage", { field: "docNumber" });
  }
  return n;
}

/**
 * Nama berkas utama DATUM: `<Judul> <nomor-berkas> Rev<X>.<ext>`, maks 120
 * karakter sebelum ekstensi. Bila terlalu panjang, JUDUL yang dipotong agar
 * nomor dan revisi tetap utuh. Contoh:
 * `Manual Komprehensif DATUM GSP 000-GSP-STD-X-2026 RevA.docx`.
 */
export function datumFileName(title: string, docNumber: string, rev: string, ext: string): string {
  const e = normalizeExt(ext);
  const num = datumClean(fileNumber(docNumber));
  const r = datumClean(String(rev ?? "").replace(/^rev\s*/i, ""));
  if (!r) throw invalid("Invalid revision letter", { field: "rev" });
  const suffix = `${num} Rev${r}`;
  const t = datumClean(title);
  const room = DATUM_NAME_MAX - suffix.length - 1;
  const stem = t && room > 0 ? `${clip(t, room)} ${suffix}` : clip(suffix, DATUM_NAME_MAX);
  const name = `${datumClean(stem)}.${e}`;
  assertSafeSegment(name);
  return name;
}

/**
 * C18 / TR-07 (R-78 `naming.file.form`, manual Tabel 2.3 ID:487-493 / EN:518-523): nama berkas
 * `<Judul> <YYYY-MM-DD>.<ext>` (contoh `Nota Rencana Uji 2026-11-02.md`), maks 120 karakter sebelum
 * ekstensi; bila terlalu panjang JUDUL yang dipotong agar tanggal utuh. Tanggal wajib ISO.
 */
export function datumDateFileName(title: string, isoDate: string, ext: string): string {
  const e = normalizeExt(ext);
  const date = String(isoDate ?? "").trim();
  if (!ISSUE_DATE_RE.test(date)) throw invalid("Invalid issue date", { field: "issueDate" });
  const t = datumClean(title);
  const room = DATUM_NAME_MAX - date.length - 1;
  const stem = t && room > 0 ? `${clip(t, room)} ${date}` : date;
  const name = `${datumClean(stem)}.${e}`;
  assertSafeSegment(name);
  return name;
}

/** Bentuk nama berkas R-78: `judulTanggalIso` = judul + tanggal ISO; nilai lain/absen = `datumFileName` hari ini. */
export function datumFileNameByForm(
  form: unknown,
  i: { title: string; docNumber: string; rev: string; issueDate: string },
  ext: string,
): string {
  return form === "judulTanggalIso" ? datumDateFileName(i.title, i.issueDate, ext) : datumFileName(i.title, i.docNumber, i.rev, ext);
}

/** Nama berkas DATUM bebas (figur `Gambar C.n Judul`, label artefak). */
export function datumPlainName(stem: string, ext: string): string {
  const e = normalizeExt(ext);
  const s = clip(datumClean(stem), DATUM_NAME_MAX);
  if (!s) throw invalid("Empty file name after DATUM cleaning", { field: "stem" });
  const name = `${s}.${e}`;
  assertSafeSegment(name);
  return name;
}

// ── Direktori tata letak §7.2 (relatif akar, pemisah `/`) ────────────────

/** Folder misi tervalidasi; absen -> `<date>_studio`. Format salah -> MISSION_REF_NOT_FOUND. */
export function missionDirName(missionFolder: string | undefined, date: string): string {
  if (missionFolder !== undefined && missionFolder !== null && missionFolder !== "") {
    if (!MISSION_FOLDER_RE.test(missionFolder)) {
      throw new StudioEngineError("MISSION_REF_NOT_FOUND", "mission.folder is not a valid mission folder name", {
        field: "mission.folder",
        pattern: MISSION_FOLDER_RE.source,
      });
    }
    return missionFolder;
  }
  if (!ISSUE_DATE_RE.test(String(date ?? ""))) throw invalid("Invalid issue date", { field: "issueDate" });
  return `${date}_studio`;
}

/** `docs/<misi>/studio/<nomor-berkas>/rev-<n>` (I42). */
export function docDir(i: { missionFolder?: string; issueDate: string; docNumber: string; revisionNo: number }): string {
  if (!Number.isInteger(i.revisionNo) || i.revisionNo < 1) throw invalid("Invalid revision number", { field: "revisionNo" });
  return toRelPath(DOCS_DIR, missionDirName(i.missionFolder, i.issueDate), STUDIO_DIR, fileNumber(i.docNumber), `rev-${i.revisionNo}`);
}

/** `<docDir>/figur`. */
export function figureDir(docRelDir: string): string {
  return toRelPath(docRelDir, FIGURE_DIR);
}

/** `docs/<misi>/studio/artefak/<artifactId>`; `date` = tanggal pembuatan (YYYY-MM-DD) bila misi absen. */
export function artifactDir(i: { missionFolder?: string; date: string; artifactId: string }): string {
  if (!SAFE_ID_RE.test(String(i.artifactId ?? ""))) throw invalid("Invalid artifact id", { field: "artifactId" });
  return toRelPath(DOCS_DIR, missionDirName(i.missionFolder, i.date), STUDIO_DIR, ARTIFACT_DIR, i.artifactId);
}

/** `tmp/<jobId>` (dihapus pemanggil setelah job). */
export function jobTmpDir(jobId: string): string {
  if (!SAFE_ID_RE.test(String(jobId ?? ""))) throw outside({ reason: "unsafe_job_id" });
  return toRelPath("tmp", jobId);
}
