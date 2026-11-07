/**
 * Layanan compose (SR-08, I45) — MURNI, tanpa DB.
 *
 * - `validateStructure`: aturan struktur §2.7 (kode `SLOT_*`, `BLOCK_TYPE_NOT_ADMITTED`,
 *   `CHAPTER_KEY_INVALID`).
 * - `mergeSubmission`: gabung kiriman dokumen/bab/slot v2 ke konten tergabung
 *   (identitas pid §10, idempotensi §9.3, lingkup §9.5).
 * - `composeV2`: snapshot `studio.norm/v2` (alamat, pid, penomoran artefak per
 *   kunci bab) + baris M14-M17 bentuk repositori SR-10.
 * - `scopeSha256` / `stripIds`: sha lingkup tanpa pid (KD-13).
 *
 * Pendaftaran recomposer repositori struktur ada di `./register` (sisi server).
 */
export { validateStructure, slotLayout, defaultChapterSlot, isSlotActive, isRepeatable, skeletonSlots, type SlotLayout } from "./structure";
export { composeV2, slotState, expectedChapterKeys, compareChapterKeys } from "./snapshot";
export { mergeSubmission, emptyResolvedDoc, defaultMeta } from "./merge";
export { scopeSha256, stripIds } from "./hash";
export { seededPidAllocator, defaultChapterPid, slotPid, partPid } from "./pids";
export { mapBlock, figureWidthMm, columnProfile, ASIDE_DEFAULT_LABELS, type BlockCtx } from "./blocks";
export { mapInline, mapRun, mapRuns, apparatusInline, apparatusLabelText, glyphSet, DEFAULT_SYMBOL_GLYPHS, type InlineCtx } from "./inline";
export {
  projectContractRecord,
  resolveContractKind,
  reportedAtDisplay,
  type ContractItemBlock,
  type ContractRecordBlock,
  type ContractRecordProjection,
} from "./contract-record";
export { COMPOSE_PARAM_KEYS, composeContextOf, storedComposeContext, type ComposeContextRecord, type ComposedSnapshotV2 } from "./context";
export type {
  ComposeAssetInfo,
  ComposeInput,
  ComposeResult,
  ComposeWarning,
  EmptyDocInput,
  MergeOptions,
  MergeResult,
  SkeletonInput,
  StructureInput,
} from "./types";
