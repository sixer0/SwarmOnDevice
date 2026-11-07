/**
 * JSON Schema 2020-12 `studio.doc/v2` (SID01; register 03_structural_sections_specs.md
 * §4.1, §4.5 T2-46). Dokumen konten murni: `sections` absen = dokumen kosong
 * berkerangka (§7, D-153). Aturan struktur (slot dikenal, wajib, urutan,
 * tier, `admits`, kunci bab) ditegakkan layanan compose (422), bukan skema.
 */
import { DOC_KEY_PATTERN, SLOT_KEY_PATTERN } from "../../env";
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "../common.schema";
import { commonV2Ref, docV1Ref } from "./common.schema";

export const DOC_V2_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.doc/v2.json`;

export const docV2Schema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: DOC_V2_SCHEMA_ID,
  title: "studio.doc/v2",
  type: "object",
  properties: {
    $schema: { const: "studio.doc/v2" },
    agentId: { type: "string", minLength: 1, maxLength: 80 },
    template: docV1Ref("TemplateRef"),
    mission: docV1Ref("MissionRef"),
    docKey: { type: "string", pattern: DOC_KEY_PATTERN, maxLength: 64 },
    meta: {
      type: "object",
      allOf: [commonV2Ref("DocMetaV2"), { properties: { title: true }, required: ["title"] }],
    },
    structure: {
      type: "object",
      properties: {
        // Duplikat bukan galat skema: layanan menjawab 422 SLOT_DUPLICATE.
        order: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: SLOT_KEY_PATTERN } },
      },
      required: ["order"],
      additionalProperties: false,
    },
    sections: {
      type: "object",
      maxProperties: 32,
      propertyNames: { pattern: SLOT_KEY_PATTERN },
      additionalProperties: commonV2Ref("DocSectionPayloadV2"),
    },
    register: commonV2Ref("RegisterMapV2"),
    assets: commonV2Ref("AssetMapV2"),
    x: { type: "object" },
    change: commonV2Ref("ChangeV2"),
    // D-247: tanpa `render` (dikirim -> 400 SCHEMA_INVALID checkId RENDER_FIELD, forbidden.ts).
  },
  required: ["$schema", "template", "meta"],
  additionalProperties: false,
} as const;
