/**
 * JSON Schema 2020-12 `studio.slot/v2` (SID03; register 03_structural_sections_specs.md
 * §4.5 T2-48). Kiriman satu slot tak-berulang (R13). Slot berulang lewat
 * endpoint ini = 422 `SLOT_USE_CHAPTER_ENDPOINT` (layanan); kecocokan
 * `payload.type` dengan sectionType slot = 422 `SLOT_TYPE_MISMATCH`.
 */
import { SLOT_KEY_PATTERN } from "../../env";
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "../common.schema";
import { commonV2Ref, docV1Ref } from "./common.schema";

export const SLOT_V2_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.slot/v2.json`;

export const slotV2Schema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: SLOT_V2_SCHEMA_ID,
  title: "studio.slot/v2",
  type: "object",
  properties: {
    $schema: { const: "studio.slot/v2" },
    agentId: { type: "string", minLength: 1, maxLength: 80 },
    target: commonV2Ref("DocTargetV2"),
    template: docV1Ref("TemplateRef"),
    meta: commonV2Ref("DocMetaV2"),
    slot: { type: "string", pattern: SLOT_KEY_PATTERN },
    payload: commonV2Ref("SlotPayloadV2"),
    register: commonV2Ref("RegisterMapV2"),
    assets: commonV2Ref("AssetMapV2"),
    baseRevisionNo: { type: "integer", minimum: 1 },
    change: commonV2Ref("ChangeV2"),
    // D-247: tanpa `render` (dikirim -> 400 SCHEMA_INVALID checkId RENDER_FIELD, forbidden.ts).
  },
  required: ["$schema", "target", "slot", "payload"],
  additionalProperties: false,
} as const;
