/**
 * JSON Schema 2020-12 `studio.skeleton/v1` (SID05; register 03_structural_sections_specs.md
 * §4.7 T2-57). Kerangka templat mandiri (R19). Badan POST R19 menambah
 * `baseVersionNo`, `changeNote`, `expertMode?` di luar dokumen ini; route
 * memisahkannya sebelum validasi skema.
 */
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "../common.schema";
import { templateV2Ref } from "./template.schema";

export const SKELETON_V1_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.skeleton/v1.json`;

export const skeletonV1Schema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: SKELETON_V1_SCHEMA_ID,
  title: "studio.skeleton/v1",
  type: "object",
  properties: {
    $schema: { const: "studio.skeleton/v1" },
    slots: templateV2Ref("SkeletonSlots"),
  },
  required: ["$schema", "slots"],
  additionalProperties: false,
} as const;
