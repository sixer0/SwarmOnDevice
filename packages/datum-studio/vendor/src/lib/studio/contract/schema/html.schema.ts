/**
 * JSON Schema 2020-12 `studio.html/v1` (01_specs.md §3.8, §3.10, KT-11).
 * Tidak ada medan HTML/CSS/JS mentah; HTML hanya dari templat.
 */
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "./common.schema";
import { DOC_SCHEMA_ID } from "./doc.schema";

export const HTML_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.html/v1.json`;

const id = { type: "string", minLength: 1, maxLength: 64 } as const;

export const htmlSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: HTML_SCHEMA_ID,
  title: "studio.html/v1",
  type: "object",
  properties: {
    $schema: { const: "studio.html/v1" },
    template: { $ref: `${DOC_SCHEMA_ID}#/$defs/TemplateRef` },
    source: {
      type: "object",
      properties: { kind: { type: "string" } },
      required: ["kind"],
      discriminator: { propertyName: "kind" },
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "document" }, documentId: id, revisionNo: { type: "integer", minimum: 1 } },
          required: ["kind", "documentId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "artifact" }, artifactId: id },
          required: ["kind", "artifactId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "inline" }, document: { $ref: DOC_SCHEMA_ID } },
          required: ["kind", "document"],
          additionalProperties: false,
        },
      ],
    },
    options: {
      type: "object",
      properties: {
        paged: { type: "boolean" },
        embedFonts: { const: true },
        previewLabel: { type: "boolean" },
      },
      required: ["paged", "embedFonts"],
      additionalProperties: false,
    },
  },
  required: ["$schema", "template", "source"],
  additionalProperties: false,
} as const;
