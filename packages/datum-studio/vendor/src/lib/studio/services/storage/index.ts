/**
 * Layanan penyimpanan dan tautan misi Studio (I42, 01_specs.md §7.2, §8.2; S52).
 *
 * Akar = `STUDIO_WORKSPACE_ROOT` (default `data/studio-workspace`, KT-03);
 * tidak pernah menulis `SHARED_WORKSPACE` produksi (`getStudioEnv` melempar
 * `STORAGE_ROOT_FORBIDDEN`). Tata letak:
 * `docs/<YYYY-MM-DD>_<misi>/studio/<nomor-berkas>/rev-<n>/<Judul> <nomor-berkas> Rev<X>.<ext>`.
 *
 * Tanda tangan kontrak I42: `docDir`, `datumFileName`, `writeOutput`,
 * `resolveSafe`, `assertMissionRefs`. Ekspor tambahan untuk S51/S53/S57:
 * pembaca berkas (`readOutputFile`, `readStoredFile`), helper tata letak
 * (`figureDir`, `artifactDir`, `jobTmpDir`, `datumPlainName`), dan sink log
 * (`createLayoutLogSink`, `setStorageLogSink`).
 */
export {
  artifactDir,
  assertRealInsideRoot,
  assertSafeSegment,
  datumClean,
  datumFileName,
  datumPlainName,
  docDir,
  figureDir,
  fileNumber,
  jobTmpDir,
  missionDirName,
  MISSION_FOLDER_RE,
  resolveSafe,
  storageRoot,
  toRelPath,
  DATUM_NAME_MAX,
} from "./paths";
export {
  finalFileNameOfRow,
  mimeBase,
  OUTPUT_FILE_OWNER_INCLUDE,
  OUTPUT_MIME_BASE,
  readOutputFile,
  readStoredFile,
  sha256Hex,
  storageRootPath,
  toOutputFileDto,
  writeOutput,
} from "./files";
export type { OutputFileRow, StoredFile } from "./files";
export { assertMissionRefs } from "./mission";
export {
  createLayoutLogSink,
  DEFAULT_LAYOUT_LOG_FILE,
  setStorageLogSink,
  storageLog,
  STORAGE_SOURCE,
} from "./log";
export type { LayoutLogInput, LayoutLogSink, LayoutLogSinkOptions, StorageLogEntry, StorageLogSink } from "./log";
