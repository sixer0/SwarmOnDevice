/**
 * JSON Schema 2020-12 `studio.template/v2` (SID04) dan `$defs.TemplateSlotDef`
 * (register 03_structural_sections_specs.md §4.7 T2-56, T2-58; KD-14 `$schema`).
 * Bukan untuk agen: dipakai editor templat dan R01/R02/R19.
 *
 * Skema menegakkan bentuk. Aturan kerangka (posisi kontigu, sectionType ∈ C33,
 * berulang hanya chapter/appendix, mode per sectionType, `admits`) ditegakkan
 * layanan kerangka SR-06 sebagai 400 `SCHEMA_INVALID` ber-`checkId` SKELETON_*
 * (E41); cakupan/lapis/kelas kunci parameter = SR-06/SR-07 (§13.5).
 */
import { CONTENT_BLOCK_TYPES, ROLE_KEYS, STUDIO_SLOT_CONTENT_MODES, STUDIO_TIERS } from "../../enums";
import { SLOT_KEY_PATTERN } from "../../env";
import { commonRef, JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "../common.schema";

export const TEMPLATE_V2_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.template/v2.json`;

/** `$ref` ke `$defs` skema templat v2. */
export function templateV2Ref(def: "TemplateSlotDef" | "ParamValueMap" | "RoleFormatsV2" | "SkeletonSlots"): { $ref: string } {
  return { $ref: `${TEMPLATE_V2_SCHEMA_ID}#/$defs/${def}` };
}

const presetRef = {
  type: "object",
  properties: {
    slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 },
    version: { type: "integer", minimum: 1 },
  },
  required: ["slug"],
  additionalProperties: false,
} as const;

export const templateV2Schema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: TEMPLATE_V2_SCHEMA_ID,
  title: "studio.template/v2",
  type: "object",
  properties: {
    $schema: { const: "studio.template/v2" },
    preset: presetRef,
    essentials: templateV2Ref("ParamValueMap"),
    advanced: templateV2Ref("ParamValueMap"),
    roleFormats: templateV2Ref("RoleFormatsV2"),
    skeleton: {
      type: "object",
      properties: { slots: templateV2Ref("SkeletonSlots") },
      required: ["slots"],
      additionalProperties: false,
    },
  },
  required: ["$schema", "essentials", "skeleton"],
  additionalProperties: false,
  $defs: {
    /** Kunci parameter rinci -> nilai (KD-21); kunci tak dikenal = 422 PARAM_UNKNOWN_KEY (layanan). */
    ParamValueMap: {
      type: "object",
      maxProperties: 1000,
      propertyNames: { minLength: 1, maxLength: 200 },
      additionalProperties: commonRef("ParamValue"),
    },
    /** RoleKey -> `{para?, run?}` (bentuk RoleFormat; isi divalidasi layanan seperti roleFormats templat v1). */
    RoleFormatsV2: {
      type: "object",
      propertyNames: { enum: [...ROLE_KEYS] },
      additionalProperties: { type: "object" },
    },
    SkeletonSlots: { type: "array", minItems: 1, maxItems: 32, items: templateV2Ref("TemplateSlotDef") },
    TemplateSlotDef: {
      type: "object",
      properties: {
        slotKey: { type: "string", pattern: SLOT_KEY_PATTERN },
        sectionType: { type: "string", pattern: "^[a-z][a-zA-Z0-9]{0,63}$" },
        label: { type: "string", minLength: 1, maxLength: 120 },
        position: { type: "integer", minimum: 1, maximum: 32 },
        required: { type: "boolean" },
        positionLocked: { type: "boolean" },
        repeatable: { type: "boolean" },
        minItems: { type: "integer", minimum: 0, maximum: 999 },
        maxItems: { type: "integer", minimum: 1, maximum: 999 },
        contentMode: { enum: [...STUDIO_SLOT_CONTENT_MODES] },
        tiers: { type: "array", uniqueItems: true, items: { enum: [...STUDIO_TIERS] } },
        admits: { type: "array", uniqueItems: true, items: { enum: [...CONTENT_BLOCK_TYPES] } },
        essentials: templateV2Ref("ParamValueMap"),
        advanced: templateV2Ref("ParamValueMap"),
        roleFormats: templateV2Ref("RoleFormatsV2"),
      },
      required: [
        "slotKey",
        "sectionType",
        "label",
        "position",
        "required",
        "positionLocked",
        "repeatable",
        "contentMode",
        "tiers",
        "admits",
        "essentials",
      ],
      additionalProperties: false,
    },
  },
} as const;
