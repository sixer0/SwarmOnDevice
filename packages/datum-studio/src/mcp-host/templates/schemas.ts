/**
 * Input schemas of the five template tools (row 68): masterplan/01_specs_studio_templates.md §6 as amended by
 * row 79 (U.4 / U.9 row 68: `studio_template_preview.formats` = docx | html | pdf, maxItems 3, default ["pdf"];
 * `png` -> SCHEMA_INVALID naming the supported formats). Names: names register §7.2.
 *
 * `template` (a full `studio.template/v2`), the `changes` maps and the skeleton slots are only shape-checked here
 * (`type: object` / `array`); the row 66 service validates them with Studio's own `studio.template/v2` schema
 * (`parseTemplateV2`) after the §6 limits, so there is one schema authority for the definition.
 * `additionalProperties: false` everywhere a field list is fixed (spec §6 "Paths and assets": no field accepts a
 * path, URL or asset reference).
 */

const userSlug = { type: "string", maxLength: 64, pattern: "^user-[a-z0-9]+(-[a-z0-9]+)*$", description: "Slug templat pengguna (awalan user-)." } as const
const anySlug = { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "Slug templat bawaan atau pengguna." } as const
const versionNo = { type: "integer", minimum: 1, maximum: 1000 } as const
const note = { type: "string", minLength: 1, maxLength: 4000, description: "Catatan perubahan (disimpan dengan versi)." } as const
const name = { type: "string", minLength: 1, maxLength: 200 } as const
const description = { type: "string", maxLength: 2000 } as const
const template = { type: "object", description: "Definisi studio.template/v2 lengkap (divalidasi layanan templat)." } as const
const skeleton = {
  type: "object",
  additionalProperties: false,
  required: ["slots"],
  properties: { slots: { type: "array", minItems: 1, maxItems: 1000, items: { type: "object" } } },
} as const
const changes = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    essentials: { type: "object" },
    advanced: { type: "object" },
    roleFormats: { type: "object" },
    unset: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
  },
} as const

export const PREVIEW_FORMAT_ENUM = ["docx", "html", "pdf"] as const

export const TEMPLATE_TOOL_SCHEMAS = {
  studio_template_create: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "name", "kind", "changeNote"],
    properties: {
      slug: userSlug,
      name,
      kind: { const: "DOCUMENT" },
      description,
      changeNote: note,
      from: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: { slug: anySlug, version: versionNo },
        description: "Salin dari templat bawaan/pengguna (versi bawaan: terbaru).",
      },
      template,
    },
    oneOf: [{ required: ["from"] }, { required: ["template"] }],
  },
  studio_template_update: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "baseVersionNo", "changeNote"],
    properties: {
      slug: userSlug,
      baseVersionNo: versionNo,
      changeNote: note,
      name,
      description,
      template,
      skeleton,
      changes,
    },
    oneOf: [{ required: ["template"] }, { required: ["skeleton"] }, { required: ["changes"] }],
  },
  studio_template_check: {
    type: "object",
    additionalProperties: false,
    properties: {
      template,
      slug: anySlug,
      version: versionNo,
      baseSlug: anySlug,
      baseVersion: versionNo,
      guard: { type: "boolean", default: true },
    },
    oneOf: [{ required: ["template"] }, { required: ["slug"] }],
  },
  studio_template_preview: {
    type: "object",
    additionalProperties: false,
    properties: {
      template,
      slug: anySlug,
      version: versionNo,
      formats: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: [...PREVIEW_FORMAT_ENUM] }, default: ["pdf"] },
      language: { enum: ["ID", "EN"] },
      tier: { enum: ["NOTA", "TERBIT", "SERAH"] },
      lint: { type: "boolean", default: true },
    },
    oneOf: [{ required: ["template"] }, { required: ["slug"] }],
  },
  studio_template_archive: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "archived"],
    properties: { slug: userSlug, archived: { type: "boolean" } },
  },
} as const

export type TemplateToolName = keyof typeof TEMPLATE_TOOL_SCHEMAS

/** The five names, in list order (names register §7.2). */
export const TEMPLATE_TOOL_NAMES = Object.keys(TEMPLATE_TOOL_SCHEMAS) as TemplateToolName[]
