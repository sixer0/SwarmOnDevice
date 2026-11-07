/**
 * JSON Schema 2020-12 `studio.image/v1` (01_specs.md §3.7, §3.10).
 * px_guard (dpi efektif >= dpiMin, 422 DATUM-39) ditegakkan layanan images (I43).
 */
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "./common.schema";
import { DOC_SCHEMA_ID } from "./doc.schema";

export const IMAGE_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.image/v1.json`;

export const imageSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: IMAGE_SCHEMA_ID,
  title: "studio.image/v1",
  type: "object",
  properties: {
    $schema: { const: "studio.image/v1" },
    id: { type: "string", maxLength: 64 },
    title: { type: "string", minLength: 1, maxLength: 300 },
    source: { type: "string", minLength: 1, maxLength: 1000 },
    asset: { $ref: `${DOC_SCHEMA_ID}#/$defs/AssetRef` },
    widthMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
    heightMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
    dpiMin: { enum: [150, 300] },
  },
  required: ["$schema", "title", "source", "asset", "widthMm"],
  additionalProperties: false,
} as const;
