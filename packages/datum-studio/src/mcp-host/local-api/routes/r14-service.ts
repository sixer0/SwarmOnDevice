/**
 * Seam ke layanan struktur (SR-22 -> SR-14, register I50):
 * `patchStructure(caller, documentId, body): Promise<StructureResult>`.
 *
 * SR-14 menulis `services/revisions` secara paralel; ekspor dicari saat
 * dipanggil agar route ini terkompilasi sebelum dan sesudah ekspor itu ada.
 * Selama ekspor belum ada, panggilan melempar `StudioNotImplemented`
 * (500 + log MODULE_NOT_IMPLEMENTED). Setelah SR-14 mendarat, seam ini dapat
 * diganti impor langsung tanpa mengubah route.
 *
 * Bentuk hasil = register §12 R14: `{ revision, addressMap?, completeness }`
 * (`StructureResult` internal milik SR-14; di sini hanya medan yang dibaca route).
 *
 * Swarm port (row 31b): clone C/src/app/api/studio/documents/[id]/structure/_lib/service.ts, verbatim apart
 * from the `./patch-body` import path (-> ./r14-patch-body);
 * `services/revisions` is vendored by row 31b, so `patchStructure` now resolves.
 */
import type { CompletenessReportV2 } from "@/lib/studio/contract";
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { StudioNotImplemented } from "@/lib/studio/contract/errors";
import * as revisions from "@/lib/studio/services/revisions";
import type { StructurePatchInput } from "./r14-patch-body";

export interface StructureResultView {
  revision: { revisionNo: number; changeScope?: string | null } & Record<string, unknown>;
  addressMap?: Record<string, string>;
  completeness: CompletenessReportV2;
  [k: string]: unknown;
}

export type PatchStructureFn = (caller: StudioCaller, documentId: string, body: StructurePatchInput) => Promise<StructureResultView>;

const EXPORT_NAME = "patchStructure";
export const PATCH_STRUCTURE_MODULE_ID = "services/revisions.patchStructure (SR-14, I50)";

export function resolvePatchStructure(): PatchStructureFn {
  const fn = (revisions as unknown as Record<string, unknown>)[EXPORT_NAME];
  if (typeof fn !== "function") throw new StudioNotImplemented(PATCH_STRUCTURE_MODULE_ID);
  return fn as PatchStructureFn;
}
