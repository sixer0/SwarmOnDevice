/**
 * Layanan kerangka templat (SR-06; register 03_structural_sections_specs §15 I44).
 *
 * - Murni (`./pure`): kerangka kanonik + sidik, kerangka implisit dari
 *   `sectionPlan`, validasi SKELETON_*, resolusi nilai efektif per slot
 *   (`resolveSlotParams`), izin tulis per kunci berubah dengan aturan per kenop
 *   (`checkTemplateWrite`).
 * - DB (`./repository`): baca/tulis M10-M12, lapis preset + templat, nilai
 *   efektif semua slot satu versi.
 */
export * from "./pure";
export * from "./repository";
export { setSkeletonLogSink, skeletonLog, type SkeletonLogEntry, type SkeletonLogSink } from "./log";
