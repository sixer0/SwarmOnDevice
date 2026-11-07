/**
 * Repositori struktur dokumen (SR-10, I47; register 03_structural_sections_specs.md
 * §3.1 M14-M18, §4.6, §10).
 *
 * - `writeRevisionRows(tx, revisionId, rows)`: salinan penuh M14-M17 per revisi,
 *   identitas pid M18 per dokumen (buat/pensiun), tulis ganda `StudioBlock`.
 * - `readRows(revisionId)`: baca balik baris (urut deterministik).
 * - `rebuildSnapshot(revisionId)`: snapshot dari baris dengan cek sha256 (norm/v2
 *   compose ulang; norm/v1 hasil backfill = cek kesetaraan `adaptV1` lalu snapshot
 *   v1 tersimpan, IP-52). `reconstructSource(revisionId)`: konten v2 berpid tercek.
 * - `projectContent(revisionId, { slot?, chapter? })`: isi bentuk v2 + pid (R20).
 * - `dbPidAllocator(tx, documentId)`: pembangkit pid per dokumen (asinkron, memuat M18).
 *
 * Pemanggil memegang transaksi + kunci advisory dokumen (§9.1). Untuk revisi
 * v2, jangan juga menulis `StudioBlock` lewat `blockRowsFromSnapshot` (M06 sudah
 * ditulis di sini).
 */
export {
  readRows,
  syncIdentities,
  writeRevisionRows,
  type WriteRevisionRowsOptions,
  type WriteRevisionRowsResult,
} from "./repository";
export {
  projectContent,
  projectContentDetailed,
  rebuildSnapshot,
  reconstructSource,
  setSnapshotRecomposer,
  verifyReconstruction,
  type ContentProjection,
  type ContentQuery,
  type ProjectedContent,
  type ReconstructionReport,
  type SnapshotRecomposer,
} from "./snapshot";
export {
  CHAPTER_SUBMIT_TO,
  CONTENT_SHAPES,
  SLOT_SUBMIT_TO,
  SUBMISSION_EDIT_HINTS,
  toSubmissionShape,
  type ContentShape,
  type SubmissionShape,
  type SubmissionShapeOptions,
} from "./submission";
export {
  adaptLegacySnapshot,
  adaptorPidMismatches,
  checkLegacyReconstruction,
  sectionsShaWithoutPids,
  type LegacyAdaptation,
  type LegacyReconstructionCheck,
  type LegacySectionsMap,
} from "./legacy-v1";
export {
  assignMissingPids,
  attachInternal,
  canonicalSha,
  carryFillStamps,
  chapterSha256,
  computeStructureSha256,
  introSha256,
  rebuildSections,
  rebuildSource,
  rowsFromSource,
  sectionSha256,
  stripBlockId,
  stripChapterIds,
  stripSectionIds,
  validateRows,
  type RebuildSourceOptions,
  type RowsFromSourceInput,
  type SourceEnvelope,
} from "./rows";
export {
  chapterPidBase,
  createTrackingAllocator,
  crockford,
  dbPidAllocator,
  isValidPid,
  randomPid,
  seededPid,
  seededPidAllocator,
  type TrackingPidAllocator,
} from "./pid";
export {
  isRepeatableSectionType,
  REPEATABLE_SECTION_TYPES,
  StructureIntegrityError,
  StructureRowsInvalidError,
  type FillStamp,
  type SlotRowSpec,
  type StructureBlockInternal,
  type StructureBlockRow,
  type StructureChapterRow,
  type StructureDb,
  type StructureRows,
  type StructureSectionRow,
  type StructureSubsectionRow,
} from "./types";
export { setStructureLogSink, STRUCTURE_SOURCE } from "./log";
