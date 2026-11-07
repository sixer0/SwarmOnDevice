/**
 * Layanan kelengkapan (SR-11, I48; murni: tanpa DB, tanpa jam sistem).
 *
 * - `computeCompleteness(input)` -> `CompletenessReportV2` lengkap (state slot E29,
 *   kemajuan bab `chapters.<slotKey>` KD-15, status, `missingRequired`, teks).
 * - `completenessTexts(r, ctx)` -> `message`, `nextSteps`, `forwardToController`.
 *
 * Laporan ini juga isi kolom `StudioRevision.completenessReport`, dan `status`-nya
 * = `StudioDocument.completeness`/`StudioRevision.completeness` (register §8.4).
 */
import type { CompletenessReportV2 } from "@/lib/studio/contract";
import { computeStructure } from "./compute";
import { completenessTexts } from "./texts";
import type { CompletenessInput } from "./types";

export function computeCompleteness(input: CompletenessInput): CompletenessReportV2 {
  const structure = computeStructure(input);
  const texts = completenessTexts(structure, input.doc);
  const report: CompletenessReportV2 = { ...structure, nextSteps: texts.nextSteps, message: texts.message };
  if (texts.forwardToController !== undefined) report.forwardToController = texts.forwardToController;
  return report;
}

export { completenessTexts } from "./texts";
export type { CompletenessTexts } from "./texts";
export {
  chapterProgress,
  compareChapterKeys,
  contractRequiredChapterKeys,
  expectedChapterKeys,
  isSlotPayloadFilled,
  slotState,
  slotStateOf,
  type SlotStateInput,
} from "./compute";
export type {
  CompletenessChapterInput,
  CompletenessInput,
  CompletenessSlotInput,
  CompletenessSlotRowInput,
  CompletenessTextContext,
} from "./types";
