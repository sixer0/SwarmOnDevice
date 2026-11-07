/**
 * Seam ke layanan render lingkup SR-15 (I51, register §15):
 * `renderScope(caller, documentId, req): Promise<RenderScopeResult>`.
 *
 * SR-15 berjalan paralel dengan SR-24; ekspor `renderScope` di
 * `@/lib/studio/services/render` mungkin belum ada saat route ini mendarat.
 * Seam membaca ekspor secara dinamis agar tsc tetap hijau; bila belum ada,
 * route menjawab 500 `MODULE_NOT_IMPLEMENTED` (lewat `StudioNotImplemented`,
 * tercatat di log JSONL). Setelah SR-15 mendarat, seam otomatis memakai
 * implementasi nyata; ganti dengan impor langsung bila tipe SR-15 sudah final.
 *
 * Berkas khusus server (menarik Prisma lewat services/render).
 *
 * FIX-HR2 (D-332 C1): `assertRenderTarget` (baca DB kedua yang menyalin pencarian
 * `prepareScopeRender`) dihapus bersama gerbang PDF di route; 404 kini selalu
 * datang dari `renderScope`.
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/render/_lib/service.ts, verbatim apart
 * from the `./handler` import path (-> ./r17-handler).
 * services/render is vendored by row 31c, so `renderScope` resolves (no 500 MODULE_NOT_IMPLEMENTED).
 */
import * as renderService from "@/lib/studio/services/render";
import type { RenderScopeFn } from "./r17-handler";

export function resolveRenderScope(): RenderScopeFn | null {
  const fn = (renderService as unknown as Record<string, unknown>).renderScope;
  return typeof fn === "function" ? (fn as RenderScopeFn) : null;
}

