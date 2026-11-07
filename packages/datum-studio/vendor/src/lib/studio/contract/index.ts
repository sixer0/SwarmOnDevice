/**
 * Re-ekspor publik kontrak Doc Artifact Studio (01_specs.md §12.1 T08).
 *
 * Aman untuk klien dan server. Modul KHUSUS SERVER tidak diekspor nilainya di
 * sini dan diimpor langsung dari path-nya:
 *   - `@/lib/studio/contract/auth`     (getStudioCaller; next-auth + node:crypto)
 *   - `@/lib/studio/contract/dispatch` (peta renderer; mengimpor modul mesin)
 * `getStudioEnv` (env.ts) boleh diimpor dari sini tetapi hanya bermakna di server.
 *
 * Kontrak read-only setelah marker implementation/01_contract_landed.md ada;
 * perubahan lewat delegation_progress/file_requests.md.
 */
export * from "./enums";
export * from "./types/common";
export * from "./types/doc";
export * from "./types/chart";
export * from "./types/diagram";
export * from "./types/image";
export * from "./types/html";
export * from "./types/model";
export * from "./types/params";
export * from "./types/api";
export * from "./engine";
export * from "./address";
export * from "./env";
export * from "./errors";
export * from "./render-env";
export * from "./ui";
export * from "./schema/common.schema";
export * from "./schema/doc.schema";
export * from "./schema/chart.schema";
export * from "./schema/diagram.schema";
export * from "./schema/image.schema";
export * from "./schema/html.schema";
// Delta SR-04 (aditif): kontrak struktur v2 (register 03_structural_sections_specs.md §4-§5).
export * from "./types/v2";
export * from "./schema/v2/common.schema";
export * from "./schema/v2/doc.schema";
export * from "./schema/v2/chapter.schema";
export * from "./schema/v2/slot.schema";
export * from "./schema/v2/template.schema";
export * from "./schema/v2/skeleton.schema";
export * from "./schema/v2/forbidden";
export * from "./schema/v2/figure-text";
export type { StudioCaller } from "./auth";

import { chartSchema } from "./schema/chart.schema";
import { commonSchema } from "./schema/common.schema";
import { diagramSchema } from "./schema/diagram.schema";
import { docSchema } from "./schema/doc.schema";
import { htmlSchema } from "./schema/html.schema";
import { imageSchema } from "./schema/image.schema";
import { chapterV2Schema } from "./schema/v2/chapter.schema";
import { commonV2Schema } from "./schema/v2/common.schema";
import { docV2Schema } from "./schema/v2/doc.schema";
import { skeletonV1Schema } from "./schema/v2/skeleton.schema";
import { slotV2Schema } from "./schema/v2/slot.schema";
import { templateV2Schema } from "./schema/v2/template.schema";
import type { StudioSchemaId } from "./env";

/** Dokumen JSON Schema per id skema §3 (dipublikasikan R03 `?kind=schema`). */
export const STUDIO_JSON_SCHEMAS = {
  "studio.doc/v1": docSchema,
  "studio.chart/v1": chartSchema,
  "studio.diagram/v1": diagramSchema,
  "studio.image/v1": imageSchema,
  "studio.html/v1": htmlSchema,
  // Delta SR-04: SID01-SID05 (SID06 norm/v2 internal, tidak dipublikasikan).
  "studio.doc/v2": docV2Schema,
  "studio.chapter/v2": chapterV2Schema,
  "studio.slot/v2": slotV2Schema,
  "studio.template/v2": templateV2Schema,
  "studio.skeleton/v1": skeletonV1Schema,
} as const satisfies Record<StudioSchemaId, unknown>;

/**
 * Urutan `addSchema` ajv: common lebih dulu, lalu skema yang dirujuk sebelum
 * perujuknya. Opsi ajv wajib: `{ strict: true, allErrors: true, discriminator: true, allowUnionTypes: true }`.
 */
export const STUDIO_SCHEMA_LOAD_ORDER = [
  commonSchema,
  diagramSchema,
  chartSchema,
  docSchema,
  imageSchema,
  htmlSchema,
  // Delta SR-04: common/v2 merujuk $defs doc/v1 dan diagram/v1; template/v2 sebelum skeleton/v1.
  commonV2Schema,
  docV2Schema,
  chapterV2Schema,
  slotV2Schema,
  templateV2Schema,
  skeletonV1Schema,
] as const;

export const STUDIO_AJV_OPTIONS = { strict: true, allErrors: true, discriminator: true, allowUnionTypes: true } as const;
